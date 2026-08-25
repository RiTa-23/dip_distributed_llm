#!/usr/bin/env bun
// 開発用の mkcert 証明書を生成する(#14 / #30)。
// bash・route・ipconfig等のOS依存コマンドを使わず、Bunの os.networkInterfaces() で
// LAN IPを検出する(apps/server/src/lanAddress.ts を再利用。macOS/Windows/Linux共通)。
// 追加のホスト名/IPを引数で渡すこともできる: bun run cert 192.168.11.5
import { networkInterfaces } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pickLanAddresses } from "../src/lanAddress";

const certsDir = join(import.meta.dir, "..", "certs");
mkdirSync(certsDir, { recursive: true });

const extraHosts = process.argv.slice(2);
const lanIps = pickLanAddresses(networkInterfaces());
const hosts = [...new Set(["localhost", "127.0.0.1", "::1", ...lanIps, ...extraHosts])];

if (Bun.which("mkcert") == null) {
  console.error(
    "mkcert が見つかりません。導入してください:\n" +
      "  macOS  : brew install mkcert nss\n" +
      "  Windows: choco install mkcert  (または scoop install mkcert)\n" +
      "  Linux  : https://github.com/FiloSottile/mkcert#linux",
  );
  process.exit(1);
}

function run(cmd: string[]): void {
  const proc = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  if (!proc.success) {
    console.error(`コマンドが失敗しました: ${cmd.join(" ")}`);
    process.exit(proc.exitCode ?? 1);
  }
}

run(["mkcert", "-install"]);
run([
  "mkcert",
  "-cert-file",
  join(certsDir, "cert.pem"),
  "-key-file",
  join(certsDir, "key.pem"),
  ...hosts,
]);

console.log(`生成しました: ${join(certsDir, "cert.pem")}, ${join(certsDir, "key.pem")}`);
console.log(`対象ホスト: ${hosts.join(" ")}`);
