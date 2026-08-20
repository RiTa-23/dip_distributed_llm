# 環境構築・実装手順ガイド

## 前提

- Bunインストール済み(`bun --version`。未導入なら `curl -fsSL https://bun.sh/install | bash`)
- 4人でGitリポジトリ共有

## 1. モノレポ雛形

```bash
mkdir distributed-llm && cd distributed-llm
git init
mkdir -p apps packages native

cat > package.json << 'EOF'
{
  "name": "distributed-llm",
  "private": true,
  "workspaces": ["apps/*", "packages/*"]
}
EOF
```

## 2. `packages/shared-types`

```bash
mkdir -p packages/shared-types
cd packages/shared-types

cat > package.json << 'EOF'
{
  "name": "@dip_distributed_llm/shared-types",
  "version": "0.0.0",
  "type": "module",
  "main": "./messages.ts",
  "types": "./messages.ts"
}
EOF
cd ../..
```
`messages.ts`の中身は`implementation-spec.md`の「3. 共有型定義」をコピー。

## 3. `apps/server`(Hono)

```bash
cd apps
bun create hono@latest server
# "Bun" テンプレート選択
cd server
```
`package.json`の`name`を`@dip_distributed_llm/server`に変更、`dependencies`に`@dip_distributed_llm/shared-types: "workspace:*"`を追加。`src/index.ts`は`implementation-spec.md`の「4.2」に差し替え。

```bash
cd ../..
```

## 4. `apps/web`(React)

```bash
cd apps
bun create vite@latest web -- --template react-ts
cd web
```
`package.json`の`name`を`@dip_distributed_llm/web`に変更、`dependencies`に`@dip_distributed_llm/shared-types: "workspace:*"`を追加。

```bash
cd ../..
```

## 5. 一括インストール

```bash
bun install
```

## 6. 動作確認

```bash
# ターミナル1
cd apps/server && bun run dev
# ターミナル2
cd apps/web && bun run dev
```

## 7. 実装順序

**1日目午前(並行):**
- ②: 上記セットアップ実施・push後、`implementation-spec.md`の「4. Hono側実装ガイド」を実装
- ③④: ②待ちの間はモック(`implementation-spec.md`の「5.6」)で画面遷移を先行実装
- ①: `native/`にllmletをサブモジュール追加、無改造でビルドが通るか確認

**1日目午後:**
- ②③④: Hono起動後、モック→本物の`useHonoSocket`に差し替え、`hello`→`roster_update`確認
- ③④: `webrtc-implementation.md`を参考にWebRTC接続開始処理を実装、DataChannel開通を目標
- ①: llmletのWASM+RPCパッチのWebRTC依存部分を洗い出し

**1日目夕方:** ①の「最低限動くか」判定チェックポイント。ダメならスコープ縮小を検討

**2日目:** ①の`startWasmClient`/`startWasmPeerServer`インターフェースに③④のDataChannelを接続。②はgeneration番号ロジックを仕上げ

**3日目以降:** 複数PCでの通しテスト、UI/UX作り込み
