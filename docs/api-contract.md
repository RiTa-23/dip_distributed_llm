# WebSocket API / メッセージ契約(v2)

2種類の通信:
- 制御プレーン(このドキュメントの対象): Hono `/ws` 経由JSON。誰が参加/生成開始合図/WebRTCシグナリング取り次ぎ
- データプレーン: requester⇔peer間WebRTC DataChannel直接P2P。llama.cppのRPCバイナリプロトコルをそのまま使用、Hono非経由

## 接続

全クライアントは `wss://<hono-host>/ws` に接続、直後に `hello` 送信。
- `requester`: 推論リクエスト元(同時1人固定)。RPCクライアント役
- `peer`: 計算リソース提供(PC)。RPCサーバー役

## メッセージ一覧

### 1. `hello` (client → server)
```json
{ "type": "hello", "role": "peer", "clientId": "c-8f3a...(UUID)", "displayName": "太郎のPC" }
```

### 2. `roster_update` (server → 全client, broadcast)
```json
{ "type": "roster_update", "peers": [{ "clientId": "c-8f3a", "displayName": "太郎のPC", "status": "connecting" }] }
```
`status`: `connecting | ready | error`

### 3. `peer_status` (client → server)
```json
{ "type": "peer_status", "status": "ready", "errorMessage": null }
```

### 4. `generation_start` (server → 全client, broadcast)
requesterはこれを受けて対象peerとのWebRTC接続確立とモデルロードを開始。層割当はllama.cpp本体が自動実施のため渡さない。
```json
{ "type": "generation_start", "generation": 3, "peerIds": ["c-aaa1", "c-bbb2", "c-ccc3"] }
```

### 5. `webrtc_signal` (client → server → 対象client)
SDP/ICE candidateをHono経由で相手に転送。requester→peer、peer→requester両方向で使用。
```json
{ "type": "webrtc_signal", "targetId": "c-aaa1", "fromId": "c-req0", "payload": { "kind": "offer", "sdp": "v=0..." } }
```
`payload.kind`: `offer | answer | ice-candidate`。Honoは中身を解釈せず`targetId`宛に転送するのみ。

### 6. `generation_aborted` (server → 全client, broadcast)
```json
{ "type": "generation_aborted", "generation": 3, "reason": "peer_disconnected", "message": "メンバーが変わったため再編成します" }
```
受信後フロントは「再編成中」表示に切替、次の`generation_start`を待つ。`generation`には**中断した現世代の番号**を載せる(古い通知を`generation !== 現在値`で捨てるフロント側フィルタが依存するため)。

`reason`:
- `peer_disconnected`: 既存peerの切断で編成が壊れた
- `peer_joined`: 生成中に新規peerが`ready`になり、Honoが能動的に組み直した(後述`requester_accepting`が`true`の間のみ)

### 7. `requester_accepting` (client → server, requesterのみ)
生成中(`active`)に新規peerが加入してもよいかをrequesterが伝える。Honoは送信者がrole===`requester`であることを検証し、それ以外からの送信は無視する。
```json
{ "type": "requester_accepting", "accepting": false }
```
- `false`の間、新規peerが`ready`になってもHonoは`roster_update`のみ配信し再編成しない(推論中に編成が割り込むのを防ぐ)
- `true`に戻した瞬間、その間に溜まった未加入readyペアをまとめて1回の`generation_aborted`(reason: `peer_joined`)→`generation_start`で取り込む
- 既定値は`true`(このメッセージを送らなくても、新規peerがreadyになれば従来通り即座に再編成される)
- requesterが切断/再接続すると`true`にリセットされる

## データプレーン注記

`generation_start`を受けたrequesterが各peerとWebRTC接続確立後、DataChannel上でRPC通信。中身はHono/React側で解釈不要(①のWASM連携コードが担当)。トークンストリーミング生成はrequesterブラウザ内で完結(Hono経由のtokenメッセージは存在しない)。

## 設計メモ

- 全JSONメッセージは`type`フィールドで判別する discriminated union
- `generation`番号で古い編成の結果を安全に無視(受信側で`generation !== 現在の編成番号`なら破棄)
- 型定義は`packages/shared-types/messages.ts`に集約、Hono/React両方からimport
