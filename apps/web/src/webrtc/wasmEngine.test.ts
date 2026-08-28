import { describe, expect, test } from "bun:test";
import { loadRuntimeModule, startPeerRuntime, startRequesterRuntime } from "./wasmEngine";
import type { EngineLogger, PeerRuntime, RequesterRuntime } from "./wasmEngine";
import type { LlamaPeerManager } from "./peerManager";

// 境界は `llmlet-runtime.js` の名前付きexport `startPeer()` / `startRequester()`。
// ここで見たいのは、
//
// - 渡すべきもの(manager / peerIds の順序 / model / onText)がそのまま届くこと
// - **読み込めない・関数が無い・起動が投げる、のどれもがダミーや準備完了にならないこと**
// - 読み込みの途中で `stop()` しても、出来たRuntimeが確実に止まること
//
// 3つ目が特に効く。旧実装はEmscripten Moduleの上に `startServer` / `startClient` を
// 探しに行き、無ければダミーへ落ちていた。`llmlet-mod.js` にその名前は無いので、
// bundleを置くと「import成功 → entry無し → fallback → 準備完了」という偽の成功が
// 成立してしまう。それを二度と作らないための回帰テスト。

const URL_STUB = "/wasm/llmlet-runtime.js";

function createManager(): LlamaPeerManager {
  return {
    connect: () => undefined,
    accept: () => undefined,
    send: () => 0,
    recv: () => undefined,
    close_connection: () => 0,
    register_buf: () => undefined,
    close: () => undefined,
  };
}

function createLogger(): EngineLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
  };
}

type Recorded = { options: Record<string, unknown>; stopped: number };

/** `startPeer` / `startRequester` を持つ偽モジュール */
function createModule(recorded: Recorded, ready: Promise<void> = Promise.resolve()) {
  const peer: PeerRuntime = {
    ready,
    stop: () => {
      recorded.stopped += 1;
      return Promise.resolve();
    },
  };
  const requester: RequesterRuntime = {
    ready,
    generate: () => Promise.resolve(),
    cancel: () => undefined,
    stop: () => {
      recorded.stopped += 1;
      return Promise.resolve();
    },
  };
  return {
    startPeer: (options: Record<string, unknown>) => {
      recorded.options = options;
      return peer;
    },
    startRequester: (options: Record<string, unknown>) => {
      recorded.options = options;
      return requester;
    },
  };
}

describe("loadRuntimeModule", () => {
  test("名前付きexportを拾う", async () => {
    const recorded: Recorded = { options: {}, stopped: 0 };
    const mod = await loadRuntimeModule(URL_STUB, () => Promise.resolve(createModule(recorded)));
    expect(typeof mod.startPeer).toBe("function");
    expect(typeof mod.startRequester).toBe("function");
  });

  test("default にまとめて入っている形も拾う", async () => {
    const recorded: Recorded = { options: {}, stopped: 0 };
    const mod = await loadRuntimeModule(URL_STUB, () =>
      Promise.resolve({ default: createModule(recorded) }),
    );
    expect(typeof mod.startPeer).toBe("function");
  });

  test("読み込めなければ投げる。ダミーへ落ちない", async () => {
    await expect(
      loadRuntimeModule(URL_STUB, () => Promise.reject(new Error("404"))),
    ).rejects.toThrow("404");
  });

  test("startPeer / startRequester が無ければ投げる(旧 llmlet-mod.js を掴んだ場合)", async () => {
    // Emscriptenのfactoryはdefault exportの関数。起動関数は生えていない
    const emscriptenLike = { default: () => ({ PeerManager: undefined }) };
    await expect(
      loadRuntimeModule(URL_STUB, () => Promise.resolve(emscriptenLike)),
    ).rejects.toThrow(/startPeer \/ startRequester がありません/);
  });
});

describe("startPeerRuntime", () => {
  test("managerを渡して起動する", async () => {
    const recorded: Recorded = { options: {}, stopped: 0 };
    const manager = createManager();
    const logger = createLogger();
    const box = startPeerRuntime({
      manager,
      moduleUrl: URL_STUB,
      importModule: () => Promise.resolve(createModule(recorded)),
      logger,
    });

    const runtime = await box.started;
    await runtime.ready;
    expect(recorded.options.peerManager).toBe(manager);
    expect(logger.lines.some((l) => l.includes("startPeer()"))).toBe(true);
  });

  test("CPU peer指定をRuntimeへ渡す", async () => {
    const recorded: Recorded = { options: {}, stopped: 0 };
    const box = startPeerRuntime({
      manager: createManager(),
      moduleUrl: URL_STUB,
      importModule: () => Promise.resolve(createModule(recorded)),
      disableWebGPU: true,
      logger: createLogger(),
    });

    await box.started;
    expect(recorded.options.disableWebGPU).toBe(true);
  });

  test("読み込みに失敗したら started が reject する。準備完了にはならない", async () => {
    const box = startPeerRuntime({
      manager: createManager(),
      moduleUrl: URL_STUB,
      importModule: () => Promise.reject(new Error("読み込み失敗")),
      logger: createLogger(),
    });
    await expect(box.started).rejects.toThrow("読み込み失敗");
  });

  test("失敗しても stop() は投げない", async () => {
    const box = startPeerRuntime({
      manager: createManager(),
      moduleUrl: URL_STUB,
      importModule: () => Promise.reject(new Error("読み込み失敗")),
      logger: createLogger(),
    });
    await expect(box.stop()).resolves.toBeUndefined();
  });

  test("読み込みの途中で stop() しても、出来たRuntimeを止める", async () => {
    const recorded: Recorded = { options: {}, stopped: 0 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const box = startPeerRuntime({
      manager: createManager(),
      moduleUrl: URL_STUB,
      importModule: async () => {
        await gate;
        return createModule(recorded);
      },
      logger: createLogger(),
    });

    // まだmoduleが届いていない時点で止める
    const stopping = box.stop();
    release();
    await stopping;
    expect(recorded.stopped).toBe(1);
  });

  test("stop() を重ねて呼んでも1回しか止めない", async () => {
    const recorded: Recorded = { options: {}, stopped: 0 };
    const box = startPeerRuntime({
      manager: createManager(),
      moduleUrl: URL_STUB,
      importModule: () => Promise.resolve(createModule(recorded)),
      logger: createLogger(),
    });
    await box.started;
    await Promise.all([box.stop(), box.stop(), box.stop()]);
    expect(recorded.stopped).toBe(1);
  });
});

describe("startRequesterRuntime", () => {
  test("peerIdsを順序ごと、modelとonTextをそのまま渡す", async () => {
    const recorded: Recorded = { options: {}, stopped: 0 };
    const deltas: string[] = [];
    const box = startRequesterRuntime({
      manager: createManager(),
      moduleUrl: URL_STUB,
      importModule: () => Promise.resolve(createModule(recorded)),
      peerIds: ["peer-b", "peer-a", "peer-c"],
      model: { kind: "url", url: "/models/x.gguf" },
      args: ["-c", "2048"],
      onText: (delta) => deltas.push(delta),
      logger: createLogger(),
    });

    await box.started;
    // 並びがRPC deviceの登録順になる。ソートも重複排除もしない
    expect(recorded.options.peerIds).toEqual(["peer-b", "peer-a", "peer-c"]);
    expect(recorded.options.model).toEqual({ kind: "url", url: "/models/x.gguf" });
    expect(recorded.options.args).toEqual(["-c", "2048"]);

    const onText = recorded.options.onText as (delta: string) => void;
    onText("あ");
    expect(deltas).toEqual(["あ"]);
  });

  test("local GGUF Fileをそのまま渡す", async () => {
    const recorded: Recorded = { options: {}, stopped: 0 };
    const file = new File(["gguf"], "Qwen3.6-35B-A3B.Q2_K.gguf");
    const box = startRequesterRuntime({
      manager: createManager(),
      moduleUrl: URL_STUB,
      importModule: () => Promise.resolve(createModule(recorded)),
      peerIds: ["peer-a"],
      model: { kind: "file", file },
      args: ["-c", "2048"],
      onText: () => undefined,
      logger: createLogger(),
    });

    await box.started;
    expect(recorded.options.model).toEqual({ kind: "file", file });
    expect(recorded.options.args).toEqual(["-c", "2048"]);
  });

  test("関数が見つからなければ reject する", async () => {
    const box = startRequesterRuntime({
      manager: createManager(),
      moduleUrl: URL_STUB,
      importModule: () => Promise.resolve({ somethingElse: () => undefined }),
      peerIds: ["peer-a"],
      model: { kind: "url", url: "/models/x.gguf" },
      onText: () => undefined,
      logger: createLogger(),
    });
    await expect(box.started).rejects.toThrow(/startPeer \/ startRequester がありません/);
  });
});
