# dip_distributed_llm

会場LAN内で、複数のブラウザ(PC)の計算資源を束ねて1つの大きなLLMを分散推論させるハッカソンプロジェクト。参加PCが増えるほど、より大きい/賢いモデルが動く。

## 概要

- **requester**(推論リクエスト元・1人固定): WASM版llama.cpp(rpc-client役)を実行し、各peerとWebRTC DataChannelで直接通信してトークン生成をブラウザ内で完結させる
- **peer**(計算リソース提供・複数・動的増減): WASM版llama.cpp(rpc-server役)を実行し、requesterから受け取った層の計算を担当する
- **Hono**(コーディネータ): 静的配信(React成果物・GGUF・WASM)、`/ws`での制御メッセージ・WebRTCシグナリング取り次ぎ、ロスター管理を行う。Honoが運ぶのは `/ws` の制御メッセージと `/models/*` の **GGUF**(HTTP の HEAD / Range)の2つで、**Runtime間のRPCデータ(peerの担当層の重み・テンソル)はHonoを経由せず**、requester⇔peer間のWebRTC DataChannelを流れる。経路はdirectを優先し、成立しないときは会場LAN内のTURNによるrelayを許可する(**TURN経由でもHonoはRPCを中継しない**)。GGUFもRPCも会場LANの外へは出さない

星型トポロジー(requesterが全peerに個別接続、peer間の直接通信はなし)、会場LAN内完結(クラウドサービス不使用)、推論リクエストは同時1人固定が設計上の前提。詳細は [docs/requirements.md](./docs/requirements.md) を参照。

## リポジトリ構成

```
apps/web/               React (requester画面 / peer参加画面)
apps/server/             Hono コーディネータ
packages/shared-types/    WebSocketメッセージの型定義(messages.ts)
native/                   WASM版llama.cpp・RPCパッチ(別ビルドパイプライン、Emscripten)
docs/                     設計ドキュメント
```

詳しくは [docs/directory-structure.md](./docs/directory-structure.md) を参照。

## 環境構築

### Bunのインストール

このプロジェクトはBunで動く(Node.jsではない)。未導入の場合は以下でインストールする。

**Mac / Linux:**
```bash
curl -fsSL https://bun.sh/install | bash
```

**Windows (PowerShell):**
```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

インストール後、ターミナルを開き直して `bun --version` が表示されることを確認する。

### インストール

```bash
bun install
```

リポジトリルートで一括インストール(`apps/*`・`packages/*`のBun workspaces)。

### 起動

```bash
# ターミナル1: Honoサーバ
cd apps/server && bun run dev

# ターミナル2: Reactアプリ
cd apps/web && bun run dev
```

`native/`配下(llama.cppのWASMビルド)はEmscriptenという別ツールチェーンを使うため、Bun/npmのコマンドでは操作しない。ビルド方法は [docs/tech-selection-rationale.md](./docs/tech-selection-rationale.md) を参照。

## 開発コマンド

`apps/web` / `apps/server` / `packages/shared-types` の各workspaceで、`cd`してから同じ4つのスクリプトが使える。

| コマンド | 内容 |
|---|---|
| `bun run lint` | oxlintで静的解析 |
| `bun run format` | oxfmtでフォーマットチェック(`--check`。差分があれば失敗する。実際にフォーマットを直すには `bunx oxfmt <対象パス>` を実行) |
| `bun run test` | `bun test`でユニットテスト実行(テストファイルが無くても失敗しない) |
| `bun run typecheck` | `tsc --noEmit`で型チェックのみ(ファイル出力なし) |

```bash
cd apps/web       # または apps/server, packages/shared-types
bun run lint
bun run format
bun run test
bun run typecheck
```

このほか `apps/web` / `apps/server` には `bun run dev` (開発サーバ起動)、`apps/web` には `bun run build` (本番ビルド) もある。

これらは [.github/workflows/ci.yml](./.github/workflows/ci.yml) のCIでも同じスクリプトが実行される。`main`・`develop`へのpushとPull Requestで自動実行され、変更されたパス(`apps/web` / `apps/server` / `packages/shared-types`)に応じてジョブが分岐する。`native/`はビルドチェーンが別のためCI対象外。

## ドキュメント

設計ドキュメント一式は [docs/README.md](./docs/README.md) の目次から辿れる。AIコーディングエージェント向けの前提情報は [AGENTS.md](./AGENTS.md) にまとめている。
