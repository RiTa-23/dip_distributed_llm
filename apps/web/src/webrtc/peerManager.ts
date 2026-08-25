// WASM版llama.cpp(llmletのRPCパッチ)がJS側に期待する `Module.PeerManager` の実装。
//
// llmlet本家はこの役をPeerJSで作っている(`llmlet.js` の `newPeerManager`)。
// PeerJSへの依存はその関数の内側だけに閉じていて、WASM側(`main.cpp` と
// llama.cppのRPCパッチ)は下の6メソッドしか知らない。だからシグナリングを
// Honoへ寄せるのにC++側の変更は要らず、この1ファイルを差し替えれば済む。
//
// 契約の正はllmletの `libllmlet.js`。WASM側はpthreadの上で `Atomics.wait` して
// 待ち、こちらのメソッドはメインスレッドへ寄せて呼ばれる(`__proxy: 'sync'`)。
// RTCDataChannelがメインスレッドにあるので都合がよい。
//
// 接続そのものは張らない。Honoのシグナリングで開いたDataChannelを
// requesterSession / peerSession から `attach()` で受け取り、その上に載せる。

import { createPeerStats } from "./peerStats";
import type { PeerStatsReader } from "./peerStats";

/** llmletのRPCパッチが呼ぶ側の口。名前と引数は `libllmlet.js` に合わせてある */
export type LlamaPeerManager = {
  /** 相手ノードへ論理接続を開く。fd(失敗なら-1)をdoneで返す */
  connect: (nodeId: string, done: (fd: number) => void) => void;
  /**
   * 着信を待つ。fdをdoneで返す。
   * -1を返してはいけない: `accept_peer` は -1 を「まだ来ていない」の番兵に使うため、
   * -1を書くと `Atomics.wait` が起きずWASM側が止まる。
   */
  accept: (done: (fd: number) => void) => void;
  /** 送信。実際に送れたバイト数を返す。fdが無ければ-1 */
  send: (fd: number, data: Uint8Array) => number;
  /**
   * 受信。読めるものが1バイトも無ければ、届くまでdoneCBを呼ばずに待つ。
   * writeCBに渡したぶんの合計がWASM側の戻り値になり、doneCB(false)は-1になる。
   */
  recv: (
    fd: number,
    len: number,
    writeCB: (chunk: Uint8Array) => void,
    doneCB: (ok: boolean) => void,
  ) => void;
  /** 論理接続を閉じる。DataChannel自体は閉じない */
  close_connection: (fd: number) => number;
  /** WASM側が確保した受信バッファの番地。解放のために覚えておくだけ */
  register_buf: (fd: number, ptr: number) => void;
  /** 全部閉じる */
  close: () => void;
};

/** こちら(React側)から使う口 */
export type PeerManagerHost = {
  /** DataChannelが開いた。useWebrtcSignaling の onOpen から呼ぶ */
  attach: (remoteId: string, channel: DataChannelLike) => void;
  /** DataChannel上のデータ。useWebrtcSignaling の onData から呼ぶ */
  handleMessage: (remoteId: string, data: unknown) => void;
  /** その相手との回線が無くなった。載っている論理接続も落とす */
  detach: (remoteId: string) => void;
  /** テスト・表示用。今生きているfd */
  openFds: () => number[];
  /**
   * 今つながっている相手。開発用のコンソールが宛先を選ぶのに使う。
   * 回線が閉じたものは除く(選んでも `connect` が-1を返すだけのため)
   */
  remoteIds: () => string[];
  /**
   * 流れたバイト数と往復の数え上げ。画面の計測表示の出どころ
   * (`hooks/usePeerStats.ts` が250msごとに読む)。
   * 数える側はこのモジュールの内側に閉じていて、外からは読むだけ。
   */
  stats: PeerStatsReader;
};

export type WebrtcPeerManager = LlamaPeerManager & PeerManagerHost;

/**
 * PeerManagerがDataChannelに求める最小限。
 * RTCDataChannelはこの形を満たす。テストで偽物を挿せるように構造で受ける。
 *
 * `bufferedAmountLowThreshold` と `addEventListener` は送信の待ち合わせに使う。
 * どちらも任意にしてあるのは偽物を軽く書けるようにするためで、無ければ
 * 一定間隔の見直しだけで再開する(`RESUME_POLL_MS`)。
 */
export type DataChannelLike = {
  readyState: RTCDataChannelState;
  bufferedAmount: number;
  send: (data: ArrayBuffer) => void;
  bufferedAmountLowThreshold?: number;
  addEventListener?: (type: "bufferedamountlow", listener: () => void) => void;
  removeEventListener?: (type: "bufferedamountlow", listener: () => void) => void;
};

export type PeerManagerOptions = {
  /**
   * `register_buf` で受け取った番地を解放する。実体はWASM側の `Module.release_conn`。
   * このモジュールをEmscriptenのModuleに依存させないため外から渡す。
   */
  releaseBuf?: (ptr: number) => void;
  /** 異常の通知。画面に出す用で、制御には使わない */
  onError?: (message: string) => void;
  /** 1つの論理接続が溜めておける受信バイト数の上限。既定は `MAX_RECV_QUEUE_BYTES` */
  maxRecvQueueBytes?: number;
  /** 1回線が抱えられる送信待ちバイト数の上限。既定は `MAX_SEND_QUEUE_BYTES` */
  maxSendQueueBytes?: number;
  /** 計測に使う時計。既定は `performance.now()`。テストで固定するために外から渡せる */
  now?: () => number;
};

// ---- DataChannel上のフレーム形式 ------------------------------------------
//
// llmlet本家はPeerJSのオブジェクト送信(`conn.send({cmd, data})`)に頼っているが、
// こちらは生のRTCDataChannelなので自前で枠を決める。両端とも我々のコードなので
// 本家と互換である必要はない。
//
//   [0]    コマンド1バイト
//   [1..]  本文(dataのときだけ)
//
// DataChannelは既定で順序保証つきの信頼配送なので、1メッセージ=1フレームでよく、
// 長さ接頭辞は要らない。

const CMD_CONNECT = 0x01;
const CMD_ACCEPTED = 0x02;
const CMD_DATA = 0x03;
const CMD_CLOSE = 0x04;

const HEADER_SIZE = 1;

/**
 * 1メッセージの上限。SCTPの相互運用で安全に通るのが64KiBなので、
 * ヘッダを足しても超えないように本文をその分だけ削る。
 */
const MAX_FRAME_SIZE = 64 * 1024;
const CHUNK_SIZE = MAX_FRAME_SIZE - HEADER_SIZE;

/** fdの上限。llmletと同じ */
const FD_MAX = 1024;

/**
 * 1つの論理接続が溜めておける受信バイト数の上限。
 *
 * 相手がrecvより速く送り続けると `recvBuf` が際限なく伸び、タブがヒープを
 * 食い潰して落ちる。落ちると何が起きたか分からないので、その手前で畳んで
 * `onFailed` 相当を上げ、世代の組み直しに載せる。
 *
 * `send_peer` 1回で大きなテンソルが丸ごと来ることがあるため、上限は
 * 通常の転送では踏まない大きさにしてある。ここを踏むのは相手かWASMの異常。
 */
export const MAX_RECV_QUEUE_BYTES = 256 * 1024 * 1024;

/**
 * 送信を止める水位。`channel.bufferedAmount` がこれ以上あるうちは書き込まない。
 *
 * Chromeは `bufferedAmount` が16MiBに達すると `send()` が OperationError を投げる
 * (Chrome 141で実測。チャンネル自体は開いたまま残り、投げられたフレームだけが落ちる)。
 * llama.cppは `send_peer` 1回で大きなテンソルを丸ごと渡してくるため、
 * 何も見ずに書き続けると本番のモデル配布でここを踏む。
 */
export const SEND_HIGH_WATER = 8 * 1024 * 1024;

/** 再開する水位。`bufferedAmountLowThreshold` に入れる */
const SEND_LOW_WATER = 4 * 1024 * 1024;

/**
 * `bufferedamountlow` を持たない相手のための保険。
 * 止まっている間だけ回り、キューが空になれば止める。
 */
const RESUME_POLL_MS = 50;

/**
 * 1回線(DataChannel1本)が抱えられる送信待ちのバイト数。
 *
 * 水位で止めたぶんはこちらのヒープに積む。上限を設けないと、WASMのヒープに
 * ある転送物をまるごと二重に持つことになる。ここを超えたぶんは `send` の
 * 戻り値を短くして呼び出し側へ返す(ソケットの部分送信と同じ扱い)。
 *
 * 受信側の上限と同じく、通常の転送では踏まない大きさにしてある。
 */
export const MAX_SEND_QUEUE_BYTES = 64 * 1024 * 1024;

type Conn = {
  fd: number;
  link: Link;
  /** 届いたぶんの待ち行列。recvが先頭から削っていく */
  recvBuf: Uint8Array[];
  /** recvBuf に溜まっているバイト数。上限の判定に使う */
  queuedBytes: number;
  /** 待たせているrecvを起こす。1つのfdにつき同時に1つだけ */
  wake: (() => void) | null;
  /** connectの完了待ち。ACCEPTEDが来たら呼ぶ */
  accepted: ((ok: boolean) => void) | null;
  moduleBuf: number | null;
};

/** 送信待ちの1フレーム。`fd` は畳んだときに捨てる判断に使う(制御フレームはnull) */
type Queued = {
  frame: Uint8Array<ArrayBuffer>;
  fd: number | null;
};

type Link = {
  remoteId: string;
  channel: DataChannelLike;
  /**
   * この相手と今つながっている論理接続。
   * llama.cppのC側はソケットの開閉を頻繁に繰り返すが、1本のDataChannelの上を
   * 直列に使い回す形になるので、同時に生きるのは1本だけ。
   */
  conn: Conn | null;
  /**
   * 水位で書き込めなかったフレーム。**回線ごとに1本**にしてある。
   * 論理接続ごとに分けると、CLOSEが先に届いてDATAが後から出る順番が起こりうる。
   */
  queue: Queued[];
  /** queue に積まれているバイト数。上限の判定に使う */
  queuedBytes: number;
  /** 再開待ちの後片付け。止めていないときはnull */
  disarm: (() => void) | null;
};

/** 受信した生データをバイト列に直す。文字列は使わないので捨てる */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

export function createPeerManager(options: PeerManagerOptions = {}): WebrtcPeerManager {
  const {
    releaseBuf,
    onError,
    maxRecvQueueBytes = MAX_RECV_QUEUE_BYTES,
    maxSendQueueBytes = MAX_SEND_QUEUE_BYTES,
    now,
  } = options;

  const stats = createPeerStats(now);

  const links = new Map<string, Link>();
  const conns = new Map<number, Conn>();
  /** CONNECTを受けてfdを割り当てたが、まだacceptされていないもの */
  const readyFds: number[] = [];
  /** acceptが先に呼ばれて待っているぶん */
  const acceptWaiters: ((fd: number) => void)[] = [];

  let nextFd = 0;

  /** 空いているfdを探す。llmletと同じく巡回して探す */
  const newFd = (): number | null => {
    for (let i = 0; i < FD_MAX; i++) {
      if (nextFd >= FD_MAX) nextFd = 0;
      const fd = nextFd++;
      if (!conns.has(fd)) return fd;
    }
    onError?.("論理接続が上限に達しました");
    return null;
  };

  const buildFrame = (cmd: number, body?: Uint8Array): Uint8Array<ArrayBuffer> => {
    const frame = new Uint8Array(HEADER_SIZE + (body?.byteLength ?? 0));
    frame[0] = cmd;
    if (body) frame.set(body, HEADER_SIZE);
    return frame;
  };

  /** 実際にDataChannelへ書く。ここでしか `channel.send` を呼ばない */
  const writeFrame = (link: Link, frame: Uint8Array<ArrayBuffer>): boolean => {
    try {
      link.channel.send(frame.buffer);
      return true;
    } catch (e: unknown) {
      onError?.(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  /** 再開待ちをやめる */
  const stopWaiting = (link: Link) => {
    const disarm = link.disarm;
    link.disarm = null;
    disarm?.();
  };

  /** 積んであるものを捨てる。回線ごと畳むときだけ呼ぶ */
  const clearQueue = (link: Link) => {
    link.queue = [];
    link.queuedBytes = 0;
    stopWaiting(link);
  };

  /**
   * 畳んだ論理接続のDATAを捨てる。
   *
   * 残したまま流すと、相手が開き直した次の論理接続に前の中身が混ざる。
   * 制御フレーム(`fd` がnull)は残す。CLOSEはこれで生き延びる。
   */
  const dropQueued = (link: Link, fd: number) => {
    if (link.queue.length === 0) return;
    const kept: Queued[] = [];
    let bytes = 0;
    for (const q of link.queue) {
      if (q.fd === fd) continue;
      kept.push(q);
      bytes += q.frame.byteLength;
    }
    link.queue = kept;
    link.queuedBytes = bytes;
    if (kept.length === 0) stopWaiting(link);
  };

  /**
   * 水位が下がるまで待って続きを流す。
   *
   * `bufferedamountlow` が本命で、一定間隔の見直しは保険。イベントを持たない
   * 相手(テストの偽物)と、閾値を跨がないまま減ったときの取りこぼしを拾う。
   */
  const startWaiting = (link: Link) => {
    if (link.disarm) return;
    const channel = link.channel;
    const onLow = () => {
      flush(link);
    };
    channel.bufferedAmountLowThreshold = SEND_LOW_WATER;
    channel.addEventListener?.("bufferedamountlow", onLow);
    const timer = setInterval(onLow, RESUME_POLL_MS);
    link.disarm = () => {
      channel.removeEventListener?.("bufferedamountlow", onLow);
      clearInterval(timer);
    };
  };

  /** 積んであるものを、水位に当たるまで順に書き出す */
  const flush = (link: Link) => {
    const channel = link.channel;
    if (channel.readyState !== "open") {
      // 回線が無くなった。積んでいても出せないので捨てる
      clearQueue(link);
      return;
    }
    while (link.queue.length > 0 && channel.bufferedAmount < SEND_HIGH_WATER) {
      const head = link.queue[0];
      if (!head) break;
      if (!writeFrame(link, head.frame)) {
        clearQueue(link);
        return;
      }
      link.queue.shift();
      link.queuedBytes -= head.frame.byteLength;
    }
    if (link.queue.length > 0) startWaiting(link);
    else stopWaiting(link);
  };

  type PushResult = "written" | "queued" | "full" | "closed";

  /**
   * 1フレームを送る。今書けるなら書き、水位に当たっていれば積む。
   * 順番を守るため、積んであるものがある間は新しいぶんも必ず後ろに並べる。
   */
  const pushFrame = (link: Link, frame: Uint8Array<ArrayBuffer>, fd: number | null): PushResult => {
    if (link.channel.readyState !== "open") return "closed";
    if (link.queue.length === 0 && link.channel.bufferedAmount < SEND_HIGH_WATER) {
      return writeFrame(link, frame) ? "written" : "closed";
    }
    // 制御フレーム(1バイト)は上限の外に置く。ここで落とすと、CLOSEが出せずに
    // 相手の論理接続が残る・ACCEPTEDが返せず相手が待ち続ける、といった詰まり方をする
    if (fd !== null && link.queuedBytes + frame.byteLength > maxSendQueueBytes) {
      return "full";
    }
    link.queue.push({ frame, fd });
    link.queuedBytes += frame.byteLength;
    startWaiting(link);
    return "queued";
  };

  /** 制御フレーム。畳んだ後も出す必要があるので `fd` は持たせない */
  const sendFrame = (link: Link, cmd: number): boolean =>
    pushFrame(link, buildFrame(cmd), null) !== "closed";

  /**
   * 論理接続を畳む。conns から先に消してから wake を呼ぶ。
   * 順番が逆だと、待たせていたrecvが「まだ生きている」と誤認して成功を返す。
   *
   * `keepQueued` は `close_connection` からの正常な閉じ方のときだけ真にする。
   * 送りかけのDATAを出し切ってからCLOSEを届けたいのはその場合だけで、
   * 相手が落ちた・世代が変わったときの送り残しは捨てる。
   */
  const destroy = (conn: Conn, keepQueued = false) => {
    conns.delete(conn.fd);
    if (!keepQueued) dropQueued(conn.link, conn.fd);
    if (conn.link.conn === conn) conn.link.conn = null;
    const queued = readyFds.indexOf(conn.fd);
    if (queued >= 0) readyFds.splice(queued, 1);
    conn.recvBuf = [];
    conn.queuedBytes = 0;
    if (conn.moduleBuf !== null) {
      releaseBuf?.(conn.moduleBuf);
      conn.moduleBuf = null;
    }
    const wake = conn.wake;
    conn.wake = null;
    wake?.();
    const accepted = conn.accepted;
    conn.accepted = null;
    accepted?.(false);
  };

  const createConn = (fd: number, link: Link): Conn => {
    const conn: Conn = {
      fd,
      link,
      recvBuf: [],
      queuedBytes: 0,
      wake: null,
      accepted: null,
      moduleBuf: null,
    };
    link.conn = conn;
    conns.set(fd, conn);
    return conn;
  };

  /**
   * acceptを1件成立させる。ACCEPTEDを返してからfdを渡す(llmletと同じ順)。
   *
   * ACCEPTEDを返せなかったらfdを渡さない。渡してしまうと、WASM側は使えないfdで
   * recvに入り、起こす者がいないまま止まる(相手も accepted を待ち続ける)。
   * 呼び出し側は false を見て、次の着信を待ち直す。
   */
  const settleAccept = (fd: number, done: (fd: number) => void) => {
    const conn = conns.get(fd);
    if (!conn) return false;
    if (!sendFrame(conn.link, CMD_ACCEPTED)) {
      destroy(conn);
      return false;
    }
    done(fd);
    return true;
  };

  // ---- 相手から届いたフレームの処理 ----

  const handleConnect = (link: Link) => {
    // 直列使い回しの前提。前の論理接続が残っていれば畳んでから受ける
    if (link.conn) destroy(link.conn);
    const fd = newFd();
    if (fd === null) return;
    createConn(fd, link);

    const waiter = acceptWaiters.shift();
    if (waiter) {
      // 成立しなければ待たせたまま戻す。取り出したきり捨てるとacceptが二度と返らない
      if (!settleAccept(fd, waiter)) acceptWaiters.unshift(waiter);
      return;
    }
    readyFds.push(fd);
  };

  const handleAccepted = (link: Link) => {
    const conn = link.conn;
    if (!conn) return;
    const accepted = conn.accepted;
    conn.accepted = null;
    accepted?.(true);
  };

  const handleData = (link: Link, body: Uint8Array) => {
    const conn = link.conn;
    if (!conn || body.byteLength === 0) return;
    if (conn.queuedBytes + body.byteLength > maxRecvQueueBytes) {
      onError?.(
        `${link.remoteId} からの受信が溜まりすぎました(${String(conn.queuedBytes)}バイト)。接続を切ります`,
      );
      // 待たせているrecvはdestroyの中で失敗として返る
      destroy(conn);
      return;
    }
    conn.recvBuf.push(body);
    conn.queuedBytes += body.byteLength;
    // 数えるのは本文だけ。制御フレーム(CONNECT/ACCEPTED/CLOSE)を混ぜると、
    // 接続の手続きが1回の往復として数えられてしまう
    stats.onReceived(link.remoteId, body.byteLength);
    const wake = conn.wake;
    conn.wake = null;
    wake?.();
  };

  const handleClose = (link: Link) => {
    if (link.conn) destroy(link.conn);
  };

  // ---- 外向きの実装 ----

  return {
    attach: (remoteId, channel) => {
      const existing = links.get(remoteId);
      if (existing) {
        if (existing.conn) destroy(existing.conn);
        // 前の回線の送り残しと、その再開待ちのタイマーを置いていかない
        clearQueue(existing);
      }
      links.set(remoteId, {
        remoteId,
        channel,
        conn: null,
        queue: [],
        queuedBytes: 0,
        disarm: null,
      });
    },

    handleMessage: (remoteId, data) => {
      const link = links.get(remoteId);
      if (!link) return;
      const frame = toBytes(data);
      if (!frame || frame.byteLength < HEADER_SIZE) return;
      switch (frame[0]) {
        case CMD_CONNECT:
          handleConnect(link);
          return;
        case CMD_ACCEPTED:
          handleAccepted(link);
          return;
        case CMD_DATA:
          handleData(link, frame.subarray(HEADER_SIZE));
          return;
        case CMD_CLOSE:
          handleClose(link);
          return;
        default:
          onError?.(`知らないフレームが届きました: ${String(frame[0])}`);
      }
    },

    detach: (remoteId) => {
      const link = links.get(remoteId);
      if (!link) return;
      if (link.conn) destroy(link.conn);
      clearQueue(link);
      links.delete(remoteId);
    },

    openFds: () => [...conns.keys()],

    remoteIds: () =>
      [...links.values()].filter((l) => l.channel.readyState === "open").map((l) => l.remoteId),

    stats,

    connect: (nodeId, done) => {
      const link = links.get(nodeId);
      if (!link || link.channel.readyState !== "open") {
        done(-1);
        return;
      }
      // 前の論理接続が残っていれば畳む。C側は閉じてすぐ開き直すことがある
      if (link.conn) destroy(link.conn);

      const fd = newFd();
      if (fd === null) {
        done(-1);
        return;
      }
      const conn = createConn(fd, link);
      conn.accepted = (ok) => done(ok ? fd : -1);
      if (!sendFrame(link, CMD_CONNECT)) destroy(conn);
    },

    accept: (done) => {
      // 割り当て済みだが相手が既に落ちたfdは飛ばす
      while (readyFds.length > 0) {
        const fd = readyFds.shift();
        if (fd === undefined) break;
        if (settleAccept(fd, done)) return;
      }
      acceptWaiters.push(done);
    },

    /**
     * ソケットの `send(2)` と同じ扱いで、受け取れたバイト数を返す。
     *
     * 水位で止まっているぶんは `link.queue` に写して受け取り、常用パスでは
     * 全量を返す。C側が部分送信を送り直す作りかどうかに依存させないため。
     * キューまで埋まったときだけ短い値を返し、そこから先は呼び出し側に委ねる。
     */
    send: (fd, data) => {
      const conn = conns.get(fd);
      if (!conn) return -1;
      let sent = 0;
      while (sent < data.byteLength) {
        const take = Math.min(CHUNK_SIZE, data.byteLength - sent);
        // WASMのヒープを直接見ている view なので、送る前に必ず写す
        const frame = buildFrame(CMD_DATA, data.subarray(sent, sent + take));
        const result = pushFrame(conn.link, frame, conn.fd);
        // 回線が閉じた・キューが埋まった。受け取れたぶんだけ返す
        if (result === "closed" || result === "full") break;
        sent += take;
      }
      // 分割の仕方ではなくC側の呼び出し1回を1回と数えたいので、
      // 積み終えてからまとめて数える(往復の判定もこの粒度でよい)
      if (sent > 0) stats.onSent(conn.link.remoteId, sent);
      return sent;
    },

    recv: (fd, len, writeCB, doneCB) => {
      const conn = conns.get(fd);
      if (!conn) {
        doneCB(false);
        return;
      }
      const drain = (): number => {
        let written = 0;
        let remaining = len;
        while (conn.recvBuf.length > 0 && remaining > 0) {
          const head = conn.recvBuf[0];
          if (!head) break;
          const take = Math.min(remaining, head.byteLength);
          writeCB(head.subarray(0, take));
          if (take < head.byteLength) conn.recvBuf[0] = head.subarray(take);
          else conn.recvBuf.shift();
          conn.queuedBytes -= take;
          written += take;
          remaining -= take;
        }
        return written;
      };

      if (drain() > 0) {
        doneCB(true);
        return;
      }
      // 1バイトも無い。届くか閉じるまでdoneCBを呼ばずに待つ
      conn.wake = () => {
        if (conns.get(fd) !== conn) {
          doneCB(false);
          return;
        }
        drain();
        doneCB(true);
      };
    },

    close_connection: (fd) => {
      const conn = conns.get(fd);
      if (!conn) return -1;
      // 積んであるDATAの後ろにCLOSEを並べ、送り残しを出し切ってから閉じる
      sendFrame(conn.link, CMD_CLOSE);
      destroy(conn, true);
      return 0;
    },

    register_buf: (fd, ptr) => {
      const conn = conns.get(fd);
      if (conn) conn.moduleBuf = ptr;
    },

    /**
     * 回線と論理接続を全部畳む。世代が変わるたびに呼ばれる
     * (`usePeerManager` の `onReset`)。同じ実体をそのまま次の世代でも使う。
     *
     * **`acceptWaiters` だけは持ち越す。** 捨てるとWASM側が止まる:
     * peerはRPCサーバー役なので、繋がる前から `accept` で待っていることがあり、
     * その待機を消すと `done` を呼ぶ者がいなくなって `Atomics.wait` から戻れない。
     * 次の世代のCONNECTが来ても `readyFds` に積まれるだけで、WASMは
     * `accept` の中に閉じ込められたまま二度と出てこない。
     *
     * 持ち越して困らないのは、llama.cpp側の `accept` に世代の区別がなく
     * 「次の相手を待つ」以上の意味を持たないため。待機は1つのpthreadにつき
     * 1件までなので溜まることもない。
     */
    close: () => {
      for (const conn of [...conns.values()]) destroy(conn);
      // 回線ごと畳むので送り残しは捨てる。タイマーを止めるのもここ
      for (const link of links.values()) clearQueue(link);
      links.clear();
      readyFds.length = 0;
    },
  };
}
