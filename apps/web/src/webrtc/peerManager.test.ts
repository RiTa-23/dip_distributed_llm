import { describe, expect, test } from "bun:test";
import { createPeerManager } from "./peerManager";
import type { DataChannelLike, WebrtcPeerManager } from "./peerManager";

// 2つのPeerManagerを偽のDataChannelで背中合わせに繋ぎ、
// llmletのRPCパッチが呼ぶ順番(connect/accept → send/recv → close)をなぞる。
// 実物のDataChannelは非同期だが、届く順番は保証されるので、
// テストでは同期で流して手続きの噛み合いだけを見る。

type Wire = {
  channel: DataChannelLike;
  /** 送られたフレームの生データ。分割の検証用 */
  frames: ArrayBuffer[];
};

function createWire(deliver: (data: ArrayBuffer) => void): Wire {
  const frames: ArrayBuffer[] = [];
  const channel: DataChannelLike = {
    readyState: "open",
    bufferedAmount: 0,
    send: (data) => {
      frames.push(data);
      deliver(data);
    },
  };
  return { channel, frames };
}

type Pair = {
  requester: WebrtcPeerManager;
  peer: WebrtcPeerManager;
  /** requester→peer に流れたフレーム */
  toPeer: ArrayBuffer[];
  /** peer→requester に流れたフレーム */
  toRequester: ArrayBuffer[];
};

const REQUESTER_ID = "requester-1";
const PEER_ID = "peer-1";

function createPair(): Pair {
  const requester = createPeerManager();
  const peer = createPeerManager();

  const toPeer = createWire((data) => peer.handleMessage(REQUESTER_ID, data));
  const toRequester = createWire((data) => requester.handleMessage(PEER_ID, data));

  requester.attach(PEER_ID, toPeer.channel);
  peer.attach(REQUESTER_ID, toRequester.channel);

  return {
    requester,
    peer,
    toPeer: toPeer.frames,
    toRequester: toRequester.frames,
  };
}

/** connectとacceptを噛み合わせて、両側のfdを返す */
function handshake(pair: Pair, acceptFirst: boolean): { clientFd: number; serverFd: number } {
  let clientFd = -2;
  let serverFd = -2;
  const doConnect = () => {
    pair.requester.connect(PEER_ID, (fd) => {
      clientFd = fd;
    });
  };
  const doAccept = () => {
    pair.peer.accept((fd) => {
      serverFd = fd;
    });
  };
  if (acceptFirst) {
    doAccept();
    doConnect();
  } else {
    doConnect();
    doAccept();
  }
  return { clientFd, serverFd };
}

/** recvを同期的に呼んで、集まったバイト列と成否を返す */
function recvNow(
  pm: WebrtcPeerManager,
  fd: number,
  len: number,
): { done: boolean; ok: boolean; bytes: Uint8Array } {
  const chunks: Uint8Array[] = [];
  let done = false;
  let ok = false;
  pm.recv(
    fd,
    len,
    (chunk) => chunks.push(new Uint8Array(chunk)),
    (result) => {
      done = true;
      ok = result;
    },
  );
  return { done, ok, bytes: concat(chunks) };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function pattern(size: number): Uint8Array {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = i % 251;
  return data;
}

describe("接続の確立", () => {
  test("acceptが先でもconnectが先でも、両側にfdが渡る", () => {
    for (const acceptFirst of [true, false]) {
      const pair = createPair();
      const { clientFd, serverFd } = handshake(pair, acceptFirst);
      expect(clientFd).toBeGreaterThanOrEqual(0);
      expect(serverFd).toBeGreaterThanOrEqual(0);
    }
  });

  test("acceptは-1を返さない(WASM側の番兵と衝突して止まるため)", () => {
    const pair = createPair();
    const { serverFd } = handshake(pair, true);
    expect(serverFd).not.toBe(-1);
  });

  test("知らない相手へのconnectは-1", () => {
    const pair = createPair();
    let fd = -2;
    pair.requester.connect("いない人", (v) => {
      fd = v;
    });
    expect(fd).toBe(-1);
  });

  test("閉じたDataChannelへのconnectは-1", () => {
    const requester = createPeerManager();
    const channel: DataChannelLike = {
      readyState: "closed",
      bufferedAmount: 0,
      send: () => {},
    };
    requester.attach(PEER_ID, channel);
    let fd = -2;
    requester.connect(PEER_ID, (v) => {
      fd = v;
    });
    expect(fd).toBe(-1);
  });
});

describe("送受信", () => {
  test("送ったぶんがそのまま読める", () => {
    const pair = createPair();
    const { clientFd, serverFd } = handshake(pair, true);

    const data = pattern(1000);
    expect(pair.requester.send(clientFd, data)).toBe(1000);

    const received = recvNow(pair.peer, serverFd, 4096);
    expect(received.done).toBe(true);
    expect(received.ok).toBe(true);
    expect(received.bytes).toEqual(data);
  });

  test("64KiBを超えるぶんは分割して送り、受け側で繋がる", () => {
    const pair = createPair();
    const { clientFd, serverFd } = handshake(pair, true);
    pair.toPeer.length = 0;

    const size = 200_000;
    const data = pattern(size);
    expect(pair.requester.send(clientFd, data)).toBe(size);

    // 本文の上限は 64KiB - ヘッダ1バイト
    const chunk = 64 * 1024 - 1;
    expect(pair.toPeer.length).toBe(Math.ceil(size / chunk));
    for (const frame of pair.toPeer) {
      expect(frame.byteLength).toBeLessThanOrEqual(64 * 1024);
    }

    const received = recvNow(pair.peer, serverFd, size);
    expect(received.ok).toBe(true);
    expect(received.bytes).toEqual(data);
  });

  test("要求より多く届いていれば、要求ぶんだけ返して残りは次に回る", () => {
    const pair = createPair();
    const { clientFd, serverFd } = handshake(pair, true);

    pair.requester.send(clientFd, pattern(100));

    const first = recvNow(pair.peer, serverFd, 40);
    expect(first.bytes.byteLength).toBe(40);

    const second = recvNow(pair.peer, serverFd, 1000);
    expect(second.bytes.byteLength).toBe(60);
    expect(concat([first.bytes, second.bytes])).toEqual(pattern(100));
  });

  test("何も届いていなければ、届くまでdoneCBを呼ばない", () => {
    const pair = createPair();
    const { clientFd, serverFd } = handshake(pair, true);

    const chunks: Uint8Array[] = [];
    let done = false;
    pair.peer.recv(
      serverFd,
      4096,
      (chunk) => chunks.push(new Uint8Array(chunk)),
      () => {
        done = true;
      },
    );
    // ここでWASM側は Atomics.wait で止まっている
    expect(done).toBe(false);

    pair.requester.send(clientFd, pattern(10));
    expect(done).toBe(true);
    expect(concat(chunks)).toEqual(pattern(10));
  });

  test("知らないfdへのsendは-1、recvは失敗", () => {
    const pair = createPair();
    expect(pair.requester.send(999, pattern(4))).toBe(-1);
    const received = recvNow(pair.requester, 999, 16);
    expect(received.done).toBe(true);
    expect(received.ok).toBe(false);
  });
});

describe("切断", () => {
  test("close_connectionは相手側のfdも畳む", () => {
    const pair = createPair();
    const { clientFd, serverFd } = handshake(pair, true);
    expect(pair.peer.openFds()).toContain(serverFd);

    expect(pair.requester.close_connection(clientFd)).toBe(0);
    expect(pair.requester.openFds()).not.toContain(clientFd);
    expect(pair.peer.openFds()).not.toContain(serverFd);
  });

  test("待たせているrecvは、相手が閉じたら失敗で返る", () => {
    const pair = createPair();
    const { clientFd, serverFd } = handshake(pair, true);

    let done = false;
    let ok = true;
    pair.peer.recv(
      serverFd,
      4096,
      () => {},
      (result) => {
        done = true;
        ok = result;
      },
    );
    expect(done).toBe(false);

    pair.requester.close_connection(clientFd);
    expect(done).toBe(true);
    expect(ok).toBe(false);
  });

  test("detachでその相手のfdが落ちる", () => {
    const pair = createPair();
    const { clientFd } = handshake(pair, true);
    pair.requester.detach(PEER_ID);
    expect(pair.requester.openFds()).not.toContain(clientFd);
  });

  test("閉じたあと同じ相手へ張り直せる", () => {
    const pair = createPair();
    const first = handshake(pair, true);
    pair.requester.close_connection(first.clientFd);

    const second = handshake(pair, true);
    expect(second.clientFd).toBeGreaterThanOrEqual(0);
    expect(second.serverFd).toBeGreaterThanOrEqual(0);

    const data = pattern(64);
    pair.requester.send(second.clientFd, data);
    expect(recvNow(pair.peer, second.serverFd, 256).bytes).toEqual(data);
  });

  test("closeで全部落ちる", () => {
    const pair = createPair();
    handshake(pair, true);
    pair.requester.close();
    expect(pair.requester.openFds()).toEqual([]);
  });
});

describe("送信が失敗したとき", () => {
  test("ACCEPTEDを返せなければfdを渡さず、acceptは待ち続ける", () => {
    const errors: string[] = [];
    const requester = createPeerManager();
    const peer = createPeerManager({ onError: (m) => errors.push(m) });

    // peer側のDataChannelだけ、途中まで例外を投げるようにする
    let broken = true;
    const toRequester: DataChannelLike = {
      readyState: "open",
      bufferedAmount: 0,
      send: (data) => {
        if (broken) throw new Error("送信できません");
        requester.handleMessage(PEER_ID, data);
      },
    };
    const toPeer = createWire((data) => peer.handleMessage(REQUESTER_ID, data));
    requester.attach(PEER_ID, toPeer.channel);
    peer.attach(REQUESTER_ID, toRequester);

    let serverFd = -2;
    peer.accept((fd) => {
      serverFd = fd;
    });
    requester.connect(PEER_ID, () => {});

    // fdは渡らず、論理接続も残らない
    expect(serverFd).toBe(-2);
    expect(peer.openFds()).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);

    // 待機は保たれているので、次の着信で成立する
    broken = false;
    requester.connect(PEER_ID, () => {});
    expect(serverFd).toBeGreaterThanOrEqual(0);
  });
});

describe("受信キューの上限", () => {
  test("溜まりすぎたら接続を畳み、待たせているrecvは失敗で返る", () => {
    const errors: string[] = [];
    const requester = createPeerManager();
    const peer = createPeerManager({ maxRecvQueueBytes: 100, onError: (m) => errors.push(m) });
    const toPeer = createWire((data) => peer.handleMessage(REQUESTER_ID, data));
    const toRequester = createWire((data) => requester.handleMessage(PEER_ID, data));
    requester.attach(PEER_ID, toPeer.channel);
    peer.attach(REQUESTER_ID, toRequester.channel);

    let clientFd = -2;
    let serverFd = -2;
    peer.accept((fd) => {
      serverFd = fd;
    });
    requester.connect(PEER_ID, (fd) => {
      clientFd = fd;
    });

    // 何も届いていないので、recvは待ちに入る
    let done = false;
    let ok = true;
    peer.recv(
      serverFd,
      10,
      () => {},
      (result) => {
        done = true;
        ok = result;
      },
    );
    expect(done).toBe(false);

    // 上限を超えるぶんが届いた時点で畳まれる
    requester.send(clientFd, pattern(200));
    expect(errors.length).toBeGreaterThan(0);
    expect(peer.openFds()).not.toContain(serverFd);
    expect(done).toBe(true);
    expect(ok).toBe(false);
  });

  test("読まれないまま積み上がったぶんも合算される", () => {
    const requester = createPeerManager();
    const peer = createPeerManager({ maxRecvQueueBytes: 100 });
    const toPeer = createWire((data) => peer.handleMessage(REQUESTER_ID, data));
    const toRequester = createWire((data) => requester.handleMessage(PEER_ID, data));
    requester.attach(PEER_ID, toPeer.channel);
    peer.attach(REQUESTER_ID, toRequester.channel);

    let clientFd = -2;
    let serverFd = -2;
    peer.accept((fd) => {
      serverFd = fd;
    });
    requester.connect(PEER_ID, (fd) => {
      clientFd = fd;
    });

    // 1回では踏まないが、読まないまま2回目で超える
    requester.send(clientFd, pattern(60));
    expect(peer.openFds()).toContain(serverFd);
    requester.send(clientFd, pattern(60));
    expect(peer.openFds()).not.toContain(serverFd);
  });

  test("読み出したぶんは上限の計算から外れる", () => {
    const requester = createPeerManager();
    const peer = createPeerManager({ maxRecvQueueBytes: 100 });
    const toPeer = createWire((data) => peer.handleMessage(REQUESTER_ID, data));
    const toRequester = createWire((data) => requester.handleMessage(PEER_ID, data));
    requester.attach(PEER_ID, toPeer.channel);
    peer.attach(REQUESTER_ID, toRequester.channel);

    let clientFd = -2;
    let serverFd = -2;
    peer.accept((fd) => {
      serverFd = fd;
    });
    requester.connect(PEER_ID, (fd) => {
      clientFd = fd;
    });

    // 60溜めて全部読む → 残りは0
    requester.send(clientFd, pattern(60));
    expect(recvNow(peer, serverFd, 60).bytes.byteLength).toBe(60);

    // 空になっているので、また60送っても踏まない
    requester.send(clientFd, pattern(60));
    expect(peer.openFds()).toContain(serverFd);
  });
});

describe("register_buf", () => {
  test("登録した番地は接続を畳むときに解放される", () => {
    const released: number[] = [];
    const requester = createPeerManager({ releaseBuf: (ptr) => released.push(ptr) });
    const peer = createPeerManager();
    const toPeer = createWire((data) => peer.handleMessage(REQUESTER_ID, data));
    const toRequester = createWire((data) => requester.handleMessage(PEER_ID, data));
    requester.attach(PEER_ID, toPeer.channel);
    peer.attach(REQUESTER_ID, toRequester.channel);

    let clientFd = -2;
    peer.accept(() => {});
    requester.connect(PEER_ID, (fd) => {
      clientFd = fd;
    });

    requester.register_buf(clientFd, 0x1234);
    requester.close_connection(clientFd);
    expect(released).toEqual([0x1234]);
  });
});
