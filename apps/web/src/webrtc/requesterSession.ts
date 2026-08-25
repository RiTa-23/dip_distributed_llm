import type { WebrtcSignalMessage } from "@dip_distributed_llm/shared-types/messages";
import {
  bindChannel,
  createCandidateQueue,
  defaultPeerConnectionFactory,
  describeError,
  toCandidateInit,
  unbindChannel,
  unbindConnection,
} from "./session";
import type { CandidateQueue, SessionOptions, WebrtcSession } from "./session";

type Connection = {
  pc: RTCPeerConnection;
  channel: RTCDataChannel;
  candidates: CandidateQueue;
  open: boolean;
};

/**
 * requester側のセッション。`generation_start` の顔ぶれ全員へofferを出す。
 * peer同士は繋がないので、ここが星型の中心になる(AGENTS.md 前提1)。
 */
export function createRequesterSession({
  generation,
  myId,
  send,
  callbacks,
  createConnection = defaultPeerConnectionFactory,
}: SessionOptions): WebrtcSession {
  const connections = new Map<string, Connection>();
  let disposed = false;

  const signal = (targetId: string, payload: WebrtcSignalMessage["payload"]) => {
    send({ type: "webrtc_signal", targetId, fromId: myId, payload });
  };

  const fail = (peerId: string, message: string) => {
    if (disposed) return;
    callbacks.onFailed(generation, peerId, message);
  };

  const connect = (peerId: string) => {
    const pc = createConnection();
    // DataChannelはofferを出す側が作る。peer側は ondatachannel で受け取る
    const channel = pc.createDataChannel("rpc");
    const entry: Connection = {
      pc,
      channel,
      candidates: createCandidateQueue((candidate) => {
        void pc.addIceCandidate(candidate).catch((e: unknown) => fail(peerId, describeError(e)));
      }),
      open: false,
    };
    connections.set(peerId, entry);

    bindChannel(channel, {
      onOpen: () => {
        if (disposed) return;
        entry.open = true;
        callbacks.onOpen(generation, peerId, channel);
        callbacks.onChange();
      },
      onClose: () => {
        if (disposed) return;
        entry.open = false;
        callbacks.onChange();
      },
      // 世代の判定は呼び出し側(useWebrtcSignaling)。ここは通り道だけ用意する
      onData: (data) => {
        if (disposed) return;
        callbacks.onData(generation, peerId, data);
      },
    });

    pc.onicecandidate = (e: RTCPeerConnectionIceEvent) => {
      if (disposed || !e.candidate) return;
      signal(peerId, { kind: "ice-candidate", candidate: e.candidate.toJSON() });
    };

    pc.onconnectionstatechange = () => {
      if (disposed) return;
      if (pc.connectionState === "failed") {
        fail(peerId, `${peerId} との直接接続に失敗しました`);
      }
      callbacks.onChange();
    };

    void (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (disposed) return;
        const sdp = pc.localDescription?.sdp ?? offer.sdp;
        if (typeof sdp !== "string") {
          fail(peerId, "offerのSDPを作れませんでした");
          return;
        }
        signal(peerId, { kind: "offer", sdp });
      } catch (e: unknown) {
        if (disposed) return;
        fail(peerId, describeError(e));
      }
    })();
  };

  const handleAnswer = (msg: WebrtcSignalMessage) => {
    const entry = connections.get(msg.fromId);
    if (!entry) return;
    const sdp = msg.payload.sdp;
    if (typeof sdp !== "string") return;
    void (async () => {
      try {
        await entry.pc.setRemoteDescription({ type: "answer", sdp });
        if (disposed) return;
        // remoteDescriptionが入るまで溜めていた分をここで流す
        entry.candidates.open();
        callbacks.onChange();
      } catch (e: unknown) {
        if (disposed) return;
        fail(msg.fromId, describeError(e));
      }
    })();
  };

  return {
    generation,

    start: (peerIds) => {
      if (disposed) return;
      for (const peerId of peerIds) {
        // 自分自身と、既に張ってある相手は飛ばす
        if (peerId === myId || connections.has(peerId)) continue;
        connect(peerId);
      }
      callbacks.onChange();
    },

    accept: (msg) => {
      if (disposed) return;
      switch (msg.payload.kind) {
        case "answer":
          handleAnswer(msg);
          return;
        case "ice-candidate": {
          const entry = connections.get(msg.fromId);
          if (!entry) return;
          const candidate = toCandidateInit(msg.payload.candidate);
          if (candidate) entry.candidates.push(candidate);
          return;
        }
        case "offer":
          // requesterは常にofferを出す側。星型なので受け取ることはない
          return;
      }
    },

    openIds: () => {
      const ids: string[] = [];
      for (const [peerId, entry] of connections) {
        if (entry.open) ids.push(peerId);
      }
      return ids;
    },

    expectedIds: () => [...connections.keys()],

    teardown: () => {
      disposed = true;
      for (const entry of connections.values()) {
        unbindChannel(entry.channel);
        entry.channel.close();
        unbindConnection(entry.pc);
        entry.pc.close();
      }
      connections.clear();
    },
  };
}
