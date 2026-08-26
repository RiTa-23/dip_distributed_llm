import { describe, expect, test } from "bun:test";
import { createPeerStats, median } from "./peerStats";
import type { PeerStats } from "./peerStats";

// 時計を手で進めて、往復の数え方と応答時間を決定的に確かめる。
// 実物では performance.now() が入る。

const PEER = "peer-1";

function withClock(): { stats: PeerStats; advance: (ms: number) => void } {
  let t = 0;
  const stats = createPeerStats(() => t);
  return {
    stats,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe("median", () => {
  test("空なら null", () => {
    expect(median([])).toBe(null);
  });

  test("奇数個は真ん中、偶数個は中央2つの平均", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  test("並べ替えても結果は変わらない(呼び出し側の配列を壊さない)", () => {
    const values = [5, 1, 4];
    expect(median(values)).toBe(4);
    expect(values).toEqual([5, 1, 4]);
  });
});

describe("バイト数", () => {
  test("受信と送信を別々に積む", () => {
    const { stats } = withClock();
    stats.onReceived(PEER, 100);
    stats.onReceived(PEER, 50);
    stats.onSent(PEER, 10);

    const snapshot = stats.snapshot();
    expect(snapshot.bytesReceived).toBe(150);
    expect(snapshot.bytesSent).toBe(10);
  });

  test("相手ごとの内訳と合計の両方が出る", () => {
    const { stats } = withClock();
    stats.onReceived("a", 100);
    stats.onReceived("b", 300);

    expect(stats.snapshotOf("a").bytesReceived).toBe(100);
    expect(stats.snapshotOf("b").bytesReceived).toBe(300);
    expect(stats.snapshot().bytesReceived).toBe(400);
    expect(stats.remoteIds().sort()).toEqual(["a", "b"]);
  });

  test("知らない相手を聞かれても0を返す", () => {
    const { stats } = withClock();
    expect(stats.snapshotOf("いない").bytesReceived).toBe(0);
    expect(stats.snapshotOf("いない").responseMs).toBe(null);
  });
});

describe("処理回数(受信→送信の反転)", () => {
  test("1往復で1回", () => {
    const { stats } = withClock();
    stats.onReceived(PEER, 8);
    stats.onSent(PEER, 4);
    expect(stats.snapshot().turns).toBe(1);
  });

  test("要求が複数フレームに分かれても1回", () => {
    const { stats } = withClock();
    stats.onReceived(PEER, 8);
    stats.onReceived(PEER, 8);
    stats.onReceived(PEER, 8);
    stats.onSent(PEER, 4);
    expect(stats.snapshot().turns).toBe(1);
  });

  test("応答が複数フレームに分かれても1回", () => {
    const { stats } = withClock();
    stats.onReceived(PEER, 8);
    stats.onSent(PEER, 4);
    stats.onSent(PEER, 4);
    stats.onSent(PEER, 4);
    expect(stats.snapshot().turns).toBe(1);
  });

  test("往復を繰り返すと回数が増える", () => {
    const { stats } = withClock();
    for (let i = 0; i < 5; i++) {
      stats.onReceived(PEER, 8);
      stats.onSent(PEER, 4);
    }
    expect(stats.snapshot().turns).toBe(5);
  });

  test("送信から始まった場合は反転するまで数えない(発表者側の呼び方)", () => {
    const { stats } = withClock();
    stats.onSent(PEER, 8);
    expect(stats.snapshot().turns).toBe(0);
    // 応答を受けただけではまだ増えない。次の要求を出したところで1回になる
    stats.onReceived(PEER, 4);
    expect(stats.snapshot().turns).toBe(0);
    stats.onSent(PEER, 8);
    expect(stats.snapshot().turns).toBe(1);
  });

  test("相手ごとに数えるので、同時に往復しても混ざらない", () => {
    const { stats } = withClock();
    // a の受信と b の受信が交互に来ても、それぞれの反転だけを見る
    stats.onReceived("a", 8);
    stats.onReceived("b", 8);
    stats.onSent("a", 4);
    stats.onSent("b", 4);

    expect(stats.snapshotOf("a").turns).toBe(1);
    expect(stats.snapshotOf("b").turns).toBe(1);
    expect(stats.snapshot().turns).toBe(2);
  });
});

describe("応答時間", () => {
  test("要求の1バイト目から応答の1バイト目までを測る", () => {
    const { stats, advance } = withClock();
    stats.onReceived(PEER, 8);
    advance(30);
    // 要求の続きが届いても計測の起点は動かない
    stats.onReceived(PEER, 8);
    advance(20);
    stats.onSent(PEER, 4);

    expect(stats.snapshot().responseMs).toBe(50);
  });

  test("1回も返していなければ null", () => {
    const { stats } = withClock();
    stats.onReceived(PEER, 8);
    expect(stats.snapshot().responseMs).toBe(null);
  });

  test("中央値なので、1回だけ跳ねた転送に引きずられない", () => {
    const { stats, advance } = withClock();
    const run = (ms: number) => {
      stats.onReceived(PEER, 8);
      advance(ms);
      stats.onSent(PEER, 4);
    };
    run(10);
    run(10);
    run(10);
    run(10);
    // モデル配布のような大きな1回
    run(5000);

    expect(stats.snapshot().responseMs).toBe(10);
  });

  test("直近32回だけを見る", () => {
    const { stats, advance } = withClock();
    const run = (ms: number) => {
      stats.onReceived(PEER, 8);
      advance(ms);
      stats.onSent(PEER, 4);
    };
    // 古い100msは窓から押し出される
    for (let i = 0; i < 10; i++) run(100);
    for (let i = 0; i < 32; i++) run(20);

    expect(stats.snapshot().responseMs).toBe(20);
  });
});

describe("lastActivityAt", () => {
  test("動くまでは null、動いたら最後の時刻", () => {
    const { stats, advance } = withClock();
    expect(stats.snapshot().lastActivityAt).toBe(null);

    advance(120);
    stats.onReceived(PEER, 8);
    expect(stats.snapshot().lastActivityAt).toBe(120);

    advance(30);
    stats.onSent(PEER, 4);
    expect(stats.snapshot().lastActivityAt).toBe(150);
  });

  test("合計は相手のうち最も新しいものを返す", () => {
    const { stats, advance } = withClock();
    stats.onReceived("a", 8);
    advance(200);
    stats.onReceived("b", 8);

    expect(stats.snapshot().lastActivityAt).toBe(200);
  });
});

describe("reset", () => {
  test("全部0に戻る", () => {
    const { stats, advance } = withClock();
    stats.onReceived(PEER, 8);
    advance(10);
    stats.onSent(PEER, 4);

    stats.reset();

    const snapshot = stats.snapshot();
    expect(snapshot.bytesReceived).toBe(0);
    expect(snapshot.bytesSent).toBe(0);
    expect(snapshot.turns).toBe(0);
    expect(snapshot.responseMs).toBe(null);
    expect(snapshot.lastActivityAt).toBe(null);
    expect(stats.remoteIds()).toEqual([]);
  });
});
