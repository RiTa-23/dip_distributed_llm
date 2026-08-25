// packages/shared-types/messages.ts

// ---------- 基本形 ----------
export type Role = "peer" | "requester";
export type PeerStatus = "connecting" | "ready" | "error";
export type SignalKind = "offer" | "answer" | "ice-candidate";

export type PeerInfo = {
  clientId: string;
  displayName: string;
  status: PeerStatus;
};

// ---------- クライアント → サーバ ----------
export type HelloMessage = {
  type: "hello";
  role: Role;
  clientId: string; // クライアント側でuuidを生成して送る
  displayName: string;
};

export type PeerStatusMessage = {
  type: "peer_status";
  status: PeerStatus;
  errorMessage?: string;
};

export type WebrtcSignalMessage = {
  // requester⇔peer どちらの向きにも使う。HonoはtargetId宛にそのまま転送するだけ
  type: "webrtc_signal";
  targetId: string;
  fromId: string;
  payload: { kind: SignalKind; sdp?: string; candidate?: unknown };
};

export type RequesterAcceptingMessage = {
  // requesterのみ送信可。生成中に新規peerが加入してきた際、Honoが自動で
  // 再編成してよいかを伝える。falseの間は加入を保留し、trueに戻した瞬間に
  // まとめて1回だけ再編成する(推論中に再編成が割り込むのを防ぐデバウンス)
  type: "requester_accepting";
  accepting: boolean;
};

export type ClientMessage =
  | HelloMessage
  | PeerStatusMessage
  | WebrtcSignalMessage
  | RequesterAcceptingMessage;

// ---------- サーバ → クライアント ----------
export type RosterUpdateMessage = {
  type: "roster_update";
  peers: PeerInfo[];
};

export type GenerationStartMessage = {
  // 「このpeer構成でRPC接続してよい」という合図。requesterはこれを受けてWebRTC接続とモデルロードを開始する
  type: "generation_start";
  generation: number;
  peerIds: string[];
};

export type GenerationAbortedMessage = {
  type: "generation_aborted";
  generation: number;
  // peer_disconnected: 既存peerの切断で編成が壊れた
  // peer_joined: 生成中に新規peerがreadyになり、Honoが能動的に組み直した(acceptingGrowth時)
  reason: "peer_disconnected" | "peer_joined";
  message: string;
};

// webrtc_signalはサーバ→クライアントにも使われる(取り次が結果として)ので両方に含める
export type ServerMessage =
  | RosterUpdateMessage
  | GenerationStartMessage
  | GenerationAbortedMessage
  | WebrtcSignalMessage;
