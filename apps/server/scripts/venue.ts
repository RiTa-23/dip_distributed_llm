#!/usr/bin/env bun
// 会場に着いたら / ネットワークが変わったら、これ1つ叩けば揃う。
//
// 会場のLAN IPは自宅と違うだけでなく、**同じ会場でも再接続で変わる**。変わると
// 直す場所が4つあり、当日に手作業で回すのは事故のもと。
//
//   1. Cloudflare Aレコード      … ドメイン → 新IP
//   2. turnserver.conf           … listening-ip / relay-ip
//   3. apps/web/.env.local       … VITE_TURN_URLS
//   4. **Webのビルド**            … VITE_* はビルド時に焼き込まれる
//
// 4が特に危険で、`.env.local` を直しただけでは反映されない。実際に
// 「古いビルドが配信されていて設定が効かない」事故が起きている。
// **最後に焼き込みを検証する**のはそのため。
//
// 使い方:
//   bun run venue             … IPは自動検出
//   bun run venue 10.0.5.22   … 明示指定(仮想NICが複数あるとき)
//
// 環境ごとに使わない要素は黙って飛ばす(Cloudflareのトークンを持つのはドメインの
// 持ち主だけ、coturnを入れていないメンバーもいる)。飛ばしたことは必ず表示する。
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { hasAnyCloudflareConfig, resolveVenueIp, updateDnsRecord } from "./update-dns";
import { findTurnConfPath, replaceTurnIps, replaceTurnUrls, TurnConfigError } from "../src/turnConfig";

/** `.env.local` の場所。apps/server から見た相対 */
const WEB_ENV_LOCAL = "../web/.env.local";

/** coturnのpidファイル。`/var/run` に書けないと coturn がここへ落とす */
const TURN_PID_CANDIDATES = ["/var/run/turnserver.pid", "/var/tmp/turnserver.pid"];

/** 実行した手順の記録。最後にまとめて出す */
const done: string[] = [];
const skipped: string[] = [];

function step(n: number, label: string): void {
  console.log(`\n[${n}/5] ${label}`);
}

// --- IPを決める ---------------------------------------------------------
const ip = resolveVenueIp(process.argv[2], "bun run venue 10.0.5.22");
console.log(`会場のLAN IP: ${ip}`);

// --- 1. Cloudflare Aレコード --------------------------------------------
step(1, "Cloudflare Aレコード");
if (hasAnyCloudflareConfig()) {
  await updateDnsRecord(ip);
  done.push("Aレコード");
} else {
  console.log("  CF_* が未設定のためスキップします(ドメインの持ち主だけが設定します)。");
  skipped.push("Aレコード");
}

// --- 2. turnserver.conf --------------------------------------------------
step(2, "turnserver.conf");
const turnConf = findTurnConfPath(existsSync, process.env);
/** 設定を書き換えたか。書き換えていなければ coturn の再起動は要らない */
let turnConfChanged = false;
if (turnConf === null) {
  console.log("  turnserver.conf が見つからないためスキップします(coturn未導入)。");
  skipped.push("turnserver.conf");
} else {
  try {
    const before = readFileSync(turnConf, "utf8");
    const after = replaceTurnIps(before, ip);
    if (after === before) {
      console.log(`  既に ${ip} です: ${turnConf}`);
    } else {
      turnConfChanged = true;
      writeFileSync(turnConf, after);
      // credentialを含むので権限を戻す(writeFileSync は既存の権限を保つが、念のため)
      chmodSync(turnConf, 0o600);
      console.log(`  更新しました: ${turnConf}`);
    }
    done.push("turnserver.conf");
  } catch (e: unknown) {
    console.error(`  失敗: ${e instanceof TurnConfigError ? e.message : String(e)}`);
    process.exit(1);
  }
}

// --- 3. apps/web/.env.local ---------------------------------------------
step(3, "apps/web/.env.local");
if (!existsSync(WEB_ENV_LOCAL)) {
  console.log("  .env.local が無いためスキップします(TURNを使わない構成)。");
  skipped.push(".env.local");
} else {
  try {
    const before = readFileSync(WEB_ENV_LOCAL, "utf8");
    const after = replaceTurnUrls(before, ip);
    if (after === before) {
      console.log(`  既に ${ip} です`);
    } else {
      writeFileSync(WEB_ENV_LOCAL, after);
      console.log("  更新しました(credentialは保持)");
    }
    done.push(".env.local");
  } catch (e: unknown) {
    console.error(`  失敗: ${e instanceof TurnConfigError ? e.message : String(e)}`);
    process.exit(1);
  }
}

// --- 4. coturn の再起動 --------------------------------------------------
// 設定を書き換えても、動いているプロセスは古いIPで待受したまま。
// **新IPで待受できたことを確認してから成功と言う。**
step(4, "coturn の再起動");
if (turnConf === null) {
  console.log("  coturn未導入のためスキップします。");
} else {
  const running = await findTurnPid();
  if (running === null) {
    console.log("  動いていないためスキップします。起動するには:");
    console.log(`    nohup turnserver -c ${turnConf} > /tmp/coturn.log 2>&1 &`);
    skipped.push("coturn再起動");
  } else if (!turnConfChanged && (await isListeningOn(ip))) {
    // 設定が変わっておらず、既に正しいIPで待受しているなら触らない。
    // **毎回落とすと、開発中やデモ中に中継が無駄に切れる。**
    console.log(`  既に ${ip}:3478 で待受しています。再起動は不要です。`);
    skipped.push("coturn再起動");
  } else {
    console.log(`  停止します (PID ${running})`);
    process.kill(running, "SIGTERM");
    await sleep(1500);
    // 手動起動(docs/coturn-setup-steps.md)と同じ形にする。nohup と & の扱いを
    // シェルに任せておけば、このスクリプトが終わっても coturn は残る
    Bun.spawnSync([
      "sh",
      "-c",
      `nohup turnserver -c ${JSON.stringify(turnConf)} >> /tmp/coturn.log 2>&1 &`,
    ]);
    await sleep(2500);
    if (await isListeningOn(ip)) {
      console.log(`  ✅ ${ip}:3478 で待受を確認しました`);
      done.push("coturn再起動");
    } else {
      console.error(`  ❌ ${ip}:3478 で待受していません。/tmp/coturn.log を確認してください。`);
      process.exit(1);
    }
  }
}

// --- 5. Webのビルド ------------------------------------------------------
// **ここを飛ばすと、設定を直しても効かない。** VITE_* はビルド時に焼き込まれる。
step(5, "Webのビルド(VITE_* の焼き直し)");
const build = Bun.spawnSync(["bun", "run", "web:copy"], { stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) {
  console.error("  ビルドに失敗しました。");
  process.exit(1);
}
done.push("ビルド");

// --- 検証: 焼き込めたか --------------------------------------------------
// 「設定したのに効かない」を最後に潰す。ここまで見て初めて完了と言う。
if (existsSync(WEB_ENV_LOCAL)) {
  const bundled = await bundleContainsTurnIp(ip);
  if (bundled) {
    console.log(`\n✅ 配信物に turn:${ip}:3478 が焼き込まれています`);
  } else {
    console.error(`\n❌ 配信物に turn:${ip}:3478 が見つかりません。`);
    console.error("   .env.local が読まれていない可能性があります。");
    process.exit(1);
  }
}

// --- まとめ --------------------------------------------------------------
console.log(`\n完了: ${done.join(" / ")}`);
if (skipped.length > 0) console.log(`スキップ: ${skipped.join(" / ")}`);
console.log("\n次にやること:");
console.log("  1. Hono を起動する(bun run dev)");
console.log("  2. ブラウザをハードリロードする(Cmd+Shift+R)");

// --- 小道具 --------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 動いている coturn のPID。pidファイル優先、無ければ pgrep で探す */
async function findTurnPid(): Promise<number | null> {
  for (const path of TURN_PID_CANDIDATES) {
    if (!existsSync(path)) continue;
    const pid = Number(readFileSync(path, "utf8").trim());
    // pidファイルは残骸のことがあるので、生きているか確かめる
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return pid;
  }
  const found = await run(["pgrep", "-f", "turnserver -c"]);
  const pid = Number(found.split("\n")[0]?.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 指定IPの3478でTURNが待受しているか */
async function isListeningOn(addr: string): Promise<boolean> {
  const out = await run(["lsof", "-nP", "-iUDP:3478"]);
  return out.includes(`${addr}:3478`);
}

/** 配信物(web-dist)に新IPのTURN URLが入っているか */
async function bundleContainsTurnIp(addr: string): Promise<boolean> {
  const out = await run(["sh", "-c", `cat ./public/web-dist/assets/*.js 2>/dev/null`]);
  return out.includes(`turn:${addr}:3478`);
}

async function run(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  return await new Response(p.stdout).text();
}
