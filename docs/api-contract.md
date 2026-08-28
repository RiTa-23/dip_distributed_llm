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
- `connection_failed`: requesterが後述`generation_failed`を送ってきた(その編成では接続が成立しなかった)
- `model_changed`: requesterが後述`model_changed`を送ってきた(モデルを載せ替えるための組み直し)。**失敗ではない**ので、同じ顔ぶれのまま次の世代が始まる

### 7. `requester_accepting` (client → server, requesterのみ)
生成中(`active`)に新規peerが加入してもよいかをrequesterが伝える。Honoは送信者がrole===`requester`であることを検証し、それ以外からの送信は無視する。
```json
{ "type": "requester_accepting", "accepting": false }
```
- `false`の間、新規peerが`ready`になってもHonoは`roster_update`のみ配信し再編成しない(推論中に編成が割り込むのを防ぐ)
- `true`に戻した瞬間、その間に溜まった未加入readyペアをまとめて1回の`generation_aborted`(reason: `peer_joined`)→`generation_start`で取り込む
- 既定値は`true`(このメッセージを送らなくても、新規peerがreadyになれば従来通り即座に再編成される)
- requesterが切断/再接続すると`true`にリセットされる

### 8. `generation_failed` (client → server, requesterのみ)
`generation_start`を受けたrequesterが、WebRTC接続やモデル配布に失敗して**その編成が成立しなかった**ことを伝える。
```json
{ "type": "generation_failed", "generation": 3 }
```
- Honoは送信者が`requester`であること、`generation`が**現在の世代と一致すること**、`phase`が`active`であることを検証する。いずれかを満たさなければ無視する
- 受理すると`generation_aborted`(reason: `connection_failed`)を全員に配信して`idle`に戻す
- これが無いと、`active`から`idle`へ戻る道が「誰かの切断」しか無く、requesterが1人でも接続に失敗した時点で**次の世代が永久に始まらない**
- **同じ顔ぶれでの即時リトライはしない。** 失敗した編成のpeerIdを覚えておき、次に組める顔ぶれがそれと同一なら`generation_start`を出さない。同じ組み合わせを繰り返し失敗しながら通知を撒き続けるのを防ぐため。誰かが増減するか、peerの`status`が変わって顔ぶれが変われば再開する
- したがって、接続に失敗したpeerは`peer_status: "error"`を送ることが望ましい(下記「世代開始の条件」を参照)
- **クライアント側も1世代につき1回しか送らない。** requesterは予期しないDataChannelのclose・`connectionState: "failed"`・SDP/ICEの失敗をすべて同じ経路(`webrtc/requesterSession.ts`の`fatalFail()`)へ通し、最初の1回でそのセッションを閉じる。Hono側の検証(世代一致・`phase`)と二重になるが、送る側でも絞ってあるほうが世代交代の最中に古い世代ぶんが飛ぶ余地が小さい
- ⚠️ **WebSocketが生きたままDataChannelだけが死んだ場合、これだけでは次の世代が始まらない。** `phase`は`idle`へ戻るが顔ぶれが変わっていないため、上記「同じ顔ぶれでの即時リトライはしない」に当たる。peerの切断・`error`・入り直しのいずれかが要る

### 9. `model_changed` (client → server, requesterのみ)
requesterがモデルを載せ替えたので、**同じ顔ぶれのまま**編成を組み直させる。
```json
{ "type": "model_changed", "generation": 3 }
```
- requester Runtimeは**世代の開始時にモデルを掴んで離さない**(`hooks/useRequesterRuntime.ts`が`generation`をキーに起動する)。したがって新しい世代を始めない限り、ファイルを選び直しても走っている世代には効かない
- Honoは送信者が`requester`であること、`generation`が現在の世代と一致すること、`phase`が`active`であることを検証する。いずれかを満たさなければ無視する
- 受理すると`generation_aborted`(reason: `model_changed`)を全員に配信して`idle`へ戻し、続けて`generation_start`を出す
- ⚠️ **`generation_failed`を流用してはいけない。** あちらは失敗した顔ぶれを`failedPeerIds`に記録して同じ編成を避けるため、モデル差し替えに使うとその場で編成が止まる。こちらは`failedPeerIds`を触らない
- 推論中(`generating`)でも受け付ける。走っている生成は中断されるが、requesterの明示的な操作の結果であり事故ではない
- 画面側は「選ぶ」と「載せる」を分けている。選んだだけでは送らず、**適用を押したときだけ**送る(誤クリックで参加者を巻き込まないため)

## 世代開始の条件

Honoが`generation_start`を出すのは、次をすべて満たすときだけ。

1. `phase`が`idle`
2. `requester`が接続している
3. `connecting`のpeerが1人もいない(準備中の人を置き去りにしない)
4. `ready`のpeerが1人以上いる
5. その顔ぶれが、直前に`generation_failed`で失敗した顔ぶれと同一でない

**`error`のpeerは編成から除外する**(4に数えない)。以前は「peer全員が`ready`」を要求していたため、1台でも`error`になると次の世代が永久に始まらず、フロントは`error`を送るに送れない状態だった。除外することで、不調な1台が全体を止めなくなる。`error`のpeerが`ready`を送り直せば、次の再編成で編成に戻る。

`generation_start`の`peerIds`にも`error`のpeerは含めない。

## データプレーン注記

`generation_start`を受けたrequesterが各peerとWebRTC接続確立後、DataChannel上でRPC通信。**Honoは中身に一切関与しない**(この契約の対象外)。トークンストリーミング生成はrequesterブラウザ内で完結(Hono経由のtokenメッセージは存在しない)。

DataChannel上の枠(論理接続の開閉とデータの分割)はReact側の `apps/web/src/webrtc/peerManager.ts` が扱い、その中身のRPCバイト列はWASM版llama.cppが解釈する。詳細は `webrtc-implementation.md` の「データプレーン」節。

## 設計メモ

- 全JSONメッセージは`type`フィールドで判別する discriminated union
- `generation`番号で古い編成の結果を安全に無視(受信側で`generation !== 現在の編成番号`なら破棄)
- 型定義は`packages/shared-types/messages.ts`に集約、Hono/React両方からimport
