
# Qwen3.6-35B-A3B CPU peer 分散 PoC 設計

## 目的

複数の物理PCのブラウザへ Qwen3.6-35B-A3B Q2_K の重み・層を実際に分散配置し、短い prompt を1回最後まで生成する。速度、WebGPU O11の解決、UI polishは今回の受入条件に含めない。

## 確認済みの前提

- Runtime adapter は `startPeer({ disableWebGPU })` と `startRequester({ args, model })` を受け取る。
- peer の `disableWebGPU: true` は adapter 内で `-device cpu` になる。
- requester はRPC deviceが存在するときlocal WebGPU fallbackをmodel placementへ追加しないため、`-device cpu` は付けない。`-c 2048` だけを渡す。
- `ModelSource` は `{ kind: "file", file: File }` を既にサポートしている。RequesterViewで選択Fileを渡し、未選択時は既存dense回帰用URLを維持する。
- localStorageのpeer IDは既定経路として維持し、`?peerId=<unique-id>` があるpeerだけ一時的に上書きする。上書き値は保存しない。
- Runtime artifactはRuntime repoの検証済み `build/web-runtime/` からWeb serverの `public/wasm/` へ配置する。モデルとartifactは大きいためGit管理対象にはしない。

## 実装範囲

1. 既存の引数受け渡し変更をテストで固定する。
2. PeerViewで `?cpu=1` のCPU peerを選べるようにする（既存のWebGPU既定値は変更しない）。
3. RequesterViewに最小限の `.gguf` File選択を追加し、選択FileをRuntimeへ渡す。requesterへ `-c 2048` を渡す。
4. Runtimeの0001〜0005 artifactをローカル静的配信先へ反映する。
5. dense小型modelのB-1回帰を確認後、CPU peer 4 instanceからQwen3.6を実測する。

## 判定

- `INVALID`: adapter情報が意図した実機と異なる。
- `CONTROL FAIL`: dense対照が失敗し、Granite/Qwenの判定をしない。
- `PASS`: distinct peerが複数存在し、Qwenのloadで複数RPCへ配置され、first token後に短い生成がEOSまで完走する。
- `FAIL`:対象段階が完走しない。まず signaling / load / memory / peer数 / ready後推論 / lifecycle の分類だけ行う。
- `BLOCKED`:人手GUIまたは別PCなど、この環境から実行できない外部条件。
- `UNTESTED`:まだ観測していない項目。推測でPASSにしない。

## 受入時のload観測

CPU model bufferと各RPC peer model bufferの合計に大きな欠落がないこと、全40 blocksがいずれかのRPC deviceへ配置されていること、意図しないlocal WebGPU配置がないことを確認する。`token_embd.weight`がrequester CPU固定であることとpadding/alignmentを考慮し、生ファイルサイズまたは1 byte完全一致を無条件のPASS条件にしない。

## 非目標

WebGPU O11修正、performance optimization、preflight自動収集、watchdog、TURN新規検証、Qwen本体のHTTP/IndexedDB配布経路の追加、mainへのmerge。
