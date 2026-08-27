# 実装仕様書

②Hono担当・③④React担当(2名)が並行着手するための仕様。アーキテクチャは`requirements.md`参照。

## 1. アーキテクチャ要点

- requesterがWASM llama.cpp(rpc-client役)を実行。HonoからGGUFを1回DL、各peerとWebRTC DataChannelで直接P2P。トークン生成はブラウザ内完結
- Honoは静的配信 + `/ws`(制御メッセージ+WebRTCシグナリング取り次ぎ) + ロスター管理のみ。データリレーはしない(ブラウザはWSサーバーを立てられないためWebRTCが必須。確立後の実データはP2P)
- peerはWASM llama.cpp(rpc-server役)。requesterから直接データ受信、GGUF事前保持不要

## 2. リポジトリ構成

```
repo/
├── apps/
│   ├── web/                 # React (requester画面 / peer参加画面)
│   └── server/               # Hono コーディネータ
├── packages/
│   └── shared-types/          # Message型定義
├── native/
│   ├── llama.cpp/             # gitサブモジュール(WASM + WebRTC向けRPCパッチ、①担当)
│   └── Makefile / Dockerfile
└── package.json               # Bun workspaces
```
②③④は`apps/server`・`apps/web`・`packages/shared-types`のみで作業可能。`native/`は①担当。

## 3. 共有型定義(`packages/shared-types/messages.ts`)

```ts
// shared-types/messages.ts

export type Role = 'peer' | 'requester'
export type PeerStatus = 'connecting' | 'ready' | 'error'
export type SignalKind = 'offer' | 'answer' | 'ice-candidate'

export type PeerInfo = {
  clientId: string
  displayName: string
  status: PeerStatus
}

export type HelloMessage = {
  type: 'hello'
  role: Role
  clientId: string
  displayName: string
}

export type PeerStatusMessage = {
  type: 'peer_status'
  status: PeerStatus
  errorMessage?: string
}

export type WebrtcSignalMessage = {
  type: 'webrtc_signal'
  targetId: string
  fromId: string
  payload: { kind: SignalKind; sdp?: string; candidate?: unknown }
}

export type ClientMessage = HelloMessage | PeerStatusMessage | WebrtcSignalMessage

export type RosterUpdateMessage = {
  type: 'roster_update'
  peers: PeerInfo[]
}

export type GenerationStartMessage = {
  type: 'generation_start'
  generation: number
  peerIds: string[]
}

export type GenerationAbortedMessage = {
  type: 'generation_aborted'
  generation: number
  reason: 'peer_disconnected'
  message: string
}

export type ServerMessage = RosterUpdateMessage | GenerationStartMessage | GenerationAbortedMessage | WebrtcSignalMessage
```

## 4. Hono側(②担当)

タスク: 静的配信+COOP/COEPヘッダ / `/ws`ロスター管理 / `webrtc_signal`取り次ぎ / generation番号発行

```ts
// apps/server/src/index.ts
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { createBunWebSocket } from 'hono/bun'
import type { ClientMessage, ServerMessage, PeerInfo } from '@dip_distributed_llm/shared-types/messages'

const { upgradeWebSocket, websocket } = createBunWebSocket()
const app = new Hono()

app.use('*', async (c, next) => {
  await next()
  c.header('Cross-Origin-Opener-Policy', 'same-origin')
  c.header('Cross-Origin-Embedder-Policy', 'require-corp')
})

app.use('/models/*', serveStatic({ root: './public' }))
app.use('/wasm/*', serveStatic({ root: './public' }))
app.use('/*', serveStatic({ root: './public/web-dist' }))

type ClientEntry = { role: 'peer' | 'requester'; displayName: string; status: string; ws: any }
const clients = new Map<string, ClientEntry>()
let generation = 0

function broadcast(msg: ServerMessage) {
  const payload = JSON.stringify(msg)
  for (const c of clients.values()) c.ws.send(payload)
}

function currentRoster(): PeerInfo[] {
  return [...clients.entries()]
    .filter(([, c]) => c.role === 'peer')
    .map(([clientId, c]) => ({ clientId, displayName: c.displayName, status: c.status as any }))
}

function startNewGeneration() {
  generation += 1
  broadcast({
    type: 'generation_start',
    generation,
    peerIds: [...clients.entries()].filter(([, c]) => c.role === 'peer').map(([id]) => id),
  })
}

app.get('/ws', upgradeWebSocket((c) => {
  let myId: string | null = null

  return {
    onMessage(event, ws) {
      const msg: ClientMessage = JSON.parse(event.data as string)
      switch (msg.type) {
        case 'hello':
          myId = msg.clientId
          clients.set(myId, { role: msg.role, displayName: msg.displayName, status: 'connecting', ws })
          broadcast({ type: 'roster_update', peers: currentRoster() })
          break
        case 'peer_status':
          if (myId && clients.has(myId)) clients.get(myId)!.status = msg.status
          broadcast({ type: 'roster_update', peers: currentRoster() })
          // 全peerがreadyになったらstartNewGeneration()を呼ぶ判定を追加
          break
        case 'webrtc_signal':
          const target = clients.get(msg.targetId)
          target?.ws.send(JSON.stringify(msg))
          break
      }
    },
    onClose() {
      if (myId) {
        clients.delete(myId)
        broadcast({ type: 'roster_update', peers: currentRoster() })
        broadcast({
          type: 'generation_aborted',
          generation,
          reason: 'peer_disconnected',
          message: 'メンバーが変わったため再編成します',
        })
      }
    },
  }
}))

export default { fetch: app.fetch, websocket }
```

チェックリスト: `bun run`で起動 / `public/models/`にダミーGGUF配置し配信確認 / COOP/COEPヘッダ付与確認 / `hello`→`roster_update`のテスト / 2タブ間`webrtc_signal`転送確認

## 5. React側(③④担当)

| 担当 | 画面 | 内容 |
|---|---|---|
| ③ | RequesterView | プロンプト入力、WASM llama.cpp起動・生成、ピア一覧 |
| ④ | PeerView | Hono接続、WASM llama.cpp(rpc-server役)起動、貢献演出 |

共通フック:
```ts
// apps/web/src/hooks/useHonoSocket.ts
import { useEffect, useRef, useState, useCallback } from 'react'
import type { ClientMessage, ServerMessage } from '@dip_distributed_llm/shared-types/messages'

export function useHonoSocket(url: string) {
  const wsRef = useRef<WebSocket | null>(null)
  const [lastMessage, setLastMessage] = useState<ServerMessage | null>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const ws = new WebSocket(url)
    wsRef.current = ws
    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onmessage = (event) => setLastMessage(JSON.parse(event.data))
    return () => ws.close()
  }, [url])

  const send = useCallback((msg: ClientMessage) => {
    wsRef.current?.send(JSON.stringify(msg))
  }, [])

  return { lastMessage, connected, send }
}
```

WebRTC接続開始(詳細は`webrtc-implementation.md`):
```ts
// apps/web/src/webrtc/connectToPeer.ts
export function connectToPeer(
  peerId: string,
  send: (msg: any) => void,
  onDataChannelOpen: (channel: RTCDataChannel) => void
) {
  const pc = new RTCPeerConnection() // 同一LANならiceServers不要
  const channel = pc.createDataChannel('rpc')
  channel.binaryType = 'arraybuffer'
  channel.onopen = () => onDataChannelOpen(channel)

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      send({ type: 'webrtc_signal', targetId: peerId, fromId: 'me', payload: { kind: 'ice-candidate', candidate: e.candidate } })
    }
  }

  pc.createOffer().then((offer) => {
    pc.setLocalDescription(offer)
    send({ type: 'webrtc_signal', targetId: peerId, fromId: 'me', payload: { kind: 'offer', sdp: offer.sdp } })
  })

  return pc
}
```

RequesterView:
```tsx
// apps/web/src/RequesterView.tsx
import { useEffect, useState } from 'react'
import { useHonoSocket } from './hooks/useHonoSocket'

export function RequesterView() {
  const { lastMessage, send } = useHonoSocket('/ws')
  const [roster, setRoster] = useState<{ clientId: string; displayName: string; status: string }[]>([])
  const [status, setStatus] = useState<'idle' | 'reorganizing' | 'ready'>('idle')

  useEffect(() => {
    send({ type: 'hello', role: 'requester', clientId: crypto.randomUUID(), displayName: '発表者PC' })
  }, [])

  useEffect(() => {
    if (!lastMessage) return
    switch (lastMessage.type) {
      case 'roster_update':
        setRoster(lastMessage.peers)
        break
      case 'generation_start':
        setStatus('ready')
        // 各peerIdにconnectToPeer()を呼びWebRTC接続開始
        break
      case 'generation_aborted':
        setStatus('reorganizing')
        break
    }
  }, [lastMessage])

  return (
    <div>
      <aside>
        <h3>接続中のピア({roster.length})</h3>
        <ul>{roster.map((p) => <li key={p.clientId}>{p.displayName}: {p.status}</li>)}</ul>
      </aside>
      {status === 'reorganizing' && <div className="toast">メンバーが変わったため再編成中...</div>}
      {/* チャット入力欄・トークン表示は①のWASM連携API確定後に接続 */}
    </div>
  )
}
```

PeerView:
```tsx
// apps/web/src/PeerView.tsx
import { useEffect, useState } from 'react'
import { useHonoSocket } from './hooks/useHonoSocket'

export function PeerView() {
  const { lastMessage, send } = useHonoSocket('/ws')
  const [status, setStatus] = useState<'connecting' | 'ready' | 'error'>('connecting')

  useEffect(() => {
    send({ type: 'hello', role: 'peer', clientId: crypto.randomUUID(), displayName: `参加者-${Math.floor(Math.random() * 1000)}` })
    // ①のWASM初期化関数(rpc-server起動)を呼ぶ。完了後: send({ type: 'peer_status', status: 'ready' })
  }, [])

  useEffect(() => {
    // webrtc_signal受信時、①のWebRTC応答処理へ渡す
  }, [lastMessage])

  return (
    <div className={status === 'ready' ? 'contributing-glow' : ''}>
      <h2>{status === 'ready' ? '貢献中 ⚡' : '接続中...'}</h2>
    </div>
  )
}
```

モック(`apps/server`未完成時の並行開発用):
```ts
// apps/web/src/hooks/useHonoSocket.mock.ts
import { useState, useEffect } from 'react'
import type { ServerMessage } from '@dip_distributed_llm/shared-types/messages'

export function useHonoSocket(_url: string) {
  const [lastMessage, setLastMessage] = useState<ServerMessage | null>(null)

  useEffect(() => {
    const timers = [
      setTimeout(() => setLastMessage({
        type: 'roster_update',
        peers: [{ clientId: 'a', displayName: '太郎のPC', status: 'ready' }],
      }), 500),
      setTimeout(() => setLastMessage({ type: 'generation_start', generation: 1, peerIds: ['a'] }), 1500),
    ]
    return () => timers.forEach(clearTimeout)
  }, [])

  return { lastMessage, connected: true, send: () => {} }
}
```

チェックリスト: `apps/web`雛形作成 / モックで画面遷移実装 / Hono起動後`useHonoSocket.mock`→`useHonoSocket`に差し替え確認

## 6. ①(コア分散基盤)待ちのインターフェース

**2026/8/25更新。** DataChannelとRPCの橋渡しはWebRTC担当が持つことになり、下に挙げていた `startWasmClient` / `startWasmPeerServer` は不要になりました。llmletのRPCパッチはJS側の `Module.PeerManager` しか呼ばないため、そこを埋める `apps/web/src/webrtc/peerManager.ts` が実装済みです(契約は `webrtc-implementation.md` の「データプレーン」節)。

①待ちなのはWASMのビルドそのものです。

- `llmlet-runtime.js` — Runtime adapter。**Web が読むのはこれ**(名前付きexport `startPeer` / `startRequester`)
- `llmlet-mod.js` / `llmlet-mod.wasm` — パッチ済みllama.cppのEmscriptenビルド。adapter が隣から解決するので Web は直接importしない。**`release_conn` は export されていても使わない**(受信バッファの所有権は adapter 側。二重解放になる)
- `onToken(callback: (token: string, done: boolean) => void)` — requester側、生成トークンのコールバック登録
