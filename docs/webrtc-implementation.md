# WebRTC実装ガイド

`implementation-spec.md`のWebRTC部分の詳細。①(コア分散基盤)向け中心、②③④もシグナリング理解のため参照。

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

## ①との境界

③④(React)は「DataChannelが開いた」ところまで担当。①はDataChannelを受け取りWASM llama.cppのRPC通信を接続(`startWasmClient(channels)` / `startWasmPeerServer(onDataChannel)`)。
