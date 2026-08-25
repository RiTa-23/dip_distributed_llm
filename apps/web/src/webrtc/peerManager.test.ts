import { describe, expect, test } from "bun:test";
import { createPeerManager, SEND_HIGH_WATER } from "./peerManager";
import type { DataChannelLike, PeerManagerOptions, WebrtcPeerManager } from "./peerManager";

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

  // 世代が変わると usePeerManager が同じ実体に close() を呼び、次の世代でも使い回す。
  // このとき accept の待機を捨てると、WASM側が Atomics.wait から戻れなくなる
  test("accept待ちのままcloseしても、次の世代で繋ぎ直せばfdが返る", () => {
    const peer = createPeerManager();

    let serverFd = -2;
    // 第1世代: 相手が来る前からWASMは accept で待っている
    peer.accept((fd) => {
      serverFd = fd;
    });
    expect(serverFd).toBe(-2);

    // 世代交代。DataChannelは張り直しになる
    peer.close();
    expect(serverFd).toBe(-2);

    // 第2世代: 新しい回線を付けて、相手からCONNECTが届く
    const accepted: ArrayBuffer[] = [];
    const wire = createWire((data) => accepted.push(data));
    peer.attach(REQUESTER_ID, wire.channel);
    peer.handleMessage(REQUESTER_ID, new Uint8Array([0x01]).buffer);

    expect(serverFd).toBeGreaterThanOrEqual(0);
    expect(peer.openFds()).toEqual([serverFd]);
    // ACCEPTEDを返しているので、相手のconnectも完了する
    expect(accepted.length).toBe(1);
    expect(new Uint8Array(accepted[0] ?? new ArrayBuffer(0))[0]).toBe(0x02);
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

// ---- 送信の水位 ------------------------------------------------------------
//
// 上のテストが使う偽チャンネルは `bufferedAmount` が常に0で、書けば必ず出ていく。
// ここでは詰まった状態を作れる偽チャンネルを使い、水位で止まること・
// 下がったら順に流れることを見る。

type Congestible = {
  channel: DataChannelLike;
  frames: ArrayBuffer[];
  /** 送信バッファが詰まったことにする */
  stall: () => void;
  /** 水位が下がったことにして、待っている側を起こす */
  drain: () => void;
};

/** 詰まった状態を作れる偽チャンネル。`stall` で水位を上げ、`drain` で下げて待っている側を起こす */
function createCongestibleWire(deliver: (data: ArrayBuffer) => void): Congestible {
  const frames: ArrayBuffer[] = [];
  const listeners: (() => void)[] = [];
  const channel: DataChannelLike = {
    readyState: "open",
    bufferedAmount: 0,
    send: (data) => {
      frames.push(data);
      deliver(data);
    },
    addEventListener: (_type, listener) => {
      listeners.push(listener);
    },
    removeEventListener: (_type, listener) => {
      const i = listeners.indexOf(listener);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  return {
    channel,
    frames,
    stall: () => {
      channel.bufferedAmount = SEND_HIGH_WATER + 1;
    },
    drain: () => {
      channel.bufferedAmount = 0;
      for (const listener of [...listeners]) listener();
    },
  };
}

type CongestedPair = {
  requester: WebrtcPeerManager;
  peer: WebrtcPeerManager;
  toPeer: Congestible;
};

/** 発表者→参加者の向きだけを詰まらせた組。上限は発表者側にだけ効かせる */
function createCongestedPair(options: PeerManagerOptions = {}): CongestedPair {
  const requester = createPeerManager(options);
  const peer = createPeerManager();
  const toPeer = createCongestibleWire((data) => {
    peer.handleMessage(REQUESTER_ID, data);
  });
  const toRequester = createWire((data) => {
    requester.handleMessage(PEER_ID, data);
  });
  requester.attach(PEER_ID, toPeer.channel);
  peer.attach(REQUESTER_ID, toRequester.channel);
  return { requester, peer, toPeer };
}

/** connectとacceptを噛み合わせる。createCongestedPair 用 */
function handshakeCongested(pair: CongestedPair): { clientFd: number; serverFd: number } {
  let clientFd = -2;
  let serverFd = -2;
  pair.peer.accept((fd) => {
    serverFd = fd;
  });
  pair.requester.connect(PEER_ID, (fd) => {
    clientFd = fd;
  });
  return { clientFd, serverFd };
}

/** 握手のぶんを除いた、送信フレームのコマンド列 */
function commandsAfter(frames: ArrayBuffer[], from: number): number[] {
  return frames.slice(from).map((f) => new Uint8Array(f)[0] ?? -1);
}

describe("送信の水位", () => {
  test("水位を超えている間は書き込まず、下がったら順に流す", () => {
    const pair = createCongestedPair();
    const { clientFd, serverFd } = handshakeCongested(pair);
    const sentFrames = pair.toPeer.frames.length;

    pair.toPeer.stall();
    const data = pattern(200 * 1024);
    // 呼び出し側から見れば全量を受け取っている(こちらのキューに写してある)
    expect(pair.requester.send(clientFd, data)).toBe(data.byteLength);
    expect(pair.toPeer.frames.length).toBe(sentFrames);

    pair.toPeer.drain();
    expect(pair.toPeer.frames.length).toBeGreaterThan(sentFrames);
    expect(recvNow(pair.peer, serverFd, data.byteLength).bytes).toEqual(data);
  });

  test("キューが埋まったら、受け取れたぶんだけ返す(部分送信)", () => {
    // 2フレームぶんだけ積める大きさにする
    const pair = createCongestedPair({ maxSendQueueBytes: 128 * 1024 });
    const { clientFd, serverFd } = handshakeCongested(pair);

    pair.toPeer.stall();
    const data = pattern(300 * 1024);
    const sent = pair.requester.send(clientFd, data);
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(data.byteLength);

    // 残りは呼び出し側が送り直す。水位が下がっていれば通る
    pair.toPeer.drain();
    expect(pair.requester.send(clientFd, data.subarray(sent))).toBe(data.byteLength - sent);
    expect(recvNow(pair.peer, serverFd, data.byteLength).bytes).toEqual(data);
  });

  test("キューが埋まっていても制御フレームは通る", () => {
    // 1フレームも積めない大きさ。CLOSEまで落とすと相手の論理接続が残る
    const pair = createCongestedPair({ maxSendQueueBytes: 1024 });
    const { clientFd } = handshakeCongested(pair);
    const sentFrames = pair.toPeer.frames.length;

    pair.toPeer.stall();
    expect(pair.requester.send(clientFd, pattern(100 * 1024))).toBe(0);
    expect(pair.requester.close_connection(clientFd)).toBe(0);

    pair.toPeer.drain();
    expect(commandsAfter(pair.toPeer.frames, sentFrames)).toEqual([0x04]);
  });

  test("close_connectionのCLOSEは、積んであるDATAの後ろに並ぶ", () => {
    const pair = createCongestedPair();
    const { clientFd } = handshakeCongested(pair);
    const sentFrames = pair.toPeer.frames.length;

    pair.toPeer.stall();
    // 64KiB境界をまたぐので2フレームになる
    pair.requester.send(clientFd, pattern(100 * 1024));
    pair.requester.close_connection(clientFd);
    expect(pair.toPeer.frames.length).toBe(sentFrames);

    pair.toPeer.drain();
    expect(commandsAfter(pair.toPeer.frames, sentFrames)).toEqual([0x03, 0x03, 0x04]);
  });

  test("相手が落ちたら送り残しは捨てる", () => {
    const pair = createCongestedPair();
    const { clientFd } = handshakeCongested(pair);
    const sentFrames = pair.toPeer.frames.length;

    pair.toPeer.stall();
    pair.requester.send(clientFd, pattern(200 * 1024));
    pair.requester.detach(PEER_ID);

    pair.toPeer.drain();
    expect(pair.toPeer.frames.length).toBe(sentFrames);
  });

  test("世代が変わったら送り残しは捨てる", () => {
    const pair = createCongestedPair();
    const { clientFd } = handshakeCongested(pair);
    const sentFrames = pair.toPeer.frames.length;

    pair.toPeer.stall();
    pair.requester.send(clientFd, pattern(200 * 1024));
    pair.requester.close();

    pair.toPeer.drain();
    expect(pair.toPeer.frames.length).toBe(sentFrames);
  });
});

describe("remoteIds", () => {
  test("回線が閉じた相手は返さない", () => {
    const pm = createPeerManager();
    const channel: DataChannelLike = { readyState: "open", bufferedAmount: 0, send: () => {} };
    pm.attach(PEER_ID, channel);
    expect(pm.remoteIds()).toEqual([PEER_ID]);

    // 相手のタブが閉じた等。detachが来る前でも、宛先として選ばせない
    channel.readyState = "closed";
    expect(pm.remoteIds()).toEqual([]);
  });
});

describe("計測(stats)", () => {
  test("本文のバイト数だけを数える。フレームヘッダと制御フレームは含めない", () => {
    const pair = createPair();
    const { clientFd, serverFd } = handshake(pair, false);

    // 数えるのはここで渡した2000バイトだけ。実際に回線を流れるのは
    // CONNECT・ACCEPTEDの各1バイトと、フレームごとの1バイトのヘッダが余分に乗る
    pair.requester.send(clientFd, pattern(2000));
    recvNow(pair.peer, serverFd, 2000);

    expect(pair.requester.stats.snapshot().bytesSent).toBe(2000);
    expect(pair.requester.stats.snapshot().bytesReceived).toBe(0);
    expect(pair.peer.stats.snapshot().bytesReceived).toBe(2000);
  });

  test("64KiBに分割された送信も、C側の呼び出し1回として数える", () => {
    const pair = createPair();
    const { clientFd, serverFd } = handshake(pair, false);
    const size = 200 * 1024;

    pair.requester.send(clientFd, pattern(size));
    recvNow(pair.peer, serverFd, size);

    // 4フレームに分かれるが、送信側の往復は1回ぶん
    expect(pair.toPeer.length).toBeGreaterThan(4);
    expect(pair.requester.stats.snapshot().bytesSent).toBe(size);
    expect(pair.peer.stats.snapshot().bytesReceived).toBe(size);
  });

  test("受け取って返すたびに処理回数が増える", () => {
    const pair = createPair();
    const { clientFd, serverFd } = handshake(pair, false);

    for (let i = 0; i < 3; i++) {
      // 要求(発表者→参加者)
      pair.requester.send(clientFd, pattern(64));
      recvNow(pair.peer, serverFd, 64);
      // 応答(参加者→発表者)
      pair.peer.send(serverFd, pattern(16));
      recvNow(pair.requester, clientFd, 16);
    }

    // 参加者から見れば「3回処理した」
    expect(pair.peer.stats.snapshot().turns).toBe(3);
  });

  test("接続の手続きだけでは処理回数が増えない", () => {
    const pair = createPair();
    handshake(pair, false);
    expect(pair.peer.stats.snapshot().turns).toBe(0);
    expect(pair.peer.stats.snapshot().lastActivityAt).toBe(null);
  });

  test("相手ごとの内訳が出る", () => {
    const requester = createPeerManager();
    const peerA = createPeerManager();
    const peerB = createPeerManager();

    // 星型なので、発表者は2本の回線を持ち、参加者はそれぞれ1本ずつ持つ
    const toPeerA = createWire((data) => peerA.handleMessage(REQUESTER_ID, data));
    const toPeerB = createWire((data) => peerB.handleMessage(REQUESTER_ID, data));
    requester.attach("peer-a", toPeerA.channel);
    requester.attach("peer-b", toPeerB.channel);
    peerA.attach(
      REQUESTER_ID,
      createWire((data) => requester.handleMessage("peer-a", data)).channel,
    );
    peerB.attach(
      REQUESTER_ID,
      createWire((data) => requester.handleMessage("peer-b", data)).channel,
    );

    let fdA = -1;
    let fdB = -1;
    peerA.accept(() => {});
    peerB.accept(() => {});
    requester.connect("peer-a", (fd) => {
      fdA = fd;
    });
    requester.connect("peer-b", (fd) => {
      fdB = fd;
    });

    requester.send(fdA, pattern(100));
    requester.send(fdB, pattern(300));

    expect(requester.stats.snapshotOf("peer-a").bytesSent).toBe(100);
    expect(requester.stats.snapshotOf("peer-b").bytesSent).toBe(300);
    expect(requester.stats.snapshot().bytesSent).toBe(400);
  });

  test("送れなかったぶんは数えない", () => {
    const pair = createCongestedPair();
    const { clientFd } = handshakeCongested(pair);

    pair.toPeer.stall();
    // キューの上限より大きいものを渡す。受け取れたぶんだけが戻り値になり、
    // 数える値もそれと一致する
    const accepted = pair.requester.send(clientFd, pattern(200 * 1024));

    expect(pair.requester.stats.snapshot().bytesSent).toBe(accepted);
  });
});
