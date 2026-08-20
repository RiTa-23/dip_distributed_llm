// packages/shared-types/messages.ts

// ---------- 基本形 ----------
export type Role = 'peer' | 'requester'
export type PeerStatus = 'connecting' | 'ready' | 'error'
export type SignalKind = 'offer' | 'answer' | 'ice-candidate'

export type PeerInfo = {
  clientId: string
  displayName: string
  status: PeerStatus
}

// ---------- クライアント → サーバ ----------
export type HelloMessage = {
  type: 'hello'
  role: Role
  clientId: string       // クライアント側でuuidを生成して送る
  displayName: string
}

export type PeerStatusMessage = {
  type: 'peer_status'
  status: PeerStatus
  errorMessage?: string
}

export type WebrtcSignalMessage = {
  // requester⇔peer どちらの向きにも使う。HonoはtargetId宛にそのまま転送するだけ
  type: 'webrtc_signal'
  targetId: string
  fromId: string
  payload: { kind: SignalKind; sdp?: string; candidate?: unknown }
}

export type ClientMessage = HelloMessage | PeerStatusMessage | WebrtcSignalMessage

// ---------- サーバ → クライアント ----------
export type RosterUpdateMessage = {
  type: 'roster_update'
  peers: PeerInfo[]
}

export type GenerationStartMessage = {
  // 「このpeer構成でRPC接続してよい」という合図。requesterはこれを受けてWebRTC接続とモデルロードを開始する
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

// webrtc_signalはサーバ→クライアントにも使われる(取り次が結果として)ので両方に含める
export type ServerMessage = RosterUpdateMessage | GenerationStartMessage | GenerationAbortedMessage | WebrtcSignalMessage