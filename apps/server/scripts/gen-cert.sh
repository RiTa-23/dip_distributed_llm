#!/usr/bin/env bash
# 開発用の mkcert 証明書を生成する(#14)。
# mkcert のローカルCAを各開発PCの信頼ストアに導入し(mkcert -install)、
# localhost / ループバック / このマシンの LAN IP を対象に証明書を発行する。
# 別PCから https でテストする場合は、その参照ホスト(LAN IP)を含めて再生成すること。
set -euo pipefail
cd "$(dirname "$0")/.."   # apps/server

if ! command -v mkcert >/dev/null 2>&1; then
  echo "mkcert が見つかりません。'brew install mkcert nss' 等で導入してください。" >&2
  exit 1
fi

mkdir -p certs

# このマシンの LAN IP(取得できなければ localhost のみ)。
# 既定ルートのアクティブなインターフェースを優先し、無ければ en0/en1、最後に空。
DEFAULT_IF=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
LAN_IP=$(ipconfig getifaddr "${DEFAULT_IF:-en0}" 2>/dev/null \
  || ipconfig getifaddr en0 2>/dev/null \
  || ipconfig getifaddr en1 2>/dev/null \
  || echo "")

# ローカルCAを信頼ストアに導入(既に導入済みなら no-op)
mkcert -install

# 証明書を発行
# shellcheck disable=SC2086
mkcert -cert-file certs/cert.pem -key-file certs/key.pem localhost 127.0.0.1 ::1 ${LAN_IP:-}

echo "生成しました: certs/cert.pem, certs/key.pem"
echo "対象ホスト: localhost 127.0.0.1 ::1 ${LAN_IP:-(LAN IP なし)}"
