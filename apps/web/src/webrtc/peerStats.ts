// データプレーンを流れたバイト数と、RPCの往復の数え上げ。
//
// 画面に出す「処理回数・受信データ・応答時間」の出どころ。`RTCPeerConnection.getStats()`
// ではなくここで数えているのは、
//   - 論理接続の本文だけを厳密に数えられる(getStatsはSCTP/DTLSの分が混ざる)
//   - 処理回数はgetStatsでは原理的に取れない
//   - 偽のDataChannelだけでテストできる(実ブラウザが要らない)
// の3点による。RTTや実際の回線スループットが欲しくなったら、そのときだけ
// getStatsを第2の情報源として足せばよい。
//
// peerManager.ts からの呼び出しは `onReceived` / `onSent` の2箇所だけで、
// どちらも加算しかしない(オブジェクトを作らない・コールバックを呼ばない)。
// 64KiBごとに回る送信の内側に置くため。
//
// 呼ばれるのは「回線を実際に渡ったとき」に揃えてある。送信は書き出せた時点、
// 受信は届いた時点で、こちらの都合で捨てたかどうかは見ない。

/** 応答時間を覚えておく本数。中央値を出すのに使う */
const WINDOW = 32;

export type PeerStatsSnapshot = {
  /** 受け取った本文の累計バイト数。フレームヘッダと制御フレームは含まない */
  bytesReceived: number;
  /** 送った本文の累計バイト数。回線へ書き出せた時点で数える */
  bytesSent: number;
  /** 応答を返した回数。受信→送信の反転を数える */
  turns: number;
  /** 応答時間の中央値(ms)。1回も返していなければ null */
  responseMs: number | null;
  /** 最後に本文が動いた時刻(createPeerStats に渡した時計の値)。無ければ null */
  lastActivityAt: number | null;
};

export type PeerStats = {
  onReceived: (remoteId: string, bytes: number) => void;
  onSent: (remoteId: string, bytes: number) => void;
  /** 全相手の合計 */
  snapshot: () => PeerStatsSnapshot;
  /** 相手ごとの内訳。発表者側の画面へ広げるときに使う */
  snapshotOf: (remoteId: string) => PeerStatsSnapshot;
  /** 数えている相手。内訳を回すときに使う */
  remoteIds: () => string[];
  /** 0に戻す。参加のたびに画面から呼ぶ */
  reset: () => void;
};

/** 画面が使うのは読む側だけ。数える側は PeerManager の内側に閉じている */
export type PeerStatsReader = Pick<PeerStats, "snapshot" | "snapshotOf" | "remoteIds" | "reset">;

export const EMPTY_STATS: PeerStatsSnapshot = {
  bytesReceived: 0,
  bytesSent: 0,
  turns: 0,
  responseMs: null,
  lastActivityAt: null,
};

/**
 * 相手1人ぶんの数え上げ。
 *
 * 相手ごとに分けてあるのは、向きの反転が混ざらないようにするため。
 * 発表者は複数のpeerと同時に往復するので、1本の状態機械で数えると
 * 別々の相手のやり取りが1回の往復に見えてしまう。
 */
type Counters = {
  bytesReceived: number;
  bytesSent: number;
  turns: number;
  /** 直近の応答時間。先頭が最も古い */
  durations: number[];
  lastActivityAt: number | null;
  /** 今どちら向きに流れているか。null は一度も動いていない */
  flow: "receiving" | "sending" | null;
  /** 今受けている要求の1バイト目が来た時刻 */
  turnStartedAt: number | null;
};

/** 相手を初めて見たときの初期値 */
function createCounters(): Counters {
  return {
    bytesReceived: 0,
    bytesSent: 0,
    turns: 0,
    durations: [],
    lastActivityAt: null,
    flow: null,
    turnStartedAt: null,
  };
}

/** 中央値。空なら null */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  if (lo === undefined || hi === undefined) return null;
  return (lo + hi) / 2;
}

export function createPeerStats(now: () => number = () => performance.now()): PeerStats {
  const byRemote = new Map<string, Counters>();

  /** その相手の数え上げ。初めてなら作る */
  const counters = (remoteId: string): Counters => {
    const existing = byRemote.get(remoteId);
    if (existing) return existing;
    const created = createCounters();
    byRemote.set(remoteId, created);
    return created;
  };

  /** 内訳1件ぶんを外向きの形に直す。中央値はここで出す */
  const toSnapshot = (c: Counters): PeerStatsSnapshot => ({
    bytesReceived: c.bytesReceived,
    bytesSent: c.bytesSent,
    turns: c.turns,
    responseMs: median(c.durations),
    lastActivityAt: c.lastActivityAt,
  });

  return {
    onReceived: (remoteId, bytes) => {
      const c = counters(remoteId);
      const at = now();
      c.bytesReceived += bytes;
      c.lastActivityAt = at;
      // 送信から受信へ切り替わった = 次の要求が来た。ここから応答までを測る
      if (c.flow !== "receiving") {
        c.flow = "receiving";
        c.turnStartedAt = at;
      }
    },

    onSent: (remoteId, bytes) => {
      const c = counters(remoteId);
      const at = now();
      c.bytesSent += bytes;
      c.lastActivityAt = at;
      // 受信から送信へ切り替わった = 1つの要求に応答を返した。
      // 応答が複数フレームに分かれても、続く送信は同じ1回として扱う
      if (c.flow === "receiving") {
        c.turns += 1;
        if (c.turnStartedAt !== null) {
          c.durations.push(at - c.turnStartedAt);
          if (c.durations.length > WINDOW) c.durations.shift();
        }
        c.turnStartedAt = null;
      }
      c.flow = "sending";
    },

    snapshot: () => {
      // 合計は読むときにたたむ。読むのは250msに1回なので、
      // 加算のたびに合計と内訳の2か所を更新するより安い
      const total = { ...EMPTY_STATS };
      const durations: number[] = [];
      for (const c of byRemote.values()) {
        total.bytesReceived += c.bytesReceived;
        total.bytesSent += c.bytesSent;
        total.turns += c.turns;
        durations.push(...c.durations);
        if (c.lastActivityAt !== null) {
          total.lastActivityAt =
            total.lastActivityAt === null
              ? c.lastActivityAt
              : Math.max(total.lastActivityAt, c.lastActivityAt);
        }
      }
      total.responseMs = median(durations);
      return total;
    },

    snapshotOf: (remoteId) => {
      const c = byRemote.get(remoteId);
      return c ? toSnapshot(c) : { ...EMPTY_STATS };
    },

    remoteIds: () => [...byRemote.keys()],

    reset: () => {
      byRemote.clear();
    },
  };
}
