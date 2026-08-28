// 会場LAN内TURN(coturn)の設定をIPの変更に追随させる。
//
// 会場のLAN IPは自宅と違うだけでなく、**同じ会場でも再接続で変わる**。変わると
// 直す場所が4つある(Aレコード / turnserver.conf / .env.local / Webのビルド)。
// 当日に手作業で4箇所直すのは事故のもとなので `bun run venue` にまとめ、
// その書き換え部分をここに置く。
//
// **文字列を受け取って文字列を返す純関数だけ**にしてあるのは、実ファイルを触らずに
// 「他の行を壊していないか」をテストするため(`tlsConfig.ts` と同じ方針)。
// ファイルの読み書きは `scripts/venue.ts` 側の仕事。
//
// 書き換えではなく生成にしないのは、**credentialを保つ必要がある**ため。
// 作り直すとパスワードが変わり、turnserver.conf と .env.local の対応が崩れる。

/** 書き換え対象の行が見つからないなど、想定外のファイルを渡された */
export class TurnConfigError extends Error {}

/** TURNの待受ポート。coturnの既定値で、変える理由が今のところない */
export const TURN_PORT = 3478;

/** turnserver.conf の場所の候補。上から順に探す */
export const TURN_CONF_CANDIDATES = [
  "/opt/homebrew/etc/turnserver.conf", // Homebrew (Apple Silicon)
  "/usr/local/etc/turnserver.conf", // Homebrew (Intel)
  "/etc/turnserver.conf", // Linux
] as const;

/**
 * turnserver.conf の場所を決める。見つからなければ null。
 *
 * 優先順位:
 *   1. TURN_CONF … 明示指定。置き場所を変えたいときや、Linuxの別配置に合わせるとき
 *   2. TURN_CONF_CANDIDATES を上から
 *
 * `pickTlsFiles` と同じ「envが最優先、無ければ既定の場所を順に」の形にしてある。
 */
export function findTurnConfPath(
  exists: (path: string) => boolean,
  env: Record<string, string | undefined>,
): string | null {
  const override = env.TURN_CONF;
  if (override !== undefined && override.trim() !== "" && exists(override)) return override;
  for (const candidate of TURN_CONF_CANDIDATES) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * `key=value` 形式の1行を差し替える。対象が無ければ null(呼び出し側でまとめて報告する)。
 *
 * 行頭の空白は許すが、コメント行(`#`)は対象にしない。コメントで例示している
 * `# listening-ip=...` を書き換えてしまうと、実際の設定は古いままになる。
 */
function replaceLine(text: string, key: string, value: string): string | null {
  const pattern = new RegExp(`^([ \\t]*)${key}[ \\t]*=.*$`, "m");
  if (!pattern.test(text)) return null;
  return text.replace(pattern, `$1${key}=${value}`);
}

/**
 * turnserver.conf の `listening-ip` / `relay-ip` を新しいIPへ差し替える。
 *
 * **他の行は一切触らない。** 特に `user=dip:<パスワード>` と `realm=` は
 * `.env.local` と対で揃っている必要があるので、書き換えの巻き添えにしない。
 *
 * 対象行が無い場合は追記せずエラーにする。coturnの設定ファイルでないものを
 * 渡された可能性があり、追記すると壊れたファイルができあがるため。
 */
export function replaceTurnIps(conf: string, ip: string): string {
  const missing: string[] = [];
  let next = conf;

  for (const key of ["listening-ip", "relay-ip"]) {
    const replaced = replaceLine(next, key, ip);
    if (replaced === null) missing.push(key);
    else next = replaced;
  }

  if (missing.length > 0) {
    throw new TurnConfigError(
      `turnserver.conf に次の行が見つかりません: ${missing.join(", ")}。` +
        "coturnの設定ファイルか確認してください(docs/coturn-setup-steps.md に雛形があります)。",
    );
  }
  return next;
}

/**
 * TURNのURLを組む。**udp と tcp の両方を必ず出す。**
 *
 * tcpを落とすと、UDPが遮断されたLANで中継できなくなる。参加者からHono(TCP)へは
 * 到達できている実績があるので、TCPのTURNが最後の砦になる。
 */
export function buildTurnUrls(ip: string, port: number = TURN_PORT): string {
  return `turn:${ip}:${port}?transport=udp,turn:${ip}:${port}?transport=tcp`;
}

/**
 * `.env.local` の `VITE_TURN_URLS` だけを新しいIPへ差し替える。
 *
 * **`VITE_TURN_USERNAME` / `VITE_TURN_CREDENTIAL` / `VITE_FORCE_RELAY` は保つ。**
 * credentialは turnserver.conf の `user=` と対なので、ここで作り直すと認証が通らなくなる。
 */
export function replaceTurnUrls(env: string, ip: string, port: number = TURN_PORT): string {
  const replaced = replaceLine(env, "VITE_TURN_URLS", buildTurnUrls(ip, port));
  if (replaced === null) {
    throw new TurnConfigError(
      "apps/web/.env.local に VITE_TURN_URLS の行が見つかりません。" +
        "apps/web/.env.example をコピーして作り直してください。",
    );
  }
  return replaced;
}
