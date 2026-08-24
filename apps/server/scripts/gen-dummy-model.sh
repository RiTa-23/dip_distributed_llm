#!/usr/bin/env bash
# 静的配信の疎通確認用のダミーGGUFを生成する(#12)。
# 中身はランダムバイトでよい(①のWASMはまだ繋がっていないためパースされない)。
# ファイル名はフロント apps/web/src/config.ts の MODEL_NAME と一致させること。
set -euo pipefail
cd "$(dirname "$0")/.."   # apps/server

MODEL_NAME="qwen2.5-1.5b-instruct-q4_k_m.gguf"
SIZE_MB="${1:-50}"

mkdir -p public/models
OUT="public/models/${MODEL_NAME}"
head -c "$((SIZE_MB * 1024 * 1024))" /dev/urandom > "$OUT"

echo "生成しました: ${OUT} (${SIZE_MB}MB, ダミーのランダムバイト)"
