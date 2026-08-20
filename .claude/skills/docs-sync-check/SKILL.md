---
name: docs-sync-check
description: Check whether docs/ and AGENTS.md still match the actual repo implementation (directory structure, package names, WebSocket message contract, cross-doc links). Use when asked to verify docs are up to date, check docs against implementation, or before a docs-related commit/PR in this repo.
---

# docs-sync-check

このリポジトリ(dip_distributed_llm)の `docs/` および `AGENTS.md` が実装と食い違っていないかを確認するチェックリスト。ドキュメントはAIコーディングエージェントが実装の前提を把握するための一次情報なので、実装とのズレは他のどんな不整合よりも実害が大きい。

## 実行手順

以下を順番にチェックし、最後にズレをまとめて報告する。**勝手に修正しない** — 見つかった不一致は報告し、直すかどうか・どちらを正とするかはユーザーに確認する(過去の判断: ディレクトリ構成やパッケージ名は実装側が正、docsが追従する)。

### 1. メッセージ契約の同期

`packages/shared-types/messages.ts` の型定義と `docs/api-contract.md` を突き合わせる。

- 型ごと(`HelloMessage`, `RosterUpdateMessage`, `WebrtcSignalMessage`, `GenerationStartMessage`, `GenerationAbortedMessage`, `PeerStatusMessage`など)にフィールド名・型・必須/optionalが一致しているか
- `messages.ts`に新しい`type`が増えているのに`api-contract.md`のメッセージ一覧に載っていないもの、逆に`api-contract.md`にあるが型定義から消えたものがないか
- `AGENTS.md`の「メッセージ契約を変更する場合」ルール(型変更時は必ずapi-contract.mdも更新)が守られているかの確認でもある

### 2. ディレクトリ構成・パッケージ名

実際の構成:
```bash
find apps packages native -maxdepth 2 2>/dev/null
cat package.json apps/*/package.json packages/*/package.json 2>/dev/null
```

これを `AGENTS.md`(リポジトリ構成セクション)・`docs/directory-structure.md`・`docs/implementation-spec.md` の記述と比較する。

- `apps/web` / `apps/server` / `packages/shared-types` / `native/` の有無(`native/`が未作成なのはscaffold前として正常。他が未作成の場合のみ要報告)
- 各`package.json`の`name`フィールドとdocs記載のパッケージ名(import文のパッケージ指定含む)が一致しているか
- workspaces設定(ルート`package.json`)がdocs記載と一致しているか

### 3. Hono実装とimplementation-specの差

`apps/server/src/index.ts` の実装状況が `docs/implementation-spec.md` の「4. Hono側」セクションの想定(COOP/COEPヘッダ、`/ws`ロスター管理、`webrtc_signal`取り次ぎ、generation発行)とどれだけ乖離しているかを確認する。ここは「未実装 = 問題」ではなく開発の進捗そのものなので、ズレを実装漏れとして報告するのではなく、現在地としてユーザーに伝える。

### 4. React側の実装状況

`apps/web/src` の実際のファイル構成(`RequesterView`, `PeerView`, `useHonoSocket`, `webrtc/`配下など)が `docs/implementation-spec.md` 5節・`docs/webrtc-implementation.md` の想定パスと一致しているか。まだモック段階か本実装済みかも合わせて確認する。

### 5. ドキュメント間の相互参照

```bash
grep -noE '[A-Za-z_-]+\.md' AGENTS.md CLAUDE.md README.md docs/*.md | sort -u
```

- 参照されているファイル名が`docs/`配下・リポジトリ直下に実在するか(削除済みファイルへの参照が残っていないか)
- `docs/README.md`の目次に載っているファイルが全て実在するか、逆に`docs/`に存在するが目次に載っていない新規ファイルがないか
- `AGENTS.md`のドキュメント索引テーブルも同様にチェック

### 6. アーキテクチャ前提の逸脱チェック

`AGENTS.md`の「絶対に踏み外してはいけないアーキテクチャ前提」(星型トポロジー、制御/データプレーン分離、レイヤ割り当てをllama.cppに任せる、generation単位の再構成、同時1リクエスト固定、クラウド不使用)に反する実装が入っていないか、`apps/server`・`apps/web`のコードをざっと確認する。特に「Honoがデータを中継していないか」「Hono側で層割り当てを計算していないか」は要注意。

## 報告フォーマット

チェック項目ごとに一致/不一致を短くまとめ、不一致のみ詳細(該当ファイル・行、doc側の記述、実装側の状態)を添える。全部一致していれば「一致」とだけ簡潔に報告し、余計な前置きをしない。
