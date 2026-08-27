import type { networkInterfaces } from "node:os";

/** `os.networkInterfaces()` の戻り値。テストから固定値を渡せるよう型だけ借りる */
export type NetworkInterfaces = ReturnType<typeof networkInterfaces>;

/**
 * NIC一覧から、会場LANで参加者が到達できるIPv4アドレスを優先度順に返す。
 *
 * QRに入れるURLのホストになる値。`window.location.hostname` では代用できない
 * (発表者が localhost で開いていると、参加者の端末で自分自身を指してしまう)。
 *
 * 純関数にしてあるのは、NICの構成に依存せずテストするため。実際の列挙は呼び出し側で行う。
 */
export function pickLanAddresses(nics: NetworkInterfaces): string[] {
  const found: string[] = [];
  for (const addrs of Object.values(nics)) {
    for (const a of addrs ?? []) {
      // family は Node 18+ で "IPv4"、Bunの一部バージョンで数値の 4 を返すため両方見る
      const isV4 = a.family === "IPv4" || (a.family as unknown as number) === 4;
      if (!isV4 || a.internal) continue;
      // リンクローカル(DHCPが取れなかったときの自己割当)は他端末から到達できない
      if (a.address.startsWith("169.254.")) continue;
      if (!found.includes(a.address)) found.push(a.address);
    }
  }
  return found.sort((x, y) => rank(x) - rank(y));
}

/**
 * 会場Wi-Fiらしさの順位。小さいほど優先。
 * 172.16-31 は私用アドレスだが、Docker・WSL2・Hyper-V の仮想NICがこの範囲を使うため後ろへ置く。
 */
function rank(ip: string): number {
  if (ip.startsWith("192.168.")) return 0;
  if (ip.startsWith("10.")) return 1;
  return 2;
}

/**
 * 参加者が開くURLの候補。先頭が既定で、発表者画面はこれをQRに入れる。
 *
 * `publicOrigin`(本番デモ用の実在ドメイン。#23)を渡すとそれを先頭に置く。
 * Let's Encrypt の証明書はドメインにしか効かないため、LAN IPのURLで開くと
 * 警告が出てしまう。QRにはドメインが入っている必要がある。
 *
 * それでもLAN IPの候補を消さないのは意図的で、会場のDNSが
 * プライベートIPへの応答を捨てる場合(DNSリバインディング保護)に、
 * 発表者が候補を選び直して「警告は出るがつながる」状態へ退避できるようにするため。
 * 選び直しの口は `useJoinUrl` の candidates / select が既に持っている。
 */
export function buildJoinUrls(
  nics: NetworkInterfaces,
  scheme: string,
  port: number,
  publicOrigin?: string,
): string[] {
  const lan = pickLanAddresses(nics).map((ip) => `${scheme}://${ip}:${port}/`);
  const publicUrl = normalizePublicOrigin(publicOrigin);
  return publicUrl === null ? lan : [publicUrl, ...lan];
}

/**
 * 設定されたオリジンを参加URLの形(末尾 `/`)に整える。使えない値なら null。
 *
 * 環境変数から来るので、書き間違いをそのままQRに載せない。空文字・相対パス・
 * http(s)以外を弾く考え方は `apps/web/src/lib/joinInfo.ts` の isHttpUrl と揃えてある。
 */
function normalizePublicOrigin(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // パス・クエリ・ハッシュは参加URLには要らない。オリジンだけ取り出す
    return `${url.origin}/`;
  } catch {
    return null; // URLとして読めない
  }
}
