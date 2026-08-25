import { describe, expect, test } from "bun:test";
import { createPeerManager } from "./peerManager";
import type { DataChannelLike, WebrtcPeerManager } from "./peerManager";
import { runStubClient, startStubServer } from "./rpcStub";

// ①のWASMの代役(`rpcStub.ts`)同士を、偽のDataChannelで背中合わせに繋ぐ。
// `peerManager.test.ts` が手続きの噛み合いを1手ずつ見るのに対し、こちらは
// C側と同じ呼び方で往復させて、バイト列が壊れずに戻るかを見る。

const REQUESTER_ID = "requester-1";
const PEER_ID = "peer-1";

type Pair = {
  requester: WebrtcPeerManager;
  peer: WebrtcPeerManager;
  stop: () => void;
};

/** 書けば必ず出ていく回線。手続きだけを見るとき用 */
function createDirectPair(): Pair {
  const requester = createPeerManager();
  const peer = createPeerManager();
  const wire = (target: WebrtcPeerManager, from: string): DataChannelLike => ({
    readyState: "open",
    bufferedAmount: 0,
    send: (data) => {
      target.handleMessage(from, data);
    },
  });
  requester.attach(PEER_ID, wire(peer, REQUESTER_ID));
  peer.attach(REQUESTER_ID, wire(requester, PEER_ID));
  return { requester, peer, stop: () => {} };
}

/**
 * 詰まる回線。書いたぶんは `bufferedAmount` に積み上がり、少しずつ掃ける。
 * 実物のDataChannelに近づけて、水位で止まる経路と送り直しを通す。
 */
function createCongestedPair(options: { drainPerTick: number; maxSendQueueBytes: number }): Pair {
  const requester = createPeerManager({ maxSendQueueBytes: options.maxSendQueueBytes });
  const peer = createPeerManager({ maxSendQueueBytes: options.maxSendQueueBytes });
  const timers: ReturnType<typeof setInterval>[] = [];

  const wire = (target: WebrtcPeerManager, from: string): DataChannelLike => {
    const pending: ArrayBuffer[] = [];
    const listeners: (() => void)[] = [];
    const channel: DataChannelLike = {
      readyState: "open",
      bufferedAmount: 0,
      send: (data) => {
        pending.push(data);
        channel.bufferedAmount += data.byteLength;
      },
      addEventListener: (_type, listener) => {
        listeners.push(listener);
      },
      removeEventListener: (_type, listener) => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      },
    };
    timers.push(
      setInterval(() => {
        let budget = options.drainPerTick;
        while (pending.length > 0 && budget > 0) {
          const data = pending.shift();
          if (!data) break;
          channel.bufferedAmount -= data.byteLength;
          budget -= data.byteLength;
          target.handleMessage(from, data);
        }
        if (pending.length === 0) for (const listener of [...listeners]) listener();
      }, 1),
    );
    return channel;
  };

  requester.attach(PEER_ID, wire(peer, REQUESTER_ID));
  peer.attach(REQUESTER_ID, wire(requester, PEER_ID));
  return {
    requester,
    peer,
    stop: () => {
      for (const t of timers) clearInterval(t);
    },
  };
}

describe("WASMの代役でのRPC", () => {
  test("送ったものが加工されて戻る(2往復)", async () => {
    const pair = createDirectPair();
    const server = startStubServer(pair.peer);

    const result = await runStubClient(pair.requester, PEER_ID, {
      size: 512 * 1024,
      rounds: 2,
    });

    expect(result.ok).toBe(true);
    expect(result.rounds).toBe(2);
    expect(server.served()).toBe(2);
    server.stop();
    pair.stop();
  });

  test("論理接続を閉じて開き直しても続けて捌ける", async () => {
    // llama.cppのC側はソケットの開閉を頻繁に繰り返す。その形をなぞる
    const pair = createDirectPair();
    const server = startStubServer(pair.peer);

    for (let i = 0; i < 3; i++) {
      const result = await runStubClient(pair.requester, PEER_ID, { size: 64 * 1024 });
      expect(result.ok).toBe(true);
    }

    expect(server.served()).toBe(3);
    server.stop();
    pair.stop();
  });

  test("詰まった回線でも、送り直しで最後まで届く", async () => {
    // 1往復ぶんに対してキューを小さく取り、部分送信を必ず起こさせる
    const pair = createCongestedPair({
      drainPerTick: 1024 * 1024,
      maxSendQueueBytes: 128 * 1024,
    });
    const server = startStubServer(pair.peer);

    const result = await runStubClient(pair.requester, PEER_ID, { size: 12 * 1024 * 1024 });

    expect(result.ok).toBe(true);
    expect(server.served()).toBe(1);
    server.stop();
    pair.stop();
  });
});

describe("待ち受けの止め方", () => {
  test("stopのあとにserveし直しても、次の接続を捌ける", async () => {
    // 止めるたびにループを立て直すと、捨てたループのaccept待ちが先頭に居座り、
    // 次のCONNECTがそこへ渡って誰も読まないまま止まる
    const pair = createDirectPair();
    const first = startStubServer(pair.peer);
    expect((await runStubClient(pair.requester, PEER_ID, { size: 4096 })).ok).toBe(true);
    first.stop();

    const second = startStubServer(pair.peer);
    expect((await runStubClient(pair.requester, PEER_ID, { size: 4096 })).ok).toBe(true);
    expect(second.served()).toBe(2);

    second.stop();
    pair.stop();
  });

  test("止めているあいだの接続は畳んで返す(相手を待たせない)", async () => {
    const pair = createDirectPair();
    const server = startStubServer(pair.peer);
    server.stop();

    // ACCEPTEDは返るがfdを受け取る者がいない。放置せず畳むので、相手は待ち続けない
    await expect(runStubClient(pair.requester, PEER_ID, { size: 4096 })).rejects.toThrow();

    pair.stop();
  });
});
