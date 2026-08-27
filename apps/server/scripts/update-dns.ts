#!/usr/bin/env bun
// 会場に着いたら最初に叩くもの(#23)。
//
// 本番デモは「実在ドメイン → 会場のLAN IP」で成立する。証明書はドメインに対して
// 出るのでIPが変わっても取り直しは要らないが、Aレコードだけは会場で書き換える必要がある。
// 手作業でCloudflareの管理画面を開くと焦って間違えるので、1コマンドで済ませる。
//
// 使い方:
//   CF_API_TOKEN=... CF_ZONE_ID=... CF_RECORD_NAME=llm.example.com bun run dns
//   CF_API_TOKEN=... CF_ZONE_ID=... CF_RECORD_NAME=llm.example.com bun run dns 10.0.5.22
//
// 引数でIPを渡せるのは、検出結果が意図と違うとき(仮想NICが複数ある等)に
// その場で上書きするため。省略すると pickLanAddresses の先頭を使う。
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { isUsableLanIpv4, pickLanAddresses } from "../src/lanAddress";
import { pickTlsFiles } from "../src/tlsConfig";

const API = "https://api.cloudflare.com/client/v4";

/** 設定が足りなければ、何が足りないかを全部挙げてから止まる(1つずつ怒られない) */
function readConfig(): { token: string; zoneId: string; recordName: string } {
  const token = process.env.CF_API_TOKEN ?? "";
  const zoneId = process.env.CF_ZONE_ID ?? "";
  const recordName = process.env.CF_RECORD_NAME ?? "";

  const missing = [
    token === "" ? "CF_API_TOKEN(Zone:DNS:Edit 権限のトークン)" : null,
    zoneId === "" ? "CF_ZONE_ID(Cloudflareのゾーン概要ページに出ている値)" : null,
    recordName === "" ? "CF_RECORD_NAME(例: llm.example.com)" : null,
  ].filter((x): x is string => x !== null);

  if (missing.length > 0) {
    console.error("次の環境変数が設定されていません:");
    for (const m of missing) console.error(`  - ${m}`);
    console.error("\n例:");
    console.error(
      "  CF_API_TOKEN=xxx CF_ZONE_ID=yyy CF_RECORD_NAME=llm.example.com bun run dns",
    );
    process.exit(1);
  }
  return { token, zoneId, recordName };
}

/** Cloudflare APIは200でも success:false を返すので、そこまで見て初めて成功とする */
async function callCloudflare(
  path: string,
  token: string,
  init?: { method: string; body: string },
): Promise<{ result: unknown }> {
  const res = await fetch(`${API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: init?.body,
  });

  const json = (await res.json()) as {
    success?: boolean;
    errors?: { code?: number; message?: string }[];
    result?: unknown;
  };

  if (!res.ok || json.success !== true) {
    const detail = (json.errors ?? [])
      .map((e) => `${e.code ?? "?"}: ${e.message ?? "(詳細なし)"}`)
      .join(" / ");
    console.error(`Cloudflare APIが失敗しました (HTTP ${res.status})`);
    if (detail !== "") console.error(`  ${detail}`);
    if (res.status === 403) {
      console.error("  トークンに Zone:DNS:Edit 権限があるか、ゾーンIDが合っているか確認してください");
    }
    process.exit(1);
  }
  return { result: json.result };
}

const { token, zoneId, recordName } = readConfig();

// --- 書き込むIPを決める ---
const argIp = process.argv[2];
if (argIp !== undefined && !isUsableLanIpv4(argIp)) {
  // 書式だけでなく、ループバックやリンクローカルなど宛先として使えない範囲も弾く。
  // 通してしまうと「更新成功」と出るのに参加者から繋がらず、原因が分からなくなる
  console.error(`参加者から到達できるIPv4アドレスではありません: ${argIp}`);
  console.error("(ループバック・リンクローカル・マルチキャスト等は指定できません)");
  process.exit(1);
}

const detected = pickLanAddresses(networkInterfaces());
if (argIp === undefined && detected.length === 0) {
  console.error("会場LANのIPv4アドレスが見つかりません。Wi-Fiに接続しているか確認してください。");
  console.error("(意図したアドレスがあるなら引数で渡せます: bun run dns 10.0.5.22)");
  process.exit(1);
}

const ip = argIp ?? detected[0]!;
if (argIp === undefined && detected.length > 1) {
  console.log(`検出したアドレス: ${detected.join(", ")}`);
  console.log(`先頭の ${ip} を使います(違う場合は引数で指定してください)`);
}

// --- 対象のAレコードを探す ---
const listPath = `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(recordName)}`;
const { result: found } = await callCloudflare(listPath, token);
type ARecord = { id?: string; content?: string; proxied?: boolean };
const records = Array.isArray(found) ? (found as ARecord[]) : [];

if (records.length === 0) {
  console.error(`Aレコードが見つかりません: ${recordName}`);
  console.error("Cloudflareの管理画面で先に1件作っておいてください(DNS only / 灰色の雲)。");
  process.exit(1);
}
// 同じ名前に複数のAレコードがあると、1件だけ書き換えても古いIPが返り続ける。
// どれを直すべきか機械的には決められないので、勝手に選ばず止める
if (records.length > 1) {
  console.error(`Aレコードが ${records.length} 件あります: ${recordName}`);
  for (const r of records) {
    console.error(`  - ${r.content ?? "(不明)"}${r.proxied === true ? " (プロキシ有効)" : ""}`);
  }
  console.error("1件だけ残して、他はCloudflareの管理画面で削除してください。");
  console.error("複数あると、更新しても古いIPが参加者に返ることがあります。");
  process.exit(1);
}
const record = records[0]!;
if (record.id === undefined) {
  console.error("Cloudflareの応答にレコードIDがありません。");
  process.exit(1);
}

// プロキシが有効なままだと、IPが合っていても参加者は会場LANのHonoに届かない。
// 「IPが合っている」だけで満足せず、プロキシまで見てから終わる
if (record.content === ip && record.proxied === false) {
  console.log(`${recordName} は既に ${ip} を指しています(DNS only)。更新は不要です。`);
  process.exit(0);
}
if (record.content === ip && record.proxied !== false) {
  console.log(`${recordName} のIPは合っていますが、プロキシが有効です。DNS only に直します。`);
}

// --- 書き換える ---
// proxied: false を必ず明示する。プロキシ(橙色の雲)にするとCloudflareのエッジ経由に
// なり、プライベートIPを返せず、通信も会場LANから出てしまう(AGENTS.md 前提2違反)
const body = JSON.stringify({
  type: "A",
  name: recordName,
  content: ip,
  ttl: 60, // 会場で書き換えた直後に引けるよう最短にする
  proxied: false,
});
const { result: updated } = await callCloudflare(
  `/zones/${zoneId}/dns_records/${record.id}`,
  token,
  { method: "PUT", body },
);

// 書けたつもりで進まないよう、応答を突き合わせてから成功と言う
const after = (updated as ARecord | null) ?? {};
if (after.content !== ip) {
  console.error(`更新後のIPが一致しません: 期待 ${ip} / 実際 ${after.content ?? "(不明)"}`);
  console.error("Cloudflareの管理画面で確認してください。");
  process.exit(1);
}
if (after.proxied !== false) {
  console.error("更新後もプロキシが有効です。DNS only(灰色の雲)に変更してください。");
  console.error("プロキシのままだと参加者は会場LANのHonoに届きません。");
  process.exit(1);
}
console.log(`更新しました: ${recordName} ${record.content ?? "(不明)"} → ${after.content} (DNS only)`);

// 案内するURLは、Honoが実際に使う設定から組み立てる。ここを決め打ちにすると
// 証明書が無い(HTTP起動)場合などに、開くはずのないURLを案内してしまう
const tls = pickTlsFiles(existsSync, process.env);
const scheme = tls !== null ? "https" : "http";
const serverPort = Number(process.env.PORT ?? (tls !== null ? 8443 : 3000));
const origin = `${scheme}://${recordName}:${serverPort}`;

console.log("\n次にやること:");
console.log(`  1. 参加者の端末で ${origin}/ が開けるか試す`);
console.log("  2. 開けたら Hono を起動する(bun run dev)");
console.log("  3. 開けなければDNSリバインディング保護に当たっている可能性があります。");
console.log("     その場合は発表者画面のQRをLAN IPの候補に切り替えて進めてください");

if (tls === null) {
  console.warn("\n警告: 証明書が見つかりません(HTTPで起動します)。");
  console.warn("  参加者のブラウザが secure context にならず、SharedArrayBuffer と");
  console.warn("  WebGPU が使えないため、この状態では推論が成立しません。");
  console.warn("  certs/prod/ に本番用の証明書を置くか、bun run cert を実行してください。");
}
