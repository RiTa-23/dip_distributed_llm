import { describe, expect, test } from "bun:test";
import type { WebrtcSignalMessage } from "@dip_distributed_llm/shared-types/messages";
import { createCandidateQueue, isStaleAbort, isStaleForCurrent, toCandidateInit } from "./session";
import type { SessionCallbacks } from "./session";
import { createPeerSession } from "./peerSession";
import { createRequesterSession } from "./requesterSession";

// bunにWebRTCは無いので、セッションが呼ぶぶんだけを備えた偽物を注入する。
// setRemoteDescription は解決の時点をテスト側から決められるようにしてある
// (candidateの順番待ちが効いているかを見るため)。

type FakeChannel = {
  label: string;
  binaryType: string;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  closed: boolean;
  close: () => void;
};

function createFakeChannel(label: string): FakeChannel {
  const channel: FakeChannel = {
    label,
    binaryType: "blob",
    onopen: null,
    onclose: null,
    onmessage: null,
    onerror: null,
    closed: false,
    close: () => {
      channel.closed = true;
    },
  };
  return channel;
}

type Description = { type: string; sdp?: string };

type FakePc = {
  connectionState: RTCPeerConnectionState;
  localDescription: Description | null;
  remoteDescription: Description | null;
  onicecandidate: ((e: { candidate: RTCIceCandidate | null }) => void) | null;
  ondatachannel: ((e: { channel: FakeChannel }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  addedCandidates: RTCIceCandidateInit[];
  channels: FakeChannel[];
  closed: boolean;
  /** setRemoteDescription の解決をテスト側から起こす */
  resolveRemote: () => void;
  createDataChannel: (label: string) => FakeChannel;
  setRemoteDescription: (d: Description) => Promise<void>;
  setLocalDescription: (d: Description) => Promise<void>;
  createOffer: () => Promise<Description>;
  createAnswer: () => Promise<Description>;
  addIceCandidate: (c: RTCIceCandidateInit) => Promise<void>;
  close: () => void;
};

function createFakePc(): FakePc {
  let release: () => void = () => {};
  const pc: FakePc = {
    connectionState: "new",
    localDescription: null,
    remoteDescription: null,
    onicecandidate: null,
    ondatachannel: null,
    onconnectionstatechange: null,
    addedCandidates: [],
    channels: [],
    closed: false,
    resolveRemote: () => release(),
    createDataChannel: (label) => {
      const channel = createFakeChannel(label);
      pc.channels.push(channel);
      return channel;
    },
    setRemoteDescription: (d) => {
      pc.remoteDescription = d;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    setLocalDescription: async (d) => {
      pc.localDescription = d;
    },
    createOffer: async () => ({ type: "offer", sdp: "SDP_OFFER" }),
    createAnswer: async () => ({ type: "answer", sdp: "SDP_ANSWER" }),
    addIceCandidate: async (c) => {
      pc.addedCandidates.push(c);
    },
    close: () => {
      pc.closed = true;
    },
  };
  return pc;
}

/** 溜まったマイクロタスクを流す */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type Recorder = {
  sent: WebrtcSignalMessage[];
  opened: { generation: number; remoteId: string }[];
  data: { generation: number; remoteId: string; data: unknown }[];
  failed: { generation: number; message: string }[];
  callbacks: SessionCallbacks;
  send: (msg: WebrtcSignalMessage) => void;
};

function createRecorder(): Recorder {
  const r: Recorder = {
    sent: [],
    opened: [],
    data: [],
    failed: [],
    send: (msg) => {
      r.sent.push(msg);
    },
    callbacks: {
      onOpen: (generation, remoteId) => {
        r.opened.push({ generation, remoteId });
      },
      onData: (generation, remoteId, data) => {
        r.data.push({ generation, remoteId, data });
      },
      onFailed: (generation, _remoteId, message) => {
        r.failed.push({ generation, message });
      },
      onChange: () => {},
    },
  };
  return r;
}

const iceCandidate = (candidate: string) =>
  ({ candidate, sdpMid: "0", sdpMLineIndex: 0 }) as RTCIceCandidateInit;

const offerFrom = (fromId: string, targetId: string): WebrtcSignalMessage => ({
  type: "webrtc_signal",
  targetId,
  fromId,
  payload: { kind: "offer", sdp: "SDP_OFFER" },
});

const candidateFrom = (
  fromId: string,
  targetId: string,
  candidate: unknown,
): WebrtcSignalMessage => ({
  type: "webrtc_signal",
  targetId,
  fromId,
  payload: { kind: "ice-candidate", candidate },
});

describe("世代番号による破棄", () => {
  test("古い世代の generation_aborted は捨てる", () => {
    // 中断通知が遅れて届くことがある。捨てないと始まったばかりの編成を巻き込む
    expect(isStaleAbort(2, 3)).toBe(true);
    expect(isStaleAbort(3, 3)).toBe(false);
    // 現行より新しい中断は起きない想定だが、届いたら反映する側に倒す
    expect(isStaleAbort(4, 3)).toBe(false);
  });

  test("世代が一致しない通知は捨てる", () => {
    // DataChannel開通時とデータ受信時。中断を挟むと前後どちらにも動きうるので一致で見る
    expect(isStaleForCurrent(3, 3)).toBe(false);
    expect(isStaleForCurrent(2, 3)).toBe(true);
    expect(isStaleForCurrent(4, 3)).toBe(true);
  });
});

describe("createCandidateQueue", () => {
  test("open前は溜め、open後に届いた順で流す", () => {
    const applied: string[] = [];
    const queue = createCandidateQueue((c) => applied.push(String(c.candidate)));

    queue.push(iceCandidate("a"));
    queue.push(iceCandidate("b"));
    expect(applied).toEqual([]);
    expect(queue.size()).toBe(2);

    queue.open();
    expect(applied).toEqual(["a", "b"]);
    expect(queue.size()).toBe(0);
  });

  test("open後のpushは素通しする", () => {
    const applied: string[] = [];
    const queue = createCandidateQueue((c) => applied.push(String(c.candidate)));
    queue.open();
    queue.push(iceCandidate("c"));
    expect(applied).toEqual(["c"]);
  });
});

describe("toCandidateInit", () => {
  test("candidateが文字列のオブジェクトだけ通す", () => {
    expect(toCandidateInit({ candidate: "candidate:1 1 udp ...", sdpMid: "0" })).not.toBeNull();
    // 終端を表す空文字も通す
    expect(toCandidateInit({ candidate: "" })).not.toBeNull();
  });

  test("契約に合わない値は捨てる", () => {
    expect(toCandidateInit(null)).toBeNull();
    expect(toCandidateInit("candidate:1")).toBeNull();
    expect(toCandidateInit([{ candidate: "x" }])).toBeNull();
    expect(toCandidateInit({ sdpMid: "0" })).toBeNull();
  });
});

describe("createPeerSession", () => {
  const build = () => {
    const pc = createFakePc();
    const r = createRecorder();
    const session = createPeerSession({
      generation: 3,
      myId: "c-peer",
      send: r.send,
      callbacks: r.callbacks,
      createConnection: () => pc as unknown as RTCPeerConnection,
    });
    return { pc, r, session };
  };

  test("offerを受けたらanswerを返す", async () => {
    const { pc, r, session } = build();
    session.accept(offerFrom("c-req", "c-peer"));
    pc.resolveRemote();
    await flush();

    expect(pc.remoteDescription).toEqual({ type: "offer", sdp: "SDP_OFFER" });
    const answer = r.sent.find((m) => m.payload.kind === "answer");
    expect(answer).toBeDefined();
    expect(answer?.targetId).toBe("c-req");
    expect(answer?.fromId).toBe("c-peer");
    expect(answer?.payload.sdp).toBe("SDP_ANSWER");
  });

  test("setRemoteDescriptionが解決するまでcandidateを溜める", async () => {
    const { pc, r, session } = build();
    session.accept(offerFrom("c-req", "c-peer"));
    session.accept(candidateFrom("c-req", "c-peer", iceCandidate("a")));
    await flush();
    // 解決前にaddIceCandidateを呼ぶとInvalidStateErrorになるので、まだ渡さない
    expect(pc.addedCandidates).toEqual([]);

    pc.resolveRemote();
    await flush();
    expect(pc.addedCandidates.map((c) => c.candidate)).toEqual(["a"]);
    expect(r.failed).toEqual([]);
  });

  test("offerより前のcandidateと、別の相手からのcandidateは捨てる", async () => {
    const { pc, r, session } = build();
    session.accept(candidateFrom("c-req", "c-peer", iceCandidate("early")));
    session.accept(offerFrom("c-req", "c-peer"));
    // peer同士は繋がない。requester以外から来たものは受け付けない
    session.accept(candidateFrom("c-other", "c-peer", iceCandidate("stranger")));
    pc.resolveRemote();
    await flush();

    expect(pc.addedCandidates).toEqual([]);
    expect(r.failed).toEqual([]);
  });

  test("DataChannelが開いたら世代つきで通知する", async () => {
    const { pc, r, session } = build();
    session.accept(offerFrom("c-req", "c-peer"));
    pc.resolveRemote();
    await flush();

    expect(session.expectedIds()).toEqual(["c-req"]);
    expect(session.openIds()).toEqual([]);

    const channel = createFakeChannel("rpc");
    pc.ondatachannel?.({ channel });
    expect(channel.binaryType).toBe("arraybuffer");

    channel.onopen?.();
    expect(r.opened).toEqual([{ generation: 3, remoteId: "c-req" }]);
    expect(session.openIds()).toEqual(["c-req"]);

    channel.onmessage?.({ data: "token" });
    expect(r.data).toEqual([{ generation: 3, remoteId: "c-req", data: "token" }]);
  });

  test("teardownで閉じ、その後のイベントでは通知しない", async () => {
    const { pc, r, session } = build();
    session.accept(offerFrom("c-req", "c-peer"));
    pc.resolveRemote();
    await flush();

    const channel = createFakeChannel("rpc");
    pc.ondatachannel?.({ channel });
    session.teardown();

    expect(pc.closed).toBe(true);
    expect(channel.closed).toBe(true);
    // close()の後にもイベントは飛ぶ。外してあるので何も上がらない
    expect(channel.onopen).toBeNull();
    expect(pc.ondatachannel).toBeNull();

    session.accept(offerFrom("c-req", "c-peer"));
    await flush();
    expect(r.opened).toEqual([]);
    expect(session.openIds()).toEqual([]);
  });
});

describe("createRequesterSession", () => {
  const build = () => {
    const pcs: FakePc[] = [];
    const r = createRecorder();
    const session = createRequesterSession({
      generation: 5,
      myId: "c-req",
      send: r.send,
      callbacks: r.callbacks,
      createConnection: () => {
        const pc = createFakePc();
        pcs.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
    });
    return { pcs, r, session };
  };

  test("startで全peerへofferを出す。自分自身は飛ばす", async () => {
    const { pcs, r, session } = build();
    session.start(["c-a", "c-b", "c-req"]);
    await flush();

    expect(pcs.length).toBe(2);
    expect(pcs.every((pc) => pc.channels[0]?.label === "rpc")).toBe(true);
    const offers = r.sent.filter((m) => m.payload.kind === "offer");
    expect(offers.map((m) => m.targetId)).toEqual(["c-a", "c-b"]);
    expect(offers.every((m) => m.fromId === "c-req")).toBe(true);
    expect(session.expectedIds()).toEqual(["c-a", "c-b"]);
  });

  test("answerを受けてからcandidateを流す", async () => {
    const { pcs, session } = build();
    session.start(["c-a"]);
    await flush();

    session.accept(candidateFrom("c-a", "c-req", iceCandidate("a")));
    await flush();
    expect(pcs[0]?.addedCandidates).toEqual([]);

    session.accept({
      type: "webrtc_signal",
      targetId: "c-req",
      fromId: "c-a",
      payload: { kind: "answer", sdp: "SDP_ANSWER" },
    });
    pcs[0]?.resolveRemote();
    await flush();

    expect(pcs[0]?.remoteDescription).toEqual({ type: "answer", sdp: "SDP_ANSWER" });
    expect(pcs[0]?.addedCandidates.map((c) => c.candidate)).toEqual(["a"]);
  });

  test("全員のDataChannelが開くまで openIds は揃わない", async () => {
    const { pcs, r, session } = build();
    session.start(["c-a", "c-b"]);
    await flush();

    pcs[0]?.channels[0]?.onopen?.();
    expect(session.openIds()).toEqual(["c-a"]);
    expect(session.expectedIds()).toEqual(["c-a", "c-b"]);

    pcs[1]?.channels[0]?.onopen?.();
    expect(session.openIds()).toEqual(["c-a", "c-b"]);
    expect(r.opened).toEqual([
      { generation: 5, remoteId: "c-a" },
      { generation: 5, remoteId: "c-b" },
    ]);
  });

  test("teardownで全接続を閉じる", async () => {
    const { pcs, session } = build();
    session.start(["c-a", "c-b"]);
    await flush();
    session.teardown();

    expect(pcs.every((pc) => pc.closed)).toBe(true);
    expect(pcs.every((pc) => pc.channels[0]?.closed === true)).toBe(true);
    expect(session.expectedIds()).toEqual([]);
  });
});
