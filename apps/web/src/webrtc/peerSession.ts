import type { WebrtcSignalMessage } from "@dip_distributed_llm/shared-types/messages";
import {
  bindChannel,
  createCandidateQueue,
  attachIceDiagnostics,
  defaultPeerConnectionFactory,
  describeError,
  toCandidateInit,
  unbindChannel,
  unbindConnection,
} from "./session";
import type { CandidateQueue, SessionOptions, WebrtcSession } from "./session";

/**
 * peer側のセッション。offerを受けてanswerを返す役で、こちらから接続を始めることはない
 * (WebRTCではどちらの端末も物理的なlistenポートを開かない)。
 *
 * 相手は常にrequesterの1本だけ(星型トポロジー、AGENTS.md 前提1)。
 * requesterのclientIdは事前に知らなくてよく、offerの `fromId` から分かる。
 */
export function createPeerSession({
  generation,
  myId,
  send,
  callbacks,
  createConnection = defaultPeerConnectionFactory,
}: SessionOptions): WebrtcSession {
  let pc: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  let candidates: CandidateQueue | null = null;
  let remoteId: string | null = null;
  /** 経路ログの後始末。teardown で呼ぶ */
  let detachDiagnostics: (() => void) | null = null;
  let open = false;
  let disposed = false;

  const signal = (targetId: string, payload: WebrtcSignalMessage["payload"]) => {
    send({ type: "webrtc_signal", targetId, fromId: myId, payload });
  };

  const fail = (message: string) => {
    if (disposed || !remoteId) return;
    callbacks.onFailed(generation, remoteId, message);
  };

  const handleOffer = (msg: WebrtcSignalMessage) => {
    // 同じ世代で2通目のofferは来ない想定。来ても最初の1本を壊さない
    if (pc) return;
    const sdp = msg.payload.sdp;
    if (typeof sdp !== "string") return;

    const from = msg.fromId;
    remoteId = from;
    const conn = createConnection();
    pc = conn;
    detachDiagnostics = attachIceDiagnostics(conn);
    candidates = createCandidateQueue((candidate) => {
      void conn.addIceCandidate(candidate).catch((e: unknown) => fail(describeError(e)));
    });

    conn.ondatachannel = (e: RTCDataChannelEvent) => {
      if (disposed) return;
      channel = e.channel;
      bindChannel(e.channel, {
        onOpen: () => {
          if (disposed) return;
          open = true;
          callbacks.onOpen(generation, from, e.channel);
          callbacks.onChange();
        },
        onClose: () => {
          if (disposed) return;
          open = false;
          callbacks.onClose(generation, from);
          callbacks.onChange();
        },
        // 世代の判定は呼び出し側(useWebrtcSignaling)。ここは通り道だけ用意する
        onData: (data) => {
          if (disposed) return;
          callbacks.onData(generation, from, data);
        },
      });
    };

    conn.onicecandidate = (e: RTCPeerConnectionIceEvent) => {
      if (disposed || !e.candidate) return;
      signal(from, { kind: "ice-candidate", candidate: e.candidate.toJSON() });
    };

    conn.onconnectionstatechange = () => {
      if (disposed) return;
      if (conn.connectionState === "failed") {
        fail("発表者との直接接続に失敗しました");
      }
      callbacks.onChange();
    };

    void (async () => {
      try {
        await conn.setRemoteDescription({ type: "offer", sdp });
        if (disposed) return;
        // remoteDescriptionが入るまで溜めていた分をここで流す
        candidates?.open();
        const answer = await conn.createAnswer();
        await conn.setLocalDescription(answer);
        if (disposed) return;
        const answerSdp = conn.localDescription?.sdp ?? answer.sdp;
        if (typeof answerSdp !== "string") {
          fail("answerのSDPを作れませんでした");
          return;
        }
        signal(from, { kind: "answer", sdp: answerSdp });
        callbacks.onChange();
      } catch (e: unknown) {
        if (disposed) return;
        fail(describeError(e));
      }
    })();

    callbacks.onChange();
  };

  return {
    generation,

    // peerは待ち受ける側なので、始めることは何もない
    start: () => {},

    accept: (msg) => {
      if (disposed) return;
      switch (msg.payload.kind) {
        case "offer":
          handleOffer(msg);
          return;
        case "ice-candidate": {
          // offerを出した相手以外からのcandidateは捨てる(peer同士は繋がない)
          if (!candidates || msg.fromId !== remoteId) return;
          const candidate = toCandidateInit(msg.payload.candidate);
          if (candidate) candidates.push(candidate);
          return;
        }
        case "answer":
          // peerはanswerを出す側。受け取ることはない
          return;
      }
    },

    openIds: () => (open && remoteId ? [remoteId] : []),
    expectedIds: () => (remoteId ? [remoteId] : []),

    teardown: () => {
      disposed = true;
      open = false;
      detachDiagnostics?.();
      detachDiagnostics = null;
      if (channel) {
        unbindChannel(channel);
        channel.close();
        channel = null;
      }
      if (pc) {
        unbindConnection(pc);
        pc.close();
        pc = null;
      }
      candidates = null;
    },
  };
}
