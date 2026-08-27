#!/usr/bin/env bun
// apps/web のビルド成果物を apps/server/public/web-dist にコピーする(#30)。
// rm -rf / cp -r という外部コマンド依存をやめ、Node/Bun標準のfs APIだけで行う
// (OSごとの cp/rm の差異に影響されない)。
import { cpSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const serverDir = join(import.meta.dir, "..");
const webDist = join(serverDir, "..", "web", "dist");
const target = join(serverDir, "public", "web-dist");

rmSync(target, { recursive: true, force: true });
cpSync(webDist, target, { recursive: true });
writeFileSync(join(target, ".gitkeep"), "");

console.log(`コピーしました: ${webDist} -> ${target}`);
