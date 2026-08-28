# Qwen3.6 CPU peer 分散 PoC 実装計画

## 1. 状態確認

- [x] Web repoが最新 `origin/develop` 由来であることを確認する。
- [x] Runtimeの0001〜0005、CPU peer引数、requester引数、File source契約をコードで確認する。
- [x] 既存working treeの未コミット変更を確認し、破棄せず引き継ぐ。
- [x] Qwen3.6 Q2_Kの取得を開始する。

## 2. 最小実装

- [ ] clientIdのpeer query overrideをテストで固定する。
- [ ] CPU peer選択が `disableWebGPU: true` になることをテストで固定する。
- [ ] requesterの `args: ["-c", "2048"]` と選択Fileの受け渡しをテストで固定する。
- [ ] RequesterViewへ最小File pickerを追加する。
- [ ] Runtime export artifactを `apps/server/public/wasm/` へ配置する。

## 3. 検証

- [ ] 追加テストをRED→実装後GREENで確認する。
- [ ] Web typecheck / test / build / lint / formatを実行する。
- [ ] dense小型modelのB-1を同一環境で1 prompt確認する。
- [ ] adapter情報とRuntime `adapter_info` を記録する。
- [ ] CPU peer 4 instance程度でQwen3.6のloadを試し、必要なら5、6へ増やす。
- [ ] load後に短いpromptをEOSまで1回生成する。
- [ ] 同一PCで成立後、可能なら物理PCへ拡張する。

## 判定と停止条件

- `INVALID`: adapter違い。実験を無効化する。
- `CONTROL FAIL`: dense対照失敗。Qwen評価を止める。
- `PASS`: distinct RPC peer、複数peerへのlayer配置、first token、短文EOS完走。
- `FAIL`:一度だけ詳細ログを分類し、明確なコード原因が無い限り推測修正をしない。
- `BLOCKED`:人手操作または別PCが必要で、この環境から進められない。
- 780M/WebGPU O11へ戻らず、CPU PoCの明確なblockerだけを最小修正する。

## 完了後

- [ ] `tasks/todo.md` にレビュー結果を追記する。
- [ ] working tree、diff、artifact hash、実測結果を確認する。
- [ ] Runtime/Webの既存B-1経路を壊していないことを確認する。
