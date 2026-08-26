// ①のWASM(llmletのビルド)を読み込んで、開いたDataChannelの上のRPCへ差し込む起動処理。
//
// 橋渡しの本体は `peerManager.ts` に、両画面への繋ぎ込みは `hooks/usePeerManager.ts` に
// 書き終えてある。ここが受け持つのは「WASMを読み込んで `Module.PeerManager` に載せ、
// rpc-server / rpc-client 役を起動する」ところだけ。
//
// **①のビルドはまだ無い**(`/wasm/llmlet-mod.js` は404)。読み込みや起動に失敗したら
// 従来のダミー(一定時間待って準備完了)へ落ちる。落ちなければ、ビルドが会場で届くまで
// 参加者画面が一切進まなくなる。
//
// Reactには依存しない。画面から使うときは `hooks/useWasmEngine.ts` を通す。

import { WASM_MODULE_URL } from "../config";
import type { LlamaPeerManager } from "./peerManager";

/** WASM側の解放関数。`register_buf` で預かった番地を返す先(`Module.release_conn`) */
export type ReleaseBuf = (ptr: number) => void;

/**
 * ①のビルドが返すEmscriptenのModule。こちらが触るのは3つだけ。
 *
 * - `PeerManager` … 我々が差し込む口。WASM側はこれ越しにしか回線を触らない
 * - `release_conn` … `-sEXPORTED_RUNTIME_METHODS` に入っていれば生えている
 * - 起動関数 … 名前は `ENTRY_NAMES` の候補から探す(下記)
 */
export type LlmletModule = {
  PeerManager?: LlamaPeerManager;
  release_conn?: ReleaseBuf;
} & Record<string, unknown>;

/** 参加者はrpc-server役、発表者はrpc-client役 */
export type EngineRole = "peer" | "requester";

/**
 * 起動関数の名前の候補。①のビルドが来たら、実際の名前がここに無ければ足す(1行で済む)。
 * llmletでの呼び名は `startServer` / `startClient` なので先頭に置いている。
 */
const ENTRY_NAMES: Record<EngineRole, readonly string[]> = {
  peer: ["startServer", "start_server", "startPeerServer"],
  requester: ["startClient", "start_client", "startRequesterClient"],
};

/** ダミー経路の待ち時間。従来 `PeerView` に直書きされていた2200msをそのまま持ってきた */
export const FALLBACK_BOOT_MS = 2200;

/**
 * 起動関数がPromiseを返したときに、それを待つ上限。
 * rpc-server役は「動いているあいだ戻らない」作りがありうるので、返らないことを
 * 失敗とは見なさない(下記 `runEntry`)。
 */
export const ENTRY_TIMEOUT_MS = 5000;

export type EngineLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

const consoleLogger: EngineLogger = {
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
};

export type EngineStartResult =
  | {
      mode: "wasm";
      module: LlmletModule;
      /** 実際に呼んだ起動関数の名前。どれが当たったかをログと画面外から追えるように */
      entry: string;
      /** `Module.release_conn` があれば包んだもの。無ければ undefined */
      releaseBuf?: ReleaseBuf;
    }
  | { mode: "fallback"; reason: string };

export type StartEngineOptions = {
  role: EngineRole;
  /** `Module.PeerManager` に載せる本体。`usePeerManager()` の `manager` */
  manager: LlamaPeerManager;
  /**
   * 自分のclientId。llama.cppの `rpc_servers` の文字列がそのまま
   * `connect(nodeId, done)` に渡るので、ここは `lib/clientId.ts` の値をそのまま入れる。
   */
  nodeId: string;
  /** 既定は `config.ts` の `WASM_MODULE_URL` */
  moduleUrl?: string;
  /** モジュールの読み込み。テストで差し替えるためだけに開けてある */
  importModule?: (url: string) => Promise<unknown>;
  fallbackDelayMs?: number;
  entryTimeoutMs?: number;
  /**
   * ダミー経路の待ちを打ち切る。画面を離れたときに2.2秒を待たせないためのもの。
   *
   * **読み込めた側は中断しない。** 途中で捨てると、WASM側だけ起動しているのに
   * こちらは「起動していない」と思っている状態が残り、再参加でもう一度
   * 起動関数を呼んでしまう。中断しても結果は返るので、呼ぶ側が `aborted` を見る。
   */
  signal?: AbortSignal;
  logger?: EngineLogger;
};

/**
 * WASMを読み込んで起動する。**失敗しても投げない。** 読み込めなければ
 * `fallbackDelayMs` だけ待ってから `{ mode: "fallback" }` を返す。
 *
 * 呼ぶ側は返ってきた時点で「準備完了」として扱ってよい(どちらの経路でも同じ)。
 * 成否はコンソールの `[wasm]` 行で区別できる。
 */
export async function startWasmEngine(options: StartEngineOptions): Promise<EngineStartResult> {
  const { role, manager, nodeId, signal } = options;
  const url = options.moduleUrl ?? WASM_MODULE_URL;
  const log = options.logger ?? consoleLogger;
  const fallbackDelayMs = options.fallbackDelayMs ?? FALLBACK_BOOT_MS;

  const fallback = async (reason: string): Promise<EngineStartResult> => {
    log.warn(`[wasm] ${reason} ダミーの起動(${String(fallbackDelayMs)}ms待ち)へ切り替えます`);
    await delay(fallbackDelayMs, signal);
    return { mode: "fallback", reason };
  };

  let mod: LlmletModule;
  try {
    mod = await instantiate(url, options.importModule ?? importByUrl, manager);
  } catch (error) {
    return fallback(`${url} を読み込めませんでした(${describeError(error)})。`);
  }

  // ここから先は中断で抜けない。読み込めた以上、最後まで進めて結果を返す
  // (`signal` のコメントを参照)

  // 差し込み。これ以降、WASM側は我々のDataChannelを回線として使える。
  // factoryへも同じものを渡してあるが(instantiate)、初期化の作りに依らないよう二重に置く
  mod.PeerManager = manager;

  // `release_conn` が `-sEXPORTED_RUNTIME_METHODS` に含まれていないビルドもありうる。
  // そのときは releaseBuf を省いたまま動かす(解放すべきバッファがそもそも作られない)
  const rawRelease = mod.release_conn;
  const releaseBuf: ReleaseBuf | undefined =
    typeof rawRelease === "function" ? (ptr) => rawRelease.call(mod, ptr) : undefined;
  if (!releaseBuf) {
    log.warn(
      "[wasm] Module.release_conn がありません。releaseBuf を省いたまま動かします" +
        "(ビルド時の -sEXPORTED_RUNTIME_METHODS に release_conn を足すと繋がります)",
    );
  }

  const entry = findEntry(mod, role);
  if (!entry) {
    return fallback(
      `${role} の起動関数が見つかりません(探した名前: ${ENTRY_NAMES[role].join(" / ")})。`,
    );
  }

  const started = await runEntry(entry.fn, nodeId, options.entryTimeoutMs ?? ENTRY_TIMEOUT_MS, log);
  if (!started) return fallback(`${entry.name}() が失敗しました。`);

  log.info(`[wasm] ${url} を読み込み、${entry.name}() で起動しました(nodeId: ${nodeId})`);
  return { mode: "wasm", module: mod, entry: entry.name, releaseBuf };
}

export type EngineStarter = {
  /** 起動する。走っている最中に呼ばれたら相乗りし、載ったあとは覚えたものを返す */
  start: (options: StartEngineOptions) => Promise<EngineStartResult>;
};

/**
 * 「1つのPeerManagerに対してエンジンは1つ」を守る箱。画面ごとに1つ持つ。
 *
 * 参加 → 離脱 → 再参加で `start()` は何度でも呼ばれる。素通しすると2つの問題が出る。
 *
 * - **起動中に再参加すると、2つ目のrpc-serverが同じ `manager` の上に立つ。**
 *   起動関数が返らない作りだと窓は `ENTRY_TIMEOUT_MS` まで開く
 * - **一度載ったWASMは載せ直せない。** `Module.PeerManager` を差し替える手段がない
 *
 * どちらも「走っているものに相乗りする」「載ったら覚える」で塞げる。
 * ダミー経路は覚えない(参加のたびに従来どおり待たせる)。
 */
export function createEngineStarter(): EngineStarter {
  let loaded: EngineStartResult | null = null;
  let inFlight: Promise<EngineStartResult> | null = null;

  return {
    start: (options) => {
      if (loaded) return Promise.resolve(loaded);
      if (inFlight) return inFlight;

      const boot = startWasmEngine(options).then((result) => {
        if (result.mode === "wasm") loaded = result;
        if (inFlight === boot) inFlight = null;
        return result;
      });
      inFlight = boot;
      return boot;
    },
  };
}

/** 既定の読み込み。viteに解決させない(ビルド時点ではファイルが存在しないため) */
function importByUrl(url: string): Promise<unknown> {
  return import(/* @vite-ignore */ url);
}

/**
 * 読み込んだものをModuleの形にする。
 * Emscriptenの `MODULARIZE` 出力はModuleを返すfactoryをdefault exportするので、
 * 関数ならfactoryとして呼ぶ。既に組み立て済みのオブジェクトが来る形も受ける。
 */
async function instantiate(
  url: string,
  importModule: (url: string) => Promise<unknown>,
  manager: LlamaPeerManager,
): Promise<LlmletModule> {
  const loaded = await importModule(url);
  const factory = pickFactory(loaded);
  if (!factory) {
    if (isModuleLike(loaded)) return loaded;
    throw new Error("Moduleを組み立てる関数が見つかりません");
  }
  // 初期化の途中でPeerManagerを見る作りでも噛み合うよう、factoryにも渡しておく
  const created: unknown = await factory({ PeerManager: manager });
  if (!isModuleLike(created)) throw new Error("初期化がModuleを返しませんでした");
  return created;
}

type ModuleFactory = (moduleArg?: Record<string, unknown>) => unknown;

function pickFactory(loaded: unknown): ModuleFactory | null {
  if (typeof loaded === "function") return loaded as ModuleFactory;
  if (typeof loaded === "object" && loaded !== null) {
    const fromDefault = (loaded as { default?: unknown }).default;
    if (typeof fromDefault === "function") return fromDefault as ModuleFactory;
  }
  return null;
}

function isModuleLike(value: unknown): value is LlmletModule {
  return typeof value === "object" && value !== null;
}

function findEntry(mod: LlmletModule, role: EngineRole): { name: string; fn: ModuleEntry } | null {
  for (const name of ENTRY_NAMES[role]) {
    const candidate = mod[name];
    if (typeof candidate === "function") return { name, fn: candidate as ModuleEntry };
  }
  return null;
}

type ModuleEntry = (nodeId: string) => unknown;

/**
 * 起動関数を呼ぶ。戻り値がPromiseなら待つが、**返らないことを失敗とは見なさない**。
 * rpc-server役は待ち受けに入ったまま戻らない作りがありうるので、待ち続けると
 * 参加者画面が準備中のまま止まる。一定時間で「走っている」と見なして先へ進める。
 *
 * 引数は自分のnodeIdだけ渡す。受け取らない実装でも余分な引数は無視される。
 */
async function runEntry(
  fn: ModuleEntry,
  nodeId: string,
  timeoutMs: number,
  log: EngineLogger,
): Promise<boolean> {
  let returned: unknown;
  try {
    returned = fn(nodeId);
  } catch (error) {
    log.warn(`[wasm] 起動関数が例外で終わりました(${describeError(error)})`);
    return false;
  }
  if (!isThenable(returned)) return true;

  const timer = new AbortController();
  try {
    // 先に片付いたほうを採る。rejectはここで受け止めるので、後から起きても素通りしない
    const finished = returned.then(
      () => true,
      (error: unknown) => {
        log.warn(`[wasm] 起動関数が失敗しました(${describeError(error)})`);
        return false;
      },
    );
    const running = delay(timeoutMs, timer.signal).then(() => {
      log.info(`[wasm] 起動関数が${String(timeoutMs)}ms返らないので、走っているものとして進みます`);
      return true;
    });
    return await Promise.race([finished, running]);
  } finally {
    timer.abort();
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** 中断されたら待たずに解決する。中断は失敗ではないので投げない */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(id);
      resolve();
    };
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
