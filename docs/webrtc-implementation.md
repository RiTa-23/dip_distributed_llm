# WebRTC実装ガイド

`implementation-spec.md`のWebRTC部分の詳細。WebRTC担当(シグナリングからRPCの繋ぎ込みまで)向け。①はWASMのビルド時に「データプレーン」節を、②③④はシグナリング理解のため参照。

## シーケンス

```
requester                    Hono(/ws)                    peer
   |--- hello ------------------>|                           |
   |                             |<------------------- hello -|
   |<---- roster_update ---------|---- roster_update -------->|
   |<---- generation_start ------|---- generation_start ----->|  (peer揃ったら配信)
   |--- RTCPeerConnection作成    |                           |
   |--- createOffer()            |                           |
   |--- webrtc_signal(offer) --->|--- webrtc_signal(offer) -->|
   |                             |                           |--- setRemoteDescription(offer)
   |                             |                           |--- createAnswer()
   |                             |<-- webrtc_signal(answer) --|
   |<-- webrtc_signal(answer) ---|                           |
   |--- setRemoteDescription(answer)                          |
   |<==== ICE candidate交換(双方向、複数回) ====================>|
   |<========== DataChannel 'rpc' 開通(P2P) ====================>|
   |<========== 以降Honoを経由しない ============================>|
```

offer/answer/ICE candidateのやり取りのみHono経由。DataChannel開通後は完全P2P。

## 実装済みの構成(2026/8/25、#37)

③④(React)側は入りました。**以降のコード例は考え方の見本**で、実際のファイルは次のとおりです。

| 見本 | 実物 |
|---|---|
| `webrtc/requesterConnections.ts` | [`apps/web/src/webrtc/requesterSession.ts`](../apps/web/src/webrtc/requesterSession.ts) |
| `webrtc/peerConnection.ts` | [`apps/web/src/webrtc/peerSession.ts`](../apps/web/src/webrtc/peerSession.ts) |
| UI側での振り分け | [`apps/web/src/hooks/useWebrtcSignaling.ts`](../apps/web/src/hooks/useWebrtcSignaling.ts)(両画面共通) |

見本との違いが2つあります。

- **ICE candidateを溜める箱を挟んでいます。** 見本のように `setRemoteDescription` の解決を待たずに `addIceCandidate` を呼ぶと `InvalidStateError` で落ちます。offerよりcandidateが先に届くことはありませんが、`setRemoteDescription` が非同期なので順番待ちが要ります
- **モジュール直下の可変変数(`let pc`)を持たせていません。** 世代ごとにセッションを作り直して古い接続を確実に閉じるため、`createPeerSession` / `createRequesterSession` が状態を閉じ込めています

詳しくは `frontend.md` の「データプレーンの繋ぎ込み(ステップ4)」を参照してください。

## requester側

```ts
// apps/web/src/webrtc/requesterConnections.ts
import type { WebrtcSignalMessage } from '@dip_distributed_llm/shared-types/messages'

type SendFn = (msg: WebrtcSignalMessage) => void

const connections = new Map<string, RTCPeerConnection>()
const channels = new Map<string, RTCDataChannel>()

export function connectToPeer(peerId: string, myId: string, send: SendFn, onOpen: (peerId: string, channel: RTCDataChannel) => void) {
  const pc = new RTCPeerConnection({ iceServers: [] }) // 同一LAN内なのでSTUN/TURN不要
  connections.set(peerId, pc)

  const channel = pc.createDataChannel('rpc')
  channel.binaryType = 'arraybuffer'
  channel.onopen = () => onOpen(peerId, channel)
  channels.set(peerId, channel)

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      send({ type: 'webrtc_signal', targetId: peerId, fromId: myId, payload: { kind: 'ice-candidate', candidate: e.candidate.toJSON() } })
    }
  }

  pc.createOffer().then(async (offer) => {
    await pc.setLocalDescription(offer)
    send({ type: 'webrtc_signal', targetId: peerId, fromId: myId, payload: { kind: 'offer', sdp: offer.sdp } })
  })
}

export async function handleSignal(msg: WebrtcSignalMessage) {
  const pc = connections.get(msg.fromId)
  if (!pc) return
  if (msg.payload.kind === 'answer') {
    await pc.setRemoteDescription({ type: 'answer', sdp: msg.payload.sdp })
  } else if (msg.payload.kind === 'ice-candidate') {
    await pc.addIceCandidate(msg.payload.candidate as RTCIceCandidateInit)
  }
}
```

全peer分のDataChannelが`open`になってから①の`startWasmClient()`を呼ぶ。1人でも失敗したら`generation_aborted`相当扱いでリトライ。

```ts
const openChannels = new Map<string, RTCDataChannel>()
function checkAllReady(expectedPeerIds: string[]) {
  if (expectedPeerIds.every((id) => openChannels.has(id))) {
    // startWasmClient(openChannels)
  }
}
```

## peer側

peer側は「待ち受け」ではなく「offerが来たら応答する」役(WebRTCではどちらの端末も物理的listenポートを開かない)。

```ts
// apps/web/src/webrtc/peerConnection.ts
import type { WebrtcSignalMessage } from '@dip_distributed_llm/shared-types/messages'

type SendFn = (msg: WebrtcSignalMessage) => void
let pc: RTCPeerConnection | null = null

export async function handleOffer(msg: WebrtcSignalMessage, myId: string, send: SendFn, onDataChannel: (channel: RTCDataChannel) => void) {
  pc = new RTCPeerConnection({ iceServers: [] })
  pc.ondatachannel = (e) => {
    e.channel.binaryType = 'arraybuffer'
    onDataChannel(e.channel) // startWasmPeerServer()へ
  }
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      send({ type: 'webrtc_signal', targetId: msg.fromId, fromId: myId, payload: { kind: 'ice-candidate', candidate: e.candidate.toJSON() } })
    }
  }
  await pc.setRemoteDescription({ type: 'offer', sdp: msg.payload.sdp })
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  send({ type: 'webrtc_signal', targetId: msg.fromId, fromId: myId, payload: { kind: 'answer', sdp: answer.sdp } })
}

export async function handleIceCandidate(msg: WebrtcSignalMessage) {
  if (pc) await pc.addIceCandidate(msg.payload.candidate as RTCIceCandidateInit)
}
```

peer側`useHonoSocket`の`lastMessage`が`webrtc_signal`で`payload.kind`が`offer`なら`handleOffer`、`ice-candidate`なら`handleIceCandidate`をUI側で振り分け。

## LAN限定であることの影響

- `iceServers: []`でよい(STUN/TURN不要)
- ICEはhost candidate(ローカルIP直接)のみで同一LAN内疎通
- 会場Wi-FiのAP isolation設定を事前確認(有効だと同一LAN内でも端末間通信不可、WebRTC接続不可)

## 世代変更時の接続管理

```ts
function teardownAllConnections() {
  for (const pc of connections.values()) pc.close()
  connections.clear()
  channels.clear()
}
// generation_aborted / 新しいgeneration_start受信時に呼んでから張り直す
```

## デバッグ

- Chrome: `chrome://webrtc-internals`でICE状態・DataChannel状態を確認
- `pc.connectionState` / `pc.iceConnectionState`をログ出力
- offer/answer/ice-candidateの`targetId`到達確認はHono側ログで

## データプレーン: llama.cppのRPCをDataChannelに載せる

### 誰が何を持つか(2026/8/25更新)

以前は「③④はDataChannelが開くところまで、その先は①」と書いていましたが、WebRTCはシグナリングからRPCの繋ぎ込みまで一貫して1人が持つことになりました。①の担当は**WASMのビルド**(パッチ済みllama.cppをEmscriptenでコンパイルする)に絞られます。

| 範囲 | 担当 | 状態 |
|---|---|---|
| `webrtc_signal` の送受信・DataChannel確立 | WebRTC担当 | 完了(#37) |
| Hono側の `webrtc_signal` 素通し中継 | ② | 完了(#19) |
| DataChannel ↔ llama.cpp RPC の橋渡し(`PeerManager`) | WebRTC担当 | 実装済み(下記) |
| WASMのビルド(`llmlet-mod.js` / `.wasm`)とページへの読み込み | ① | 未着手 |

### llmletのどこを差し替えるか

先行事例のllmletは、WASM側(`main.cpp` とllama.cppのRPCパッチ)からJS側の `Module.PeerManager` というソケット相当のオブジェクトだけを呼びます。PeerJSはその `PeerManager` を組み立てる関数(`llmlet.js` の `newPeerManager`)の内側にしか出てきません。

**したがって、シグナリングを自前のHonoへ寄せるのにC++側の変更は要りません。** `newPeerManager` を我々のDataChannelで書き直せば済みます。それが [`apps/web/src/webrtc/peerManager.ts`](../apps/web/src/webrtc/peerManager.ts) です。

`connect()` に渡る `nodeId` は、llama.cppの `rpc_servers`(`-rpcserver` で渡すエンドポイント文字列)がそのまま来ます。ここに我々の `clientId` を入れれば繋がります。

### PeerManagerの契約

llmletの `libllmlet.js` が呼ぶ6つのメソッドです。名前・引数はそちらに合わせてあり、勝手に変えるとWASM側が動きません。

| メソッド | 意味 |
|---|---|
| `connect(nodeId, done)` | 相手へ論理接続を開き、fd(失敗は-1)を `done` で返す |
| `accept(done)` | 着信を待ち、fdを `done` で返す |
| `send(fd, data)` | 送れたバイト数を返す。fdが無ければ-1 |
| `recv(fd, len, writeCB, doneCB)` | 非同期受信。1バイトも無ければ届くまで `doneCB` を呼ばない |
| `close_connection(fd)` | 論理接続を閉じる(DataChannel自体は閉じない) |
| `register_buf(fd, ptr)` | WASM側の受信バッファの番地を控える。畳むときに `Module.release_conn` へ返す |

注意点が2つあります。

- **`accept` は-1を返してはいけません。** `accept_peer` は-1を「まだ来ていない」の番兵にして `Atomics.wait` するため、-1を書くとWASM側のスレッドが起きません(`connect` と `recv` の番兵は-2なので、そちらは-1で失敗を表せます)
- **WASM側はpthreadの上で `Atomics.wait` して待ちます。** PeerManagerのメソッドはメインスレッドへ寄せて呼ばれる(`__proxy: 'sync'`)ので、RTCDataChannelをメインスレッドに置いたままで噛み合います。これが動く前提として cross-origin isolation(COOP/COEP)が要ります(②がIssue #13で対応済み)

### DataChannel上のフレーム形式

llmlet本家はPeerJSのオブジェクト送信に頼っていますが、こちらは生のRTCDataChannelなので枠を自前で決めています。両端とも我々のコードなので本家と互換である必要はありません。

```text
[0]    コマンド1バイト   0x01 connect / 0x02 accepted / 0x03 data / 0x04 close
[1..]  本文(dataのときだけ)
```

DataChannelは既定で順序保証つきの信頼配送なので、1メッセージ=1フレームでよく、長さ接頭辞は要りません。本文は64KiBからヘッダ1バイトを引いた大きさで分割します(SCTPの相互運用で安全に通るのが64KiB)。

受信側は論理接続ごとに溜まったバイト数を数えていて、上限(既定256MiB)を超えたらその接続を畳みます。相手がrecvより速く送り続けたときに、タブがヒープを食い潰して落ちるのを避けるためです。落ちると何が起きたか分からなくなるので、その手前でエラーとして表に出します。通常の転送では踏まない大きさにしてあります。

llama.cppのC側はソケットの開閉を頻繁に繰り返しますが、1本のDataChannelの上を論理接続が**直列に**使い回す形になるため、同時に生きる論理接続は相手1人につき1本だけです。

### React側への繋ぎ込み

`PeerManager` は接続を張りません。既に開いたDataChannelを受け取って、その上に載るだけです。`useWebrtcSignaling` の2つのコールバックにそのまま繋がります。

```ts
const pm = createPeerManager({ releaseBuf: (ptr) => Module.release_conn(ptr) })

useWebrtcSignaling({
  // ...
  onOpen: (remoteId, channel) => pm.attach(remoteId, channel),
  onData: (remoteId, data) => pm.handleMessage(remoteId, data),
})
```

世代が変わったときの破棄判定は `useWebrtcSignaling` 側で済んでいるので、古い世代のデータが `handleMessage` まで来ることはありません。

### まだ無いもの

WASM本体(`llmlet-mod.js` / `.wasm`)が無いため、`Module.PeerManager = pm` を実際に差し込む箇所と、`startClient` / `startServer` に相当する起動処理はまだ書けません。ビルドが来た時点で繋ぎます。

ビルド側の前提(llmletのMakefileより): emsdk 4.0.16以上、`-sMEMORY64=2`(wasm64)、emdawnwebgpu(Dawn)、`-sEXPORTED_RUNTIME_METHODS` に `release_conn` を含めること。パッチ済みllama.cppは `ktock/llama.cpp` のフォークです。
