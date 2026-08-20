# AGENTS.md

このリポジトリで作業するAIコーディングエージェント(Claude Code, Codexなど)向けの前提情報です。実装を始める前に必ず読んでください。

## プロジェクト概要

会場LAN内で、複数のブラウザ(PC)の計算資源を束ねて1つの大きなLLMを分散推論させるハッカソンプロジェクト。詳細は `docs/requirements.md` を参照。

## ドキュメント索引

作業前に該当するものを読むこと。詳しくは `docs/README.md` も参照。

| 知りたいこと | 読むファイル |
|---|---|
| 何を作っているか・全体アーキテクチャ | `docs/requirements.md` |
| 用語の意味 | `docs/glossary.md` |
| 誰が何を担当するか | `docs/role-assignment.md` |
| ディレクトリ構成の意図 | `docs/directory-structure.md` |
| WebSocketメッセージの形式 | `docs/api-contract.md` |
| WebRTC接続確立の実装方法 | `docs/webrtc-implementation.md` |
| Hono/Reactのコード例・進め方 | `docs/implementation-spec.md` |
| なぜこの技術を選んだか | `docs/tech-selection-rationale.md` |
| セットアップ手順 | `docs/setup-guide.md` |

## リポジトリ構成

```
apps/web/           React (requester画面 / peer参加画面)
apps/server/         Hono コーディネータ
packages/shared-types/  WebSocketメッセージの型定義(messages.ts)
native/               WASM版llama.cpp・RPCパッチ(別ビルドパイプライン)
docs/                 設計ドキュメント
```

## 実行環境・コマンド

- ランタイム: Bun(Node.jsではない)
- 依存インストール: リポジトリルートで `bun install`(workspaces一括)
- Hono起動: `cd apps/server && bun run dev`
- React起動: `cd apps/web && bun run dev`

## 絶対に踏み外してはいけないアーキテクチャ前提

これらは議論の末に確定した設計判断です。理由を確認せずに変更しないこと。変更が必要な場合は、対応する`docs/`のファイルも同時に更新すること。

1. **星型トポロジー**: requester(1人固定)が全peerと個別にWebRTC接続する。llama.cppのRPCアーキテクチャ上、peer同士が計算結果をやり取りする必要がないため、peer間のWebRTC接続は確立しない(WebRTC自体はpeer間の直接通信が可能な技術だが、今回のアーキテクチャではそもそも使わない、という判断)
2. **制御プレーンとデータプレーンの分離**: Hono(`/ws`)がやり取りするのはJSON(ロスター管理・WebRTCシグナリング)のみ。モデルの重みやテンソルなどの実データはHonoを経由せず、requester⇔peer間のWebRTC DataChannelで直接P2P通信する。Honoにデータを中継させるコードを追加しないこと
3. **レイヤ割り当てはllama.cpp本体に任せる**: Hono側で層の割り当てを計算するロジックを実装しないこと。RPC接続時にllama.cppが各ピアの空きメモリを自動で問い合わせ、比例配分する
4. **世代(generation)ベースの再構成**: ピアの増減は「次の生成が始まるタイミング」でのみ反映する。生成中のトークン単位での動的な再構成は実装しない
5. **推論をリクエストする人数は同時1人固定**: 複数リクエスト同時対応のコードは書かない
6. **クラウドサービス不使用**: 会場LAN内で完結させる。外部のシグナリングサーバーやクラウドサービスへの依存を追加しない

## メッセージ契約を変更する場合

`packages/shared-types/messages.ts`の型を変更したら、必ず`docs/api-contract.md`の該当箇所も同じ内容に更新すること。型定義とドキュメントが食い違った状態でコミットしない。

## `native/`ディレクトリについて

llama.cppのビルドはEmscripten(Bunとは別のツールチェーン)で行う。Bun/npmのコマンドで`native/`配下を操作しようとしないこと。ビルド方法は`docs/tech-selection-rationale.md`と`docs/requirements.md`を参照。

## ファイルをコンテキストに読み込む際の注意

- `native/`配下のビルド成果物(Emscriptenが生成する巨大な`.wasm`ファイルなど)を誤って全文読み込まない。ビルド設定やパッチの差分だけを見れば済むことが多い
- モデルファイル(GGUF)や`node_modules`はコンテキストに読み込まない

## 実装がアーキテクチャ前提に反しそうな場合

上記の「絶対に踏み外してはいけないアーキテクチャ前提」に反する実装をしようとしていることに気づいたら、そのまま進めず、一度立ち止まってユーザーに確認すること。

## コーディング規約

- TypeScript。`any`は極力使わない(WebSocketメッセージの受信部分など、既存コードにある最小限の例外を除く)
- WebSocketメッセージは`packages/shared-types`の判別可能ユニオン型(discriminated union)をそのまま使う。新しいメッセージ種別を追加する際も同じパターンに従う
- コメントやコミットメッセージは日本語で構わない
