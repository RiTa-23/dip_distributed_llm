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

export type GenerationFailedMessage = {
  // requesterのみ送信可。generation_start を受けたあと、WebRTC接続やモデル配布に
  // 失敗して編成が成立しなかったことを伝える。Honoはこれを受けて idle に戻す。
  // これが無いと、切断が起きるまで active のまま固まる。
  type: "generation_failed";
  generation: number;
};

export type ModelChangedMessage = {
  // requesterのみ送信可。モデルを差し替えたので、**同じ顔ぶれのまま**編成を
  // 組み直させる。requester Runtimeは世代の開始時にモデルを掴んで離さないため、
  // 新しい世代を始めない限り差し替えが効かない。
  //
  // `generation_failed` を流用してはいけない。あちらは失敗した顔ぶれを
  // `failedPeerIds` に記録して同じ編成を避けるので、狙いと真逆になる。
  type: "model_changed";
  generation: number;
};

export type ClientMessage =
  | HelloMessage
  | PeerStatusMessage
  | WebrtcSignalMessage
  | RequesterAcceptingMessage
  | GenerationFailedMessage
  | ModelChangedMessage;

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
  // connection_failed: requesterが generation_failed を送ってきた(編成が成立しなかった)
  // model_changed: requesterがモデルを差し替えた。**同じ顔ぶれで組み直す**(失敗ではない)
  reason: "peer_disconnected" | "peer_joined" | "connection_failed" | "model_changed";
  message: string;
};

// webrtc_signalはサーバ→クライアントにも使われる(取り次が結果として)ので両方に含める
export type ServerMessage =
  | RosterUpdateMessage
  | GenerationStartMessage
  | GenerationAbortedMessage
  | WebrtcSignalMessage;
