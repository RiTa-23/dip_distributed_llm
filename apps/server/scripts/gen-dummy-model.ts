#!/usr/bin/env bun
// 静的配信の疎通確認用のダミーGGUFを生成する(#12 / #30)。
// /dev/urandom への依存をやめ、Node標準のcryptoでランダムバイトを書き出す(OS非依存)。
//
// ⚠️ **フロントの `MODEL_NAME` と同じ名前にしてはいけない。** 同じにすると、この
// スクリプトが real GGUF をランダムバイトで上書きする。B-1 以降 `public/models/` には
// 実物の GGUF が置かれており、Runtime はそれを HTTP で読んで実推論している。
// ここが作るのは **`/models/*` の配信経路(HEAD / Range / 206 / 416)を確かめるためだけ**の
// ファイルで、実推論には使えない(中身はただのランダムバイト)。
//
// この理由で `bun run setup` からは外してある。経路を試したいときだけ個別に呼ぶこと。
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DUMMY_NAME = "dummy-route-test.gguf";
// randomBytes() は 2^31-1 バイトまでしか受け付けない(Node/Bun共通)。
// 2048MB(2048*1024*1024 = 2147483648)は1バイト超過してRangeErrorになるため、
// 安全な整数値として2047を上限にする。
const MAX_SIZE_MB = 2047;

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

const out = join(modelsDir, DUMMY_NAME);
writeFileSync(out, randomBytes(sizeMb * 1024 * 1024));

console.log(`生成しました: ${out} (${sizeMb}MB, ダミーのランダムバイト)`);
