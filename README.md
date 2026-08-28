# dip_distributed_llm

会場LAN内で、複数のブラウザ(PC)の計算資源を束ねて1つの大きなLLMを分散推論させるハッカソンプロジェクト。参加PCが増えるほど、より大きい/賢いモデルが動く。

## 概要

- **requester**(推論リクエスト元・1人固定): WASM版llama.cpp(rpc-client役)を実行し、各peerとWebRTC DataChannelで直接通信してトークン生成をブラウザ内で完結させる
- **peer**(計算リソース提供・複数・動的増減): WASM版llama.cpp(rpc-server役)を実行し、requesterから受け取った層の計算を担当する
- **Hono**(コーディネータ): 静的配信(React成果物・GGUF・WASM)、`/ws`での制御メッセージ・WebRTCシグナリング取り次ぎ、ロスター管理を行う。Honoが運ぶのは `/ws` の制御メッセージと `/models/*` の **GGUF**(HTTP の HEAD / Range)の2つで、**Runtime間のRPCデータ(peerの担当層の重み・テンソル)はHonoを経由せず**、requester⇔peer間のWebRTC DataChannelを流れる。経路はdirectを優先し、成立しないときは会場LAN内のTURNによるrelayを許可する(**TURN経由でもHonoはRPCを中継しない**)。GGUFもRPCも会場LANの外へは出さない

星型トポロジー(requesterが全peerに個別接続、peer間の直接通信はなし)、推論リクエストは同時1人固定が設計上の前提。推論・モデル配布は会場LAN内で完結する。本番デモの実在ドメイン方式では、名前解決と発表者PCからの証明書/DNS準備だけ外部サービスを使う。詳細は [docs/requirements.md](./docs/requirements.md) を参照。

## リポジトリ構成

```text
apps/web/               React (requester画面 / peer参加画面)
apps/server/             Hono コーディネータ
packages/shared-types/    WebSocketメッセージの型定義(messages.ts)
native/                   WASM版llama.cpp・RPCパッチ(別ビルドパイプライン、Emscripten)
docs/                     設計ドキュメント
```

Runtime成果物は別ビルドで用意し、`apps/server/public/wasm/` に配置する。
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

### mkcertのインストール

**開発でもHTTPSが要る。** WASM版llama.cppがpthread(`SharedArrayBuffer`)を使うため、
ブラウザが secure context かつ cross-origin isolated である必要がある。
`http://<LAN IP>` では条件を満たさず、参加者の画面が動かない。

```bash
# macOS
brew install mkcert nss

# Windows
winget install FiloSottile.mkcert
```

詳しくは [apps/server/README.md](./apps/server/README.md) を参照。

### リポジトリのclone
任意のディレクトリ（普段使ってる開発フォルダ等）に以下のコマンドでclone
```bash
git clone https://github.com/RiTa-23/dip_distributed_llm.git
```
### インストール

```bash
bun install
```

リポジトリルートで一括インストール(`apps/*`・`packages/*`のBun workspaces)。

### 初回セットアップ

**この節のコマンドはすべてリポジトリルートから実行する。** `--cwd` で対象の
workspaceを指定するので、`cd` して回る必要はない。

```bash
bun run --cwd apps/server setup
```

`setup` が用意するのは**開発用証明書とフロント成果物**。real GGUF と Runtime の
JS/WASM は生成も変更もしないので、別途 `apps/server/public/models/` と
`apps/server/public/wasm/` に配置する。モデルの正しいファイル名・サイズ・SHA-256は
[apps/server/README.md](./apps/server/README.md) を参照。

### 起動

**通常はこれだけ。** Honoがフロントも配信するので、単一オリジンで完結する。

```bash
bun run --cwd apps/server dev
```

`https://localhost:8443` で開く。同じLANの他端末からは、発表者画面のQR(または
`/join-info` が返すURL)を使う。

**フロントを触るときだけ**、Viteの開発サーバを併用する(ホットリロードが効く)。
ターミナルを2つ使う。

```bash
# ターミナル1: Honoサーバ
bun run --cwd apps/server dev
```

```bash
# ターミナル2: Viteの開発サーバ
VITE_HONO_ORIGIN=https://localhost:8443 bun run --cwd apps/web dev
```

**Windows (PowerShell)** は環境変数の渡し方が違う。

```powershell
# ターミナル2: Viteの開発サーバ
$env:VITE_HONO_ORIGIN="https://localhost:8443"; bun run --cwd apps/web dev
```

`VITE_HONO_ORIGIN` を渡すと、Viteが `/ws`・`/join-info`・`/models`・`/wasm` をHonoへ中継する。
渡さないと実制御プレーン・モデル・Runtime成果物が届かず、real Runtime経路は動かない。

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

`apps/server` には配信の準備と本番デモ用のスクリプトがある。

| コマンド | 内容 |
|---|---|
| `bun run setup` | `cert` + `web:copy` を実行。real GGUF / Runtime成果物は触らない |
| `bun run cert` | mkcertで開発用証明書を生成(`certs/{cert,key}.pem`) |
| `bun run dummy-model` | `/models/*` のHEAD/Range経路確認用 `dummy-route-test.gguf` を生成。実推論には使わない |
| `bun run web:copy` | `apps/web` をビルドして `public/web-dist/` へコピー |
| `bun run dns` | 本番デモ用。CloudflareのAレコードを今のLAN IPへ更新([#23](./docs/cert-setup-steps.md)) |

これらは [.github/workflows/ci.yml](./.github/workflows/ci.yml) のCIでも同じスクリプトが実行される。`main`・`develop`へのpushとPull Requestで自動実行され、変更されたパス(`apps/web` / `apps/server` / `packages/shared-types`)に応じてジョブが分岐する。`native/`はビルドチェーンが別のためCI対象外。

## ドキュメント

設計ドキュメント一式は [docs/README.md](./docs/README.md) の目次から辿れる。AIコーディングエージェント向けの前提情報は [AGENTS.md](./AGENTS.md) にまとめている。

よく参照するもの:

| 知りたいこと | 読むファイル |
|---|---|
| 全体アーキテクチャ・設計上の前提 | [docs/requirements.md](./docs/requirements.md) |
| WebSocketメッセージの形式 | [docs/api-contract.md](./docs/api-contract.md) |
| フロントの現状・画面の状態 | [docs/frontend.md](./docs/frontend.md) |
| サーバの配信ルート・証明書まわり | [apps/server/README.md](./apps/server/README.md) |
| 本番デモ用の証明書を取る手順 | [docs/cert-setup-steps.md](./docs/cert-setup-steps.md) |
| デモ当日に上から順に叩く手順 | [docs/demo-checklist.md](./docs/demo-checklist.md) |
