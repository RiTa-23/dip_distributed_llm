// ①のWASM(llmletのRPCパッチ)の代役。
//
// `peerManager.ts` はWASM側から呼ばれる前提で書いてあるが、そのWASMがまだ無い。
// 来てから初めて疎通させると当日に問題が集中するので、**C側と同じ呼び方をする
// 偽物**をこちらで用意して、橋渡しの側だけ先に確定させる。
//
// 真似ているのはllama.cppのRPCの手続き(`ggml-rpc.cpp`)であって、中身の意味では
// ない。バイト列が壊れずに往復するか・閉じ方が噛み合うかだけを見る。
//
//   サーバ役(peer)      : accept → recv(ヘッダ) → recv(本体) → send(応答) → 繰り返し
//   クライアント役(req) : connect → send(ヘッダ+本体) → recv(応答) → close_connection
//
// C側と揃えている点:
// - `recv` は要求したぶんが一度に来るとは限らないので、集まるまで繰り返す
//   (llama.cppの `recv_data` と同じ)
// - `send` の戻り値は受け取れたバイト数。短ければ残りを送り直す
//   (llama.cppの `send_data` と同じ。送信キューが埋まったときにここが効く)

import type { LlamaPeerManager } from "./peerManager";

/** 応答で全バイトに掛ける値。読まずに返しただけの応答と区別するために混ぜる */
const ECHO_MASK = 0x5a;

/** 本体の長さを載せるヘッダ。llama.cppも固定長ヘッダを先に読む作り */
const HEADER_SIZE = 8;

function writeHeader(length: number): Uint8Array {
  const header = new Uint8Array(HEADER_SIZE);
  new DataView(header.buffer).setUint32(0, length, true);
  return header;
}

function readHeader(header: Uint8Array): number {
  return new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(0, true);
}

/** 検算用の中身。位置ごとに値が変わるので、順番が入れ替われば気づける */
export function stubPayload(size: number, seed = 0): Uint8Array {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (i * 31 + seed) % 251;
  return data;
}

/** 次のマイクロタスクまで譲る。送信キューが空くのを待つときに使う */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function acceptOnce(pm: LlamaPeerManager): Promise<number> {
  return new Promise((resolve) => {
    pm.accept(resolve);
  });
}

function connectOnce(pm: LlamaPeerManager, nodeId: string): Promise<number> {
  return new Promise((resolve) => {
    pm.connect(nodeId, resolve);
  });
}

/** 1回ぶんのrecv。届いているぶんだけ返す。閉じたらnull */
function recvOnce(pm: LlamaPeerManager, fd: number, len: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    pm.recv(
      fd,
      len,
      (chunk) => {
        // WASM側はヒープへ書き写す。こちらも借り物にしないよう写す
        chunks.push(new Uint8Array(chunk));
        total += chunk.byteLength;
      },
      (ok) => {
        resolve(ok ? concat(chunks, total) : null);
      },
    );
  });
}

/** 要求したぶんが集まるまで繰り返す。llama.cppの `recv_data` と同じ */
async function recvExactly(pm: LlamaPeerManager, fd: number, len: number): Promise<Uint8Array> {
  const out = new Uint8Array(len);
  let got = 0;
  while (got < len) {
    const chunk = await recvOnce(pm, fd, len - got);
    if (chunk === null) throw new Error("受信の途中で接続が閉じました");
    if (chunk.byteLength === 0) throw new Error("受信が0バイトで返りました");
    out.set(chunk, got);
    got += chunk.byteLength;
  }
  return out;
}

/**
 * 送り切るまで繰り返す。llama.cppの `send_data` と同じ。
 *
 * 送信キューが埋まると `send` は短い値を返す。C側がこの形で送り直すかは
 * 未確認だが、こちらの偽物は正しい側(送り直す)に倒しておく。
 */
async function sendAll(pm: LlamaPeerManager, fd: number, data: Uint8Array): Promise<void> {
  let sent = 0;
  while (sent < data.byteLength) {
    const n = pm.send(fd, data.subarray(sent));
    if (n < 0) throw new Error("送信に失敗しました(接続が無い)");
    if (n === 0) {
      // キューが埋まっている。水位が下がるまで譲る
      await tick();
      continue;
    }
    sent += n;
  }
}

export type StubServer = {
  /** 受け付けた回数。画面に出さずコンソールで見る用 */
  readonly served: () => number;
  stop: () => void;
};

/**
 * 同じPeerManagerに対して立てたサーバ。
 *
 * **1つのPeerManagerにつきaccept待ちのループは1本だけにする。** `accept` の待機を
 * 途中で取り消す手段は契約に無いため(`peerManager.close()` が待機を持ち越す理由と
 * 同じ)、止めるたびにループを捨てて立て直すと、捨てたループの待機が先頭に居座る。
 * 次のCONNECTはその待機に渡ってACCEPTEDまで返るのに、fdを受け取る者がいない。
 * 相手は繋がったつもりで送り続け、誰も読まないまま止まる。
 */
type ServerState = {
  handle: StubServer;
  /** 止めたあとに立て直すとき。ループは作らず、状態だけ戻す */
  resume: (onEvent: (message: string) => void) => void;
};

const servers = new WeakMap<LlamaPeerManager, ServerState>();

/**
 * サーバ役(peer側)。届いたぶんを加工して返し続ける。
 *
 * 同じPeerManagerに対して2回目以降を呼ぶと、最初のループを使い回す。
 * 止めているあいだに来た接続は、放置せずその場で畳む(相手を待たせないため)。
 */
export function startStubServer(
  pm: LlamaPeerManager,
  onEvent: (message: string) => void = () => {},
): StubServer {
  const existing = servers.get(pm);
  if (existing) {
    existing.resume(onEvent);
    return existing.handle;
  }

  let serving = true;
  let served = 0;
  let notify = onEvent;

  const serve = async (fd: number) => {
    // 1本の論理接続で複数のやり取りを捌く。相手が閉じたら抜ける
    for (;;) {
      const header = await recvExactly(pm, fd, HEADER_SIZE);
      const length = readHeader(header);
      const body = await recvExactly(pm, fd, length);
      const reply = new Uint8Array(length);
      for (let i = 0; i < length; i++) reply[i] = (body[i] ?? 0) ^ ECHO_MASK;
      await sendAll(pm, fd, writeHeader(length));
      await sendAll(pm, fd, reply);
      served += 1;
      notify(`${String(length)}バイトを返しました`);
    }
  };

  // 抜けない。抜けると待機を捨てることになる(上の説明)
  const loop = async () => {
    for (;;) {
      const fd = await acceptOnce(pm);
      if (fd < 0) {
        notify("acceptが失敗しました");
        continue;
      }
      if (!serving) {
        // 止めているあいだの接続。ACCEPTEDは既に返っているので、畳んで相手に知らせる
        pm.close_connection(fd);
        continue;
      }
      try {
        await serve(fd);
      } catch (e: unknown) {
        // 相手が閉じた・世代が変わった。次の着信を待ち直す
        notify(e instanceof Error ? e.message : String(e));
      }
    }
  };

  const handle: StubServer = {
    served: () => served,
    stop: () => {
      serving = false;
    },
  };

  servers.set(pm, {
    handle,
    resume: (next) => {
      notify = next;
      serving = true;
    },
  });

  void loop();

  return handle;
}

export type StubClientOptions = {
  /** 1往復で送る大きさ。既定8MiB */
  size?: number;
  /** 往復の回数。既定1 */
  rounds?: number;
};

export type StubClientResult = {
  rounds: number;
  bytes: number;
  ms: number;
  /** バイト単位で一致したか */
  ok: boolean;
};

/**
 * クライアント役(requester側)。送ったものが加工されて返ってくるかを見る。
 *
 * 返ってきた中身を検算しているので、**中身を読まずに返すだけの相手では通りません**。
 * 分割・順序・詰まったときの送り直しが噛み合っていることの確認になります。
 */
export async function runStubClient(
  pm: LlamaPeerManager,
  nodeId: string,
  options: StubClientOptions = {},
): Promise<StubClientResult> {
  const size = options.size ?? 8 * 1024 * 1024;
  const rounds = options.rounds ?? 1;

  const fd = await connectOnce(pm, nodeId);
  if (fd < 0) throw new Error(`${nodeId} へ繋げませんでした`);

  const started = Date.now();
  let bytes = 0;
  let ok = true;

  try {
    for (let round = 0; round < rounds; round++) {
      const payload = stubPayload(size, round);
      await sendAll(pm, fd, writeHeader(size));
      await sendAll(pm, fd, payload);

      const header = await recvExactly(pm, fd, HEADER_SIZE);
      const length = readHeader(header);
      if (length !== size) throw new Error(`応答の長さが違います: ${String(length)}`);
      const echoed = await recvExactly(pm, fd, length);

      for (let i = 0; i < length; i++) {
        if (echoed[i] !== ((payload[i] ?? 0) ^ ECHO_MASK)) {
          ok = false;
          throw new Error(`${String(i)}バイト目が違います`);
        }
      }
      bytes += size * 2;
    }
  } finally {
    // C側もやり取りが済んだら閉じる。積んである送り残しは出し切られる
    pm.close_connection(fd);
  }

  return { rounds, bytes, ms: Date.now() - started, ok };
}
