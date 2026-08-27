// ①のWASM(llmletのビルド)を読み込んで、開いたDataChannelの上のRPCへ差し込む起動処理。
//
// 橋渡しの本体は `peerManager.ts` に、両画面への繋ぎ込みは `hooks/usePeerManager.ts` に
// 書き終えてある。ここが受け持つのは「Runtime adapterを読み込んで `Module.PeerManager` に
// 載せ、peer役 / requester役を起動する」ところだけ。
//
// 契約の正本はRuntime側のhandoff bundleにある `HANDOFF.md`。境界は
// `llmlet-runtime.js` の名前付きexport `startPeer()` / `startRequester()` で、
// **`llmlet-mod.js` を直接触らない**(あれはEmscriptenのfactoryで、起動関数は生えていない)。
//
// ダミー経路は持たない。読み込めない・起動できないは**そのまま失敗として返す**。
// 「読めなかったので準備完了ということにする」を作ると、モデルもRPCも通っていないのに
// 画面だけ進む偽の成功になる。
//
// Reactには依存しない。画面から使うときは `hooks/useWasmEngine.ts`(peer役)と
// `hooks/useRequesterRuntime.ts`(requester役)を通す。

import { WASM_MODULE_URL } from "../config";
import type { LlamaPeerManager } from "./peerManager";

/** 参加者はpeer役(RPCサーバ)、発表者はrequester役(RPCクライアント) */
export type EngineRole = "peer" | "requester";

export type EngineLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

const consoleLogger: EngineLogger = {
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
};

/** モデルの渡し方。今回のGateはHonoが配るURL経路を使う */
export type ModelSource = { kind: "file"; file: File } | { kind: "url"; url: string };

/** `startPeer()` が返すもの。`ready` はRPCサーバが起動した時点で解決する */
export type PeerRuntime = {
  ready: Promise<void>;
  stop: () => Promise<void>;
};

/** `startRequester()` が返すもの。`generate()` は1回の生成が終わると解決する */
export type RequesterRuntime = {
  ready: Promise<void>;
  generate: (prompt: string) => Promise<void>;
  cancel: () => void;
  stop: () => Promise<void>;
};

type RuntimeModule = {
  startPeer: (options: Record<string, unknown>) => PeerRuntime;
  startRequester: (options: Record<string, unknown>) => RequesterRuntime;
};

/**
 * 起動を頼んだ側が即座に受け取る箱。
 *
 * `startPeer` / `startRequester` 自体はhandleを同期で返すが、その手前に
 * moduleのdynamic importがあるので、ここだけは非同期になる。
 *
 * **`stop()` は読み込みの途中で呼んでもよい。** 届いたhandleをその場で止める。
 * 画面を離れる操作をAbortSignalだけに任せると、abortしてもRuntime自体は起動を
 * 続けてしまい、止める手が無くなる。
 */
export type RuntimeBox<T> = {
  /** 実体が出来たら解決する。失敗はそのままrejectする */
  started: Promise<T>;
  /** いつ呼んでもよい。読み込み中なら、出来た瞬間に止める */
  stop: () => Promise<void>;
};

type Stoppable = { stop: () => Promise<void> };

function createRuntimeBox<T extends Stoppable>(load: () => Promise<T>): RuntimeBox<T> {
  let handle: T | null = null;
  let stopping: Promise<void> | null = null;

  const started = load().then((created) => {
    handle = created;
    return created;
  });
  // 誰もawaitしないうちに失敗するとunhandledrejectionになる。元のPromiseはそのまま
  // rejectするので、待っている側の見え方は変わらない
  void started.catch(() => {});

  return {
    started,
    stop: () => {
      stopping ??= (async () => {
        let target = handle;
        if (!target) {
          try {
            target = await started;
          } catch {
            return; // そもそも起動していない。止めるものが無い
          }
        }
        await target.stop();
      })();
      return stopping;
    },
  };
}

export type StartPeerOptions = {
  /** `Module.PeerManager` に載せる本体。`usePeerManager()` の `manager` */
  manager: LlamaPeerManager;
  moduleUrl?: string;
  /** モジュールの読み込み。テストで差し替えるためだけに開けてある */
  importModule?: (url: string) => Promise<unknown>;
  onLog?: (line: string) => void;
  onError?: (error: unknown) => void;
  logger?: EngineLogger;
};

export type StartRequesterOptions = StartPeerOptions & {
  /**
   * この世代で使うpeerのid。**順序がそのままRPC deviceの登録順**になるので、
   * Setやobjectの暗黙順に任せず、開いている相手を順序ごと渡す。
   */
  peerIds: string[];
  model: ModelSource;
  onText?: (delta: string) => void;
};

/** peer役(RPCサーバ)を起動する。箱は同期で返る */
export function startPeerRuntime(options: StartPeerOptions): RuntimeBox<PeerRuntime> {
  const log = options.logger ?? consoleLogger;
  return createRuntimeBox(async () => {
    const url = options.moduleUrl ?? WASM_MODULE_URL;
    const mod = await loadRuntimeModule(url, options.importModule ?? importByUrl);
    const runtime = mod.startPeer({
      peerManager: options.manager,
      onLog: options.onLog,
      onError: options.onError,
    });
    log.info(`[wasm] ${url} を読み込み、startPeer() で起動しました`);
    return runtime;
  });
}

/** requester役(RPCクライアント)を起動する。世代ごとに新しく作る */
export function startRequesterRuntime(
  options: StartRequesterOptions,
): RuntimeBox<RequesterRuntime> {
  const log = options.logger ?? consoleLogger;
  return createRuntimeBox(async () => {
    const url = options.moduleUrl ?? WASM_MODULE_URL;
    const mod = await loadRuntimeModule(url, options.importModule ?? importByUrl);
    const runtime = mod.startRequester({
      peerManager: options.manager,
      peerIds: options.peerIds,
      model: options.model,
      onText: options.onText,
      onLog: options.onLog,
      onError: options.onError,
    });
    log.info(
      `[wasm] ${url} を読み込み、startRequester() で起動しました(peers: ${options.peerIds.join(", ")})`,
    );
    return runtime;
  });
}

/**
 * Runtime adapterを読み込む。**見つからなければ投げる。**
 *
 * 旧実装はEmscripten Moduleの上に `startServer` / `startClient` を探しに行き、
 * 見つからなければダミーへ落ちていた。`llmlet-mod.js` にその名前は無いので、
 * bundleを置いた瞬間に「import成功 → entry無し → fallback → 準備完了」という
 * 偽の成功経路が成立してしまう。ここでは落とさずに失敗させる。
 */
export async function loadRuntimeModule(
  url: string,
  importModule: (url: string) => Promise<unknown>,
): Promise<RuntimeModule> {
  const loaded = await importModule(url);
  const startPeer = pickExport(loaded, "startPeer");
  const startRequester = pickExport(loaded, "startRequester");
  if (!startPeer || !startRequester) {
    throw new Error(
      `${url} に startPeer / startRequester がありません。` +
        `Runtimeのhandoff bundle(llmlet-runtime.js)が配信されているか確認してください`,
    );
  }
  return {
    startPeer: startPeer as RuntimeModule["startPeer"],
    startRequester: startRequester as RuntimeModule["startRequester"],
  };
}

/** 既定の読み込み。viteに解決させない(ビルド時点ではファイルが存在しないため) */
function importByUrl(url: string): Promise<unknown> {
  return import(/* @vite-ignore */ url);
}

/** 名前付きexportを拾う。`default` にまとめて入っている形も受ける */
function pickExport(loaded: unknown, name: string): unknown {
  if (typeof loaded !== "object" || loaded === null) return undefined;
  const direct = (loaded as Record<string, unknown>)[name];
  if (typeof direct === "function") return direct;
  const fallback = (loaded as { default?: unknown }).default;
  if (typeof fallback === "object" && fallback !== null) {
    const nested = (fallback as Record<string, unknown>)[name];
    if (typeof nested === "function") return nested;
  }
  return undefined;
}
