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
import { networkInterfaces } from "node:os";
import { pickLanAddresses } from "../src/lanAddress";

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

/** IPv4かどうか。引数で渡された値をそのままCloudflareに送らないための入口検査 */
function isIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
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
if (argIp !== undefined && !isIpv4(argIp)) {
  console.error(`IPv4アドレスとして読めません: ${argIp}`);
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
const records = Array.isArray(found) ? (found as { id?: string; content?: string }[]) : [];

if (records.length === 0) {
  console.error(`Aレコードが見つかりません: ${recordName}`);
  console.error("Cloudflareの管理画面で先に1件作っておいてください(DNS only / 灰色の雲)。");
  process.exit(1);
}
const record = records[0]!;
if (record.id === undefined) {
  console.error("Cloudflareの応答にレコードIDがありません。");
  process.exit(1);
}

if (record.content === ip) {
  console.log(`${recordName} は既に ${ip} を指しています。更新は不要です。`);
  process.exit(0);
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

const after = (updated as { content?: string; proxied?: boolean } | null) ?? {};
console.log(`更新しました: ${recordName} ${record.content ?? "(不明)"} → ${after.content ?? ip}`);
if (after.proxied === true) {
  console.error("警告: プロキシが有効になっています。DNS only(灰色の雲)に変更してください。");
  process.exit(1);
}

console.log("\n次にやること:");
console.log(`  1. 参加者の端末(会場Wi-Fi)で https://${recordName}:8443/ が開けるか試す`);
console.log(`  2. 開けたら PUBLIC_ORIGIN=https://${recordName}:8443 を付けてHonoを起動する`);
console.log("  3. 開けなければDNSリバインディング保護に当たっている可能性があります。");
console.log("     その場合は発表者画面のQRをLAN IPの候補に切り替えて進めてください");
