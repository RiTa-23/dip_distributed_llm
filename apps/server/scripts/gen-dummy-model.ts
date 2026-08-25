#!/usr/bin/env bun
// 静的配信の疎通確認用のダミーGGUFを生成する(#12 / #30)。
// /dev/urandom への依存をやめ、Node標準のcryptoでランダムバイトを書き出す(OS非依存)。
// ファイル名はフロント apps/web/src/config.ts の MODEL_NAME と一致させること。
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MODEL_NAME = "qwen2.5-1.5b-instruct-q4_k_m.gguf";
const MAX_SIZE_MB = 10240; // 10GB。桁違いの引数で意図せず巨大ファイルを作らないための上限

const rawArg = process.argv[2];
const sizeMb = rawArg === undefined ? 50 : Number(rawArg);
if (!Number.isInteger(sizeMb) || sizeMb <= 0 || sizeMb > MAX_SIZE_MB) {
  console.error(
    `不正なサイズ指定です: "${rawArg}"。1〜${MAX_SIZE_MB}(MB, 整数)の範囲で指定してください。`,
  );
  process.exit(1);
}

const modelsDir = join(import.meta.dir, "..", "public", "models");
mkdirSync(modelsDir, { recursive: true });

const out = join(modelsDir, MODEL_NAME);
writeFileSync(out, randomBytes(sizeMb * 1024 * 1024));

console.log(`生成しました: ${out} (${sizeMb}MB, ダミーのランダムバイト)`);
