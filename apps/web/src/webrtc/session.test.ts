import { describe, expect, spyOn, test } from "bun:test";
import type { WebrtcSignalMessage } from "@dip_distributed_llm/shared-types/messages";
import {
  attachIceDiagnostics,
  createCandidateQueue,
  createPeerConnectionFactory,
  isStaleAbort,
  isStaleForCurrent,
  toCandidateInit,
} from "./session";
import type { SessionCallbacks } from "./session";
import { buildIceConfig } from "./iceConfig";
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
    // 本物と同じく close() でも onclose が飛ぶ。teardown が受け口を外してから
    // 閉じていること(外し忘れると世代交代のたびに detach が走る)を見るため
    close: () => {
      channel.closed = true;
      channel.onclose?.();
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
  closed: { generation: number; remoteId: string }[];
  data: { generation: number; remoteId: string; data: unknown }[];
  failed: { generation: number; remoteId: string; message: string }[];
  /**
   * onClose / onFailed が上がった順。requester の first-fatal では
   * **onClose(fence → manager 退役)が先**でなければならない。
   */
  order: string[];
  callbacks: SessionCallbacks;
  send: (msg: WebrtcSignalMessage) => void;
};

function createRecorder(): Recorder {
  const r: Recorder = {
    sent: [],
    opened: [],
    closed: [],
    data: [],
    failed: [],
    order: [],
    send: (msg) => {
      r.sent.push(msg);
    },
    callbacks: {
      onOpen: (generation, remoteId) => {
        r.opened.push({ generation, remoteId });
      },
      onClose: (generation, remoteId) => {
        r.closed.push({ generation, remoteId });
        r.order.push("onClose");
      },
      onData: (generation, remoteId, data) => {
        r.data.push({ generation, remoteId, data });
      },
      onFailed: (generation, remoteId, message) => {
        r.failed.push({ generation, remoteId, message });
        r.order.push("onFailed");
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

    // 発表者が落ちた。載っている論理接続を畳ませるため世代つきで上げる
    channel.onclose?.();
    expect(r.closed).toEqual([{ generation: 3, remoteId: "c-req" }]);
    expect(session.openIds()).toEqual([]);
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

  test("予期しないcloseを失敗へ昇格させない(long-lived契約)", async () => {
    // peer で昇格させると `reportPeerError` から `peer_status: "error"` が飛ぶ。
    // 正常な世代交代では「WSの generation_aborted」と「requester の teardown 由来の
    // remote close」が競合し、closeが先着した peer が自分を error にしてしまう。
    // サーバは error の peer を eligiblePeerIds から外すので**次の世代が組めなくなる**。
    const { pc, r, session } = build();
    session.accept(offerFrom("c-req", "c-peer"));
    pc.resolveRemote();
    await flush();

    const channel = createFakeChannel("rpc");
    pc.ondatachannel?.({ channel });
    channel.onopen?.();
    channel.onclose?.();

    expect(r.closed).toEqual([{ generation: 3, remoteId: "c-req" }]);
    expect(r.failed).toEqual([]);
    // 相手ごとの detach 通知のまま。セッションも畳まない
    expect(session.expectedIds()).toEqual(["c-req"]);
  });

  test("connectionState が failed なら、発表者との接続失敗として上げる", async () => {
    // 文言を固定する。TURN を入れた後は `iceTransportPolicy: "all"` なので
    // 「直接接続」限定の言い方にしておけない(relay も候補になり得る)。
    // requester 側は固定済みだったが peer 側が抜けていた
    const { pc, r, session } = build();
    session.accept(offerFrom("c-req", "c-peer"));
    pc.resolveRemote();
    await flush();

    pc.connectionState = "failed";
    pc.onconnectionstatechange?.();

    expect(r.failed).toEqual([
      { generation: 3, remoteId: "c-req", message: "発表者との接続に失敗しました" },
    ]);
    // peer は long-lived。失敗を上げてもセッションは畳まない
    expect(r.closed).toEqual([]);
    expect(session.expectedIds()).toEqual(["c-req"]);
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

  // --- first-fatal(requester の世代致命傷) ---------------------------------
  //
  // RPC device は起動時の `-rpc` 引数で固定されるので、requester は**どの理由であれ
  // 1本失った時点でその世代が続行不能**になる。そこで close / connectionState failed /
  // SDP・ICE の失敗をすべて1本の道へ通し、1セッションにつき1回だけ上げる。
  //
  // 順序が契約: `onClose`(= usePeerManager の fence → manager 退役)が先、
  // `onFailed`(= 画面の初期化と generation_failed)が後。逆だと、畳む前の旧Runtimeが
  // まだ現行の持ち主のまま画面に触れてしまう。

  test("DataChannelが予期せず閉じたら、その世代を畳んで失敗として上げる", async () => {
    const { pcs, r, session } = build();
    session.start(["c-a", "c-b"]);
    await flush();
    pcs[0]?.channels[0]?.onopen?.();
    pcs[1]?.channels[0]?.onopen?.();

    pcs[0]?.channels[0]?.onclose?.();

    expect(r.order).toEqual(["onClose", "onFailed"]);
    expect(r.closed).toEqual([{ generation: 5, remoteId: "c-a" }]);
    expect(r.failed).toEqual([
      { generation: 5, remoteId: "c-a", message: "c-a との回線が切れました" },
    ]);
    // 残った c-b も畳む。もう1人だけでRPCを続けることはできない
    expect(session.openIds()).toEqual([]);
  });

  test("順序は 論理terminal → fence → transport close → drain", async () => {
    // B-2 の ownership の原則(所有権を手放してから壊す)を、物理回線まで含めて固定する。
    //
    // `onClose`(fence → owner.release() → 旧 manager 退役)より先に DataChannel を
    // 閉じてしまうと、**まだ owner token が current で manager も現行のまま**の瞬間に
    // 相手側の回線が消える。`stop()` は termination proof にならず旧Runtimeは
    // pthread 側で並行に動きうるので、その瞬間の send/recv 失敗が現行世代へ流れ込む
    // 余地が残る。論理 terminal(`disposed`)→ fence → 物理close の順なら窓が開かない。
    const { pcs, r, session } = build();
    session.start(["c-a", "c-b"]);
    await flush();
    pcs[0]?.channels[0]?.onopen?.();
    pcs[1]?.channels[0]?.onopen?.();

    // callback の順だけでなく、物理closeがどこに挟まるかも同じ列で見る
    pcs.forEach((pc, index) => {
      const channel = pc.channels[0];
      if (!channel) return;
      const inner = channel.close;
      channel.close = () => {
        r.order.push(`channel-${index}.close`);
        inner();
      };
    });

    pcs[0]?.channels[0]?.onclose?.();

    expect(r.order).toEqual(["onClose", "channel-0.close", "channel-1.close", "onFailed"]);
  });

  test("上げる世代はセッションの世代そのもの(呼び出し側の stale 判定の材料)", async () => {
    const r = createRecorder();
    const pcs: FakePc[] = [];
    const session = createRequesterSession({
      generation: 9,
      myId: "c-req",
      send: r.send,
      callbacks: r.callbacks,
      createConnection: () => {
        const pc = createFakePc();
        pcs.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
    });
    session.start(["c-a"]);
    await flush();
    pcs[0]?.channels[0]?.onopen?.();

    pcs[0]?.channels[0]?.onclose?.();

    expect(r.failed[0]?.generation).toBe(9);
    expect(r.closed[0]?.generation).toBe(9);
  });

  test("AとBが続けて閉じても、畳むのも通知も1回だけ", async () => {
    const { pcs, r, session } = build();
    session.start(["c-a", "c-b"]);
    await flush();
    pcs[0]?.channels[0]?.onopen?.();
    pcs[1]?.channels[0]?.onopen?.();

    const bChannel = pcs[1]?.channels[0];
    pcs[0]?.channels[0]?.onclose?.();

    // 1本目で受け口ごと外すので、2本目の onclose はそもそも飛んでこない
    expect(bChannel?.onclose).toBeNull();
    bChannel?.onclose?.();

    expect(r.closed).toEqual([{ generation: 5, remoteId: "c-a" }]);
    expect(r.failed).toHaveLength(1);
    expect(session.expectedIds()).toEqual([]);
  });

  test("closeの後に connectionState が failed になっても2回目は上げない", async () => {
    const { pcs, r, session } = build();
    session.start(["c-a", "c-b"]);
    await flush();
    pcs[0]?.channels[0]?.onopen?.();
    pcs[1]?.channels[0]?.onopen?.();

    // close で受け口ごと外れるので、後から呼ばれうる関数を先に掴んでおく
    const lateStateChange = pcs[0]?.onconnectionstatechange;
    pcs[0]?.channels[0]?.onclose?.();
    expect(r.failed).toHaveLength(1);

    const pc = pcs[0];
    if (pc) pc.connectionState = "failed";
    expect(pc?.onconnectionstatechange).toBeNull();
    lateStateChange?.();

    // 同じ世代で generation_failed を2回送らない
    expect(r.failed).toHaveLength(1);
    expect(r.closed).toHaveLength(1);
    expect(r.order).toEqual(["onClose", "onFailed"]);
  });

  test("connectionState が failed のときも onClose が先に上がる", async () => {
    const { pcs, r, session } = build();
    session.start(["c-a"]);
    await flush();
    pcs[0]?.channels[0]?.onopen?.();

    const pc = pcs[0];
    if (pc) pc.connectionState = "failed";
    pc?.onconnectionstatechange?.();

    // ここを onFailed だけにすると fence を通らず、旧Runtimeが現行の持ち主のまま残る
    expect(r.order).toEqual(["onClose", "onFailed"]);
    expect(r.failed).toEqual([
      { generation: 5, remoteId: "c-a", message: "c-a との接続に失敗しました" },
    ]);
  });

  test("offerを作れなかったときも同じ道を1回だけ通る", async () => {
    const r = createRecorder();
    const pcs: FakePc[] = [];
    const session = createRequesterSession({
      generation: 5,
      myId: "c-req",
      send: r.send,
      callbacks: r.callbacks,
      createConnection: () => {
        const pc = createFakePc();
        pc.createOffer = () => Promise.reject(new Error("offerに失敗"));
        pcs.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
    });

    session.start(["c-a", "c-b"]);
    await flush();

    // 2人ぶん失敗しても、世代の失敗は1回
    expect(pcs).toHaveLength(2);
    expect(r.order).toEqual(["onClose", "onFailed"]);
    expect(r.failed).toEqual([{ generation: 5, remoteId: "c-a", message: "offerに失敗" }]);
  });

  test("次の世代のセッションなら、また1回上げられる", async () => {
    const first = build();
    first.session.start(["c-a"]);
    await flush();
    first.pcs[0]?.channels[0]?.onopen?.();
    first.pcs[0]?.channels[0]?.onclose?.();
    expect(first.r.failed).toHaveLength(1);

    const second = build();
    second.session.start(["c-a"]);
    await flush();
    second.pcs[0]?.channels[0]?.onopen?.();
    second.pcs[0]?.channels[0]?.onclose?.();

    expect(second.r.failed).toHaveLength(1);
  });

  // --- first-fatal の後は terminal state -----------------------------------
  //
  // `fatal` を立てるだけでは受け口が生きたまま残る。呼び出し側の世代番号は次の
  // `generation_start` まで動かないので `isStaleForCurrent` も素通しし、
  // **onClose で mint されたばかりの新しい PeerManager へ、死んだ世代の回線が
  // attach されてしまう**。だから first-fatal でセッションごと閉じる。

  test("first-fatalの後、遅れて開いたDataChannelは通さない", async () => {
    const { pcs, r, session } = build();
    session.start(["c-a", "c-b"]);
    await flush();
    pcs[0]?.channels[0]?.onopen?.(); // c-a だけ開通。c-b はまだ

    const lateChannel = pcs[1]?.channels[0];
    pcs[0]?.channels[0]?.onclose?.();

    expect(lateChannel?.onopen).toBeNull();
    lateChannel?.onopen?.();

    // 通すと、退役済みの世代の回線が新しい manager へ attach される
    expect(r.opened).toEqual([{ generation: 5, remoteId: "c-a" }]);
    expect(pcs.every((pc) => pc.closed)).toBe(true);
    expect(pcs.every((pc) => pc.channels[0]?.closed === true)).toBe(true);
    expect(session.openIds()).toEqual([]);
    expect(session.expectedIds()).toEqual([]);
  });

  test("first-fatalの後、遅れて届いたデータは通さない", async () => {
    const { pcs, r, session } = build();
    session.start(["c-a", "c-b"]);
    await flush();
    pcs[0]?.channels[0]?.onopen?.();
    pcs[1]?.channels[0]?.onopen?.();

    const survivor = pcs[1]?.channels[0];
    pcs[0]?.channels[0]?.onclose?.();

    expect(survivor?.onmessage).toBeNull();
    survivor?.onmessage?.({ data: new Uint8Array([1]) });

    // 通すと、旧Runtime宛のRPC応答を新しい manager が処理してしまう
    expect(r.data).toEqual([]);
    void session;
  });

  test("first-fatalの後は signaling を受け付けず、ICE candidate も送らない", async () => {
    const { pcs, r, session } = build();
    session.start(["c-a"]);
    await flush();
    const sentAfterOffer = r.sent.length;

    const pc = pcs[0];
    const lateIce = pc?.onicecandidate;
    pc?.channels[0]?.onopen?.();
    pc?.channels[0]?.onclose?.();

    expect(pc?.onicecandidate).toBeNull();
    lateIce?.({
      candidate: { toJSON: () => ({ candidate: "late" }) } as unknown as RTCIceCandidate,
    });

    session.accept({
      type: "webrtc_signal",
      targetId: "c-req",
      fromId: "c-a",
      payload: { kind: "answer", sdp: "SDP_ANSWER" },
    });
    session.accept(candidateFrom("c-a", "c-req", iceCandidate("late")));
    await flush();

    // 接続を進めてしまうと、また開通して上の2件へ戻る
    expect(r.sent).toHaveLength(sentAfterOffer);
    expect(pc?.remoteDescription).toBeNull();
    expect(pc?.addedCandidates).toEqual([]);
  });

  test("teardownではonCloseもonFailedも上げない(受け口を外してから閉じている)", async () => {
    const { pcs, r, session } = build();
    session.start(["c-a", "c-b"]);
    await flush();
    pcs[0]?.channels[0]?.onopen?.();

    // 正常な世代交代・離脱の経路。掴んだままの参照から後で呼ばれても増えない
    const lateStateChange = pcs[0]?.onconnectionstatechange;
    const lateChannel = pcs[0]?.channels[0];
    session.teardown();

    lateChannel?.onclose?.();
    const pc = pcs[0];
    if (pc) pc.connectionState = "failed";
    lateStateChange?.();

    // 世代交代のたびに detach が走ると、後続の close() と二重に畳むことになる
    expect(r.closed).toEqual([]);
    // ここで上げると、正常な再編成のたびに generation_failed を送って abort ループになる
    expect(r.failed).toEqual([]);
    expect(r.order).toEqual([]);
  });
});

// --- ICEの配線 ---------------------------------------------------------------
//
// `iceConfig.test.ts` が見ているのは「envからRTCConfigurationを組む」ところまで。
// **組んだconfigがコンストラクタまで届くか**は別の話で、そこが切れていても
// iceConfigのテストは全部通ってしまう。bun testではenvが空なので実物の
// `defaultPeerConnectionFactory` からは確かめられない。そこで配線だけを切り出して、
// TURN入りのconfigと偽コンストラクタで固定する。

type CtorCall = { config?: RTCConfiguration };

function fakeCtor() {
  const calls: CtorCall[] = [];
  class FakePeerConnection {
    constructor(config?: RTCConfiguration) {
      calls.push({ config });
    }
  }
  return { calls, Ctor: FakePeerConnection as unknown as typeof RTCPeerConnection };
}

const TURN_ENV_FULL = {
  urls: "turn:192.168.1.146:3478?transport=udp,turn:192.168.1.146:3478?transport=tcp",
  username: "dip",
  credential: "s3cr3t-must-not-leak",
};

describe("createPeerConnectionFactory", () => {
  test("組んだTURN設定がそのままコンストラクタへ渡る", () => {
    const { calls, Ctor } = fakeCtor();
    const factory = createPeerConnectionFactory(buildIceConfig(TURN_ENV_FULL), Ctor);

    const pc = factory();

    expect(calls).toHaveLength(1);
    const config = calls[0]?.config;
    expect(config?.iceServers).toEqual([
      {
        urls: ["turn:192.168.1.146:3478?transport=udp", "turn:192.168.1.146:3478?transport=tcp"],
        username: "dip",
        credential: "s3cr3t-must-not-leak",
      },
    ]);
    // 既定は all。ICEにhost/relayを選ばせる
    expect(config?.iceTransportPolicy).toBe("all");
    expect(pc).toBeInstanceOf(Ctor);
  });

  test("forceRelay の policy もコンストラクタまで届く", () => {
    const { calls, Ctor } = fakeCtor();
    createPeerConnectionFactory(buildIceConfig({ ...TURN_ENV_FULL, forceRelay: "1" }), Ctor)();

    expect(calls[0]?.config?.iceTransportPolicy).toBe("relay");
  });

  test("TURN未設定なら空のiceServersが渡る(従来どおり)", () => {
    const { calls, Ctor } = fakeCtor();
    createPeerConnectionFactory(buildIceConfig({}), Ctor)();

    expect(calls[0]?.config?.iceServers).toEqual([]);
    expect(calls[0]?.config?.iceTransportPolicy).toBe("all");
  });

  test("呼ぶたびに新しいPeerConnectionを作る(世代ごとに使い回さない)", () => {
    const { calls, Ctor } = fakeCtor();
    const factory = createPeerConnectionFactory(buildIceConfig({}), Ctor);

    expect(factory()).not.toBe(factory());
    expect(calls).toHaveLength(2);
  });
});

type FakeDiagPc = {
  connectionState: RTCPeerConnectionState;
  listeners: Map<string, () => void>;
  removed: string[];
  addEventListener: (type: string, fn: () => void) => void;
  removeEventListener: (type: string, fn: () => void) => void;
  getStats: () => Promise<Map<string, unknown>>;
};

function fakeDiagPc(getStats: () => Promise<Map<string, unknown>>): FakeDiagPc {
  const pc: FakeDiagPc = {
    connectionState: "new",
    listeners: new Map(),
    removed: [],
    addEventListener: (type, fn) => {
      pc.listeners.set(type, fn);
    },
    removeEventListener: (type) => {
      pc.removed.push(type);
    },
    getStats,
  };
  return pc;
}

const relayStats = () =>
  new Map<string, unknown>([
    ["T1", { type: "transport", selectedCandidatePairId: "P1" }],
    [
      "P1",
      { type: "candidate-pair", localCandidateId: "L1", remoteCandidateId: "R1", selected: true },
    ],
    ["L1", { type: "local-candidate", candidateType: "relay", protocol: "udp" }],
    ["R1", { type: "remote-candidate", candidateType: "relay", protocol: "udp" }],
  ]);

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

/** 解決の時点をテストから決められる Promise。in-flight の getStats を作るのに使う */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** マイクロタスクと setTimeout(0) を数回ぶん流す(retry の連鎖を進めるため) */
async function flushTimers(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await flush();
}

type SpyCalls = { mock: { calls: readonly (readonly unknown[])[] } };

const routeLogsIn = (spy: SpyCalls) =>
  spy.mock.calls.filter((c) => String(c[0]).includes("selected ICE route"));

const unavailableLogsIn = (spy: SpyCalls) =>
  spy.mock.calls.filter((c) => String(c[0]).includes("ICE route unavailable"));

describe("attachIceDiagnostics", () => {
  test("addEventListener を持たない偽PeerConnectionでも落ちない", () => {
    // 既存のセッションテストは受け口だけ備えた偽物を挿している。診断で落としてはいけない
    const detach = attachIceDiagnostics({} as unknown as RTCPeerConnection);
    expect(() => detach()).not.toThrow();
  });

  test("後始末で両方のリスナを外す", () => {
    const pc = fakeDiagPc(async () => relayStats());
    const detach = attachIceDiagnostics(pc as unknown as RTCPeerConnection);

    expect([...pc.listeners.keys()].sort()).toEqual(["connectionstatechange", "icecandidateerror"]);

    detach();

    expect(pc.removed.sort()).toEqual(["connectionstatechange", "icecandidateerror"]);
  });

  test("connected になった1回だけ経路を出す", async () => {
    const info = spyOn(console, "info").mockImplementation(() => {});
    try {
      const pc = fakeDiagPc(async () => relayStats());
      attachIceDiagnostics(pc as unknown as RTCPeerConnection);
      const onState = pc.listeners.get("connectionstatechange");

      // connected 以外では読まない
      pc.connectionState = "connecting";
      onState?.();
      pc.connectionState = "connected";
      onState?.();
      onState?.();
      await flush();

      const routeLogs = info.mock.calls.filter((c) => String(c[0]).includes("selected ICE route"));
      expect(routeLogs).toHaveLength(1);
      expect(routeLogs[0]?.[1]).toEqual({
        localType: "relay",
        remoteType: "relay",
        protocol: "udp",
      });
    } finally {
      info.mockRestore();
    }
  });

  test("リトライ無しなら getStats は1回。失敗しても投げない", async () => {
    // 畳んでいる最中の PeerConnection では getStats() は普通に失敗する。
    // 握らないと unhandled rejection になる。retry の本数はここでは見ないので
    // `retryDelaysMs: []` を明示して「1回だけ」を固定する
    let called = 0;
    const pc = fakeDiagPc(() => {
      called += 1;
      return Promise.reject(new Error("closed"));
    });
    attachIceDiagnostics(pc as unknown as RTCPeerConnection, []);

    pc.connectionState = "connected";
    expect(() => pc.listeners.get("connectionstatechange")?.()).not.toThrow();
    await flushTimers();

    expect(called).toBe(1);
  });

  test("1回目で読めなくても、再試行して読めた時点で1回だけ出す", async () => {
    // connected 直後はまだ selected pair が stats に無いことがある。1回勝負にすると、
    // WebRTC は正常なのに経路ログだけ出ない — 実験の証拠として使えなくなる
    const info = spyOn(console, "info").mockImplementation(() => {});
    try {
      let calls = 0;
      const pc = fakeDiagPc(async () => {
        calls += 1;
        return calls >= 3 ? relayStats() : new Map<string, unknown>();
      });
      attachIceDiagnostics(pc as unknown as RTCPeerConnection, [0, 0, 0]);

      pc.connectionState = "connected";
      pc.listeners.get("connectionstatechange")?.();
      await flushTimers();

      expect(calls).toBe(3);
      expect(routeLogsIn(info)).toHaveLength(1);
    } finally {
      info.mockRestore();
    }
  });

  test("最後まで読めなければ warn を1回出す(info は出さない)", async () => {
    // 黙ると「そもそも connected になっていない」のか「読めなかった」のか区別できない
    const info = spyOn(console, "info").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      let calls = 0;
      const pc = fakeDiagPc(async () => {
        calls += 1;
        return new Map<string, unknown>();
      });
      attachIceDiagnostics(pc as unknown as RTCPeerConnection, [0, 0, 0]);

      pc.connectionState = "connected";
      pc.listeners.get("connectionstatechange")?.();
      await flushTimers();

      expect(calls).toBe(4); // 即時1回 + retry 3回
      expect(unavailableLogsIn(warn)).toHaveLength(1);
      expect(routeLogsIn(info)).toHaveLength(0);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  test("後始末したあとは、待っていた再試行が発火しない", async () => {
    let calls = 0;
    const pc = fakeDiagPc(async () => {
      calls += 1;
      return new Map<string, unknown>();
    });
    const detach = attachIceDiagnostics(pc as unknown as RTCPeerConnection, [5, 5, 5]);

    pc.connectionState = "connected";
    pc.listeners.get("connectionstatechange")?.();
    await flush();
    expect(calls).toBe(1);

    detach();
    await flushTimers();

    expect(calls).toBe(1);
  });

  test("後始末したあとに getStats が解決しても、何も出さない", async () => {
    // **clearTimeout では既に飛んでいる getStats() を止められない。** 止めそこねると、
    // 畳んだはずの PeerConnection の経路が次の世代の最中にログへ出る
    const info = spyOn(console, "info").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pending = deferred<Map<string, unknown>>();
      const pc = fakeDiagPc(() => pending.promise);
      const detach = attachIceDiagnostics(pc as unknown as RTCPeerConnection, [0, 0, 0]);

      pc.connectionState = "connected";
      pc.listeners.get("connectionstatechange")?.();

      detach(); // getStats は未解決のまま
      pending.resolve(relayStats());
      await flushTimers();

      expect(routeLogsIn(info)).toHaveLength(0);
      expect(unavailableLogsIn(warn)).toHaveLength(0);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  test("connected を離れると run が失効し、戻れば新しい run が始まる", async () => {
    const info = spyOn(console, "info").mockImplementation(() => {});
    try {
      let calls = 0;
      const pc = fakeDiagPc(async () => {
        calls += 1;
        return relayStats();
      });
      attachIceDiagnostics(pc as unknown as RTCPeerConnection, [0, 0, 0]);
      const onState = pc.listeners.get("connectionstatechange");

      pc.connectionState = "disconnected";
      onState?.();
      expect(calls).toBe(0);

      pc.connectionState = "connected";
      onState?.();
      await flushTimers();

      expect(calls).toBe(1);
      expect(routeLogsIn(info)).toHaveLength(1);
    } finally {
      info.mockRestore();
    }
  });

  test("古い run が遅れて解決しても、繋ぎ直した新しい run を潰さない", async () => {
    // 古い run が await の後に共有状態(running / timer / reported)を書くと、
    // 新しい run の直列制御が壊れて二重に走る
    const info = spyOn(console, "info").mockImplementation(() => {});
    try {
      const pending: Deferred<Map<string, unknown>>[] = [];
      let calls = 0;
      const pc = fakeDiagPc(() => {
        calls += 1;
        const d = deferred<Map<string, unknown>>();
        pending.push(d);
        return d.promise;
      });
      attachIceDiagnostics(pc as unknown as RTCPeerConnection, [0, 0, 0]);
      const onState = pc.listeners.get("connectionstatechange");

      // 1本目。getStats は未解決のまま
      pc.connectionState = "connected";
      onState?.();
      expect(calls).toBe(1);

      // 切れて、繋ぎ直る。1本目は失効し、2本目が始まる
      pc.connectionState = "disconnected";
      onState?.();
      pc.connectionState = "connected";
      onState?.();
      expect(calls).toBe(2);

      // **古い方**が遅れて解決する。共有状態に触ってはいけない
      pending[0]?.resolve(new Map<string, unknown>());
      await flushTimers();

      // ここが要。古い run が running を落としていれば、次の connected で3本目が走る
      onState?.();
      expect(calls).toBe(2);

      // 2本目は生きている。読めれば1回だけ出す
      pending[1]?.resolve(relayStats());
      await flushTimers();

      expect(routeLogsIn(info)).toHaveLength(1);
    } finally {
      info.mockRestore();
    }
  });
});
