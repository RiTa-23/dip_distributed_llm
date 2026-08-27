import type { WebrtcSignalMessage } from "@dip_distributed_llm/shared-types/messages";

// requester⇔peer のWebRTC接続を組み立てる部分の共通部品。
// Reactに依存させていないのは、世代の判定とcandidateの順番待ちを
// RTCPeerConnectionなしで(bun testから直接)検証できるようにするため。

/** `/ws` への送信。フックが useHonoSocket の send をそのまま渡す */
export type SignalSender = (msg: WebrtcSignalMessage) => void;

/** RTCPeerConnectionの生成。テストで偽物に差し替えるために外から渡せるようにしている */
export type PeerConnectionFactory = () => RTCPeerConnection;

/** 会場LAN内で完結するのでSTUN/TURNは要らない(AGENTS.md 前提6) */
export const defaultPeerConnectionFactory: PeerConnectionFactory = () =>
  new RTCPeerConnection({ iceServers: [] });

/**
 * セッションから上がってくる通知。第1引数はどれも「接続を張り始めた世代」で、
 * 受け取る側が現行の世代と突き合わせて古いものを捨てられるようにしてある。
 */
export type SessionCallbacks = {
  /** DataChannelが開いた。①の startWasmClient / startWasmPeerServer へ渡す口 */
  onOpen: (generation: number, remoteId: string, channel: RTCDataChannel) => void;
  /** DataChannel上でデータが届いた。PeerManager の handleMessage へ渡す口 */
  onData: (generation: number, remoteId: string, data: unknown) => void;
  /**
   * DataChannelが閉じた。PeerManager の detach / retire へ渡す口。
   * 載っている論理接続を畳ませないと、待たせているrecvが起きないままになる。
   * teardown() は受け口を外してから閉じるので、こちらは飛ばない。
   *
   * requester はここを**世代の致命傷の入口**としても使う。RPC deviceは起動時の
   * `-rpc` 引数で固定されるので、close以外の失敗(connectionState failed、SDP/ICEの
   * 失敗)も同じ道を通り、`onFailed` の直前に1回だけ上がる(`requesterSession.ts`)。
   * peer は long-lived なので従来どおり相手ごとのclose通知のまま。
   */
  onClose: (generation: number, remoteId: string) => void;
  /**
   * 接続が張れなかった、または落ちた。
   * **requester では1セッションにつき最大1回**で、必ず `onClose` の後に来る
   * (畳んで世代を失効させてから画面と制御プレーンへ伝えるため)。
   */
  onFailed: (generation: number, remoteId: string, message: string) => void;
  /** 開通数などが変わった。画面の進捗表示を更新させるためだけに呼ぶ */
  onChange: () => void;
};

export type SessionOptions = {
  /** このセッションが属する世代。作った後は変わらない */
  generation: number;
  myId: string;
  send: SignalSender;
  callbacks: SessionCallbacks;
  createConnection?: PeerConnectionFactory;
};

/**
 * 1世代ぶんの接続のまとまり。
 * requester は全peerとの複数本、peer は requester との1本を持つが、外からは同じ形に見える。
 */
export type WebrtcSession = {
  readonly generation: number;
  /** requester: この顔ぶれへofferを出す。peer: 何もしない(offerが来るのを待つ) */
  start: (peerIds: string[]) => void;
  /** `/ws` から届いた自分宛の webrtc_signal を渡す */
  accept: (msg: WebrtcSignalMessage) => void;
  /** 今つながっている相手 */
  openIds: () => string[];
  /** つながるはずの相手。peer は offer が来るまで空 */
  expectedIds: () => string[];
  /** 全接続を閉じる。世代が変わるたびに呼ぶ */
  teardown: () => void;
};

/**
 * `generation_aborted` を反映するかどうか。
 * 古い世代の中断通知が遅れて届くことがあり、捨てないと始まったばかりの編成を巻き込む。
 * clusterReducer 側の同じ判定と揃えてある。
 */
export function isStaleAbort(msgGeneration: number, current: number): boolean {
  return msgGeneration < current;
}

/**
 * 世代の違う通知を捨てるかどうか。DataChannelの開通時とデータ受信時の2か所で使う。
 * 中断が挟まると現行の世代は前後どちらにも動きうるので、大小ではなく一致で見る。
 */
export function isStaleForCurrent(generation: number, current: number): boolean {
  return generation !== current;
}

/**
 * remoteDescriptionが入るまでICE candidateを溜めておく箱。
 *
 * offerより先にcandidateが届くことはないが、setRemoteDescriptionは非同期なので、
 * その解決を待たずに addIceCandidate を呼ぶと InvalidStateError で落ちる。
 */
export type CandidateQueue = {
  /** まだremoteDescriptionが入っていなければ溜める。入っていればそのまま流す */
  push: (candidate: RTCIceCandidateInit) => void;
  /** remoteDescriptionが入った。溜めた分を届いた順に流す */
  open: () => void;
  /** 溜まっている数。テスト用 */
  size: () => number;
};

export function createCandidateQueue(
  apply: (candidate: RTCIceCandidateInit) => void,
): CandidateQueue {
  let ready = false;
  const pending: RTCIceCandidateInit[] = [];
  return {
    push: (candidate) => {
      if (ready) {
        apply(candidate);
        return;
      }
      pending.push(candidate);
    },
    open: () => {
      ready = true;
      while (pending.length > 0) {
        const next = pending.shift();
        if (next) apply(next);
      }
    },
    size: () => pending.length,
  };
}

/**
 * `payload.candidate` を RTCIceCandidateInit に直す。契約上ここは `unknown` で、
 * ブラウザが作った値をHonoが解釈せず運んでくるだけなので、受け側で最低限だけ確かめる。
 * 終端を表す空文字のcandidateも通す。
 */
export function toCandidateInit(value: unknown): RTCIceCandidateInit | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.candidate !== "string") return null;
  return v as RTCIceCandidateInit;
}

/** 例外を画面に出せる文字列にする */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ChannelHandlers = {
  onOpen: () => void;
  onClose: () => void;
  onData: (data: unknown) => void;
};

/** DataChannelに受け口を付ける。binaryTypeはRPCのバイナリをそのまま扱うため arraybuffer */
export function bindChannel(channel: RTCDataChannel, handlers: ChannelHandlers): void {
  channel.binaryType = "arraybuffer";
  channel.onopen = () => handlers.onOpen();
  channel.onclose = () => handlers.onClose();
  channel.onmessage = (e: MessageEvent) => handlers.onData(e.data);
}

/**
 * 受け口を外す。close()の後にもイベントは飛ぶので、閉じる前に必ず外す。
 * useHonoSocket が ws.onclose を外してから close しているのと同じ理由。
 */
export function unbindChannel(channel: RTCDataChannel): void {
  channel.onopen = null;
  channel.onclose = null;
  channel.onmessage = null;
  channel.onerror = null;
}

export function unbindConnection(pc: RTCPeerConnection): void {
  pc.onicecandidate = null;
  pc.ondatachannel = null;
  pc.onconnectionstatechange = null;
}
