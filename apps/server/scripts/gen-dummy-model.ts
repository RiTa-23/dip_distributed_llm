#!/usr/bin/env bun
// 静的配信の疎通確認用のダミーGGUFを生成する(#12 / #30)。
// /dev/urandom への依存をやめ、Node標準のcryptoでランダムバイトを書き出す(OS非依存)。
// ファイル名はフロント apps/web/src/config.ts の MODEL_NAME と一致させること。
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MODEL_NAME = "qwen2.5-1.5b-instruct-q4_k_m.gguf";
const sizeMb = Number(process.argv[2] ?? 50);

const modelsDir = join(import.meta.dir, "..", "public", "models");
mkdirSync(modelsDir, { recursive: true });

const out = join(modelsDir, MODEL_NAME);
writeFileSync(out, randomBytes(sizeMb * 1024 * 1024));

console.log(`生成しました: ${out} (${sizeMb}MB, ダミーのランダムバイト)`);
