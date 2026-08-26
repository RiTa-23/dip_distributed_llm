import { describe, expect, test } from "bun:test";
import { createEngineStarter, startWasmEngine } from "./wasmEngine";
import type { EngineLogger, LlmletModule, StartEngineOptions } from "./wasmEngine";
import type { LlamaPeerManager } from "./peerManager";

// ①のビルドはまだ無いので、読み込みの結果だけを差し替えて分岐を見る。
// 見たいのは「モジュールが有る/無い」でこちらの振る舞いが変わることと、
// 無いほうが既定である今もダミー経路で必ず準備完了まで進むこと。

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

function createLogger(): EngineLogger & { info: (m: string) => void; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
  };
}

/** テストのあいだは待ち時間を潰す。既定(2200ms)を待つ意味はない */
function options(extra: Partial<StartEngineOptions> = {}): StartEngineOptions {
  return {
    role: "peer",
    manager: createManager(),
    nodeId: "peer-1",
    moduleUrl: "/wasm/llmlet-mod.js",
    fallbackDelayMs: 1,
    entryTimeoutMs: 5,
    logger: createLogger(),
    ...extra,
  };
}

describe("startWasmEngine", () => {
  test("モジュールが無ければダミー経路へ落ちる(①のビルドが来るまでの既定)", async () => {
    const logger = createLogger();
    const result = await startWasmEngine(
      options({
        logger,
        importModule: () => Promise.reject(new Error("404")),
      }),
    );

    expect(result.mode).toBe("fallback");
    if (result.mode === "fallback") expect(result.reason).toContain("読み込めませんでした");
    // 成否がコンソールで区別できること
    expect(logger.lines.some((line) => line.startsWith("warn"))).toBe(true);
    expect(logger.lines.some((line) => line.startsWith("info"))).toBe(false);
  });

  test("モジュールがあれば PeerManager を差し込んで起動する", async () => {
    const manager = createManager();
    const calls: string[] = [];
    const released: number[] = [];
    const mod: LlmletModule = {
      release_conn: (ptr) => released.push(ptr),
      startServer: (nodeId: string) => calls.push(`startServer:${nodeId}`),
    };
    const logger = createLogger();

    const result = await startWasmEngine(
      options({
        manager,
        logger,
        importModule: () => Promise.resolve({ default: () => mod }),
      }),
    );

    expect(result.mode).toBe("wasm");
    if (result.mode !== "wasm") return;
    expect(mod.PeerManager).toBe(manager);
    expect(calls).toEqual(["startServer:peer-1"]);
    expect(result.entry).toBe("startServer");
    // releaseBuf はWASM側の release_conn へ素通しする
    result.releaseBuf?.(1234);
    expect(released).toEqual([1234]);
    expect(logger.lines.some((line) => line.startsWith("info"))).toBe(true);
  });

  test("factory を介さず組み立て済みのモジュールが来ても載る", async () => {
    const manager = createManager();
    const mod: LlmletModule = { startServer: () => undefined };

    const result = await startWasmEngine(
      options({ manager, importModule: () => Promise.resolve(mod) }),
    );

    expect(result.mode).toBe("wasm");
    expect(mod.PeerManager).toBe(manager);
  });

  test("release_conn が無いビルドでも起動し、releaseBuf だけ省く", async () => {
    const mod: LlmletModule = { startServer: () => undefined };

    const result = await startWasmEngine(
      options({ importModule: () => Promise.resolve({ default: () => mod }) }),
    );

    expect(result.mode).toBe("wasm");
    if (result.mode === "wasm") expect(result.releaseBuf).toBeUndefined();
  });

  test("発表者は rpc-client 役の起動関数を呼ぶ", async () => {
    const calls: string[] = [];
    const mod: LlmletModule = {
      startServer: () => calls.push("startServer"),
      startClient: () => calls.push("startClient"),
    };

    const result = await startWasmEngine(
      options({
        role: "requester",
        importModule: () => Promise.resolve({ default: () => mod }),
      }),
    );

    expect(result.mode).toBe("wasm");
    expect(calls).toEqual(["startClient"]);
  });

  test("起動関数が見つからなければダミー経路へ落ちる", async () => {
    const mod: LlmletModule = { release_conn: () => undefined };

    const result = await startWasmEngine(
      options({ importModule: () => Promise.resolve({ default: () => mod }) }),
    );

    expect(result.mode).toBe("fallback");
    if (result.mode === "fallback") expect(result.reason).toContain("起動関数が見つかりません");
  });

  test("起動関数が失敗したらダミー経路へ落ちる", async () => {
    const mod: LlmletModule = {
      startServer: () => {
        throw new Error("boom");
      },
    };

    const result = await startWasmEngine(
      options({ importModule: () => Promise.resolve({ default: () => mod }) }),
    );

    expect(result.mode).toBe("fallback");
    if (result.mode === "fallback") expect(result.reason).toContain("startServer()");
  });

  test("起動関数がPromiseで失敗した場合もダミー経路へ落ちる", async () => {
    const mod: LlmletModule = { startServer: () => Promise.reject(new Error("boom")) };

    const result = await startWasmEngine(
      options({ importModule: () => Promise.resolve({ default: () => mod }) }),
    );

    expect(result.mode).toBe("fallback");
  });

  test("待ち受けに入ったまま返らない起動関数は、走っているものとして扱う", async () => {
    // rpc-server役は戻らない作りがありうる。待ち続けると準備中のまま止まる
    const mod: LlmletModule = { startServer: () => new Promise(() => undefined) };

    const result = await startWasmEngine(
      options({ entryTimeoutMs: 5, importModule: () => Promise.resolve({ default: () => mod }) }),
    );

    expect(result.mode).toBe("wasm");
  });

  test("中断されたらダミーの待ち時間を待たずに返る", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();

    const result = await startWasmEngine(
      options({
        fallbackDelayMs: 10_000,
        signal: controller.signal,
        importModule: () => Promise.reject(new Error("404")),
      }),
    );

    expect(result.mode).toBe("fallback");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("createEngineStarter", () => {
  /** 起動関数の呼ばれた回数と、読み込みを外から解決できる口を返す */
  function createModuleSource() {
    const state = { imports: 0, started: 0, release: [] as number[] };
    let release: ((value: unknown) => void) | null = null;
    const mod: LlmletModule = {
      release_conn: (ptr) => state.release.push(ptr),
      startServer: () => state.started++,
    };
    return {
      state,
      /** 保留していた読み込みを終わらせる */
      finish: () => release?.({ default: () => mod }),
      importModule: (): Promise<unknown> => {
        state.imports++;
        if (release) return Promise.resolve({ default: () => mod });
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    };
  }

  test("起動中に呼び直されたら相乗りする(離脱→再参加でrpc-serverを2つ立てない)", async () => {
    const source = createModuleSource();
    const starter = createEngineStarter();
    const opts = options({ importModule: source.importModule });

    // 1回目(参加)→ 起動が返る前に2回目(離脱してすぐ再参加)
    const first = starter.start(opts);
    const second = starter.start(opts);
    source.finish();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe(b);
    expect(a.mode).toBe("wasm");
    expect(source.state.imports).toBe(1);
    expect(source.state.started).toBe(1);
  });

  test("一度載ったら次の参加では載せ直さない", async () => {
    const source = createModuleSource();
    const starter = createEngineStarter();
    const opts = options({ importModule: source.importModule });

    const first = starter.start(opts);
    source.finish();
    await first;
    const again = await starter.start(opts);

    expect(again.mode).toBe("wasm");
    expect(source.state.imports).toBe(1);
    expect(source.state.started).toBe(1);
  });

  test("中断されても、載ったことは覚えている", async () => {
    // 起動が終わる直前に離脱した場合。忘れると再参加で startServer() をもう一度呼ぶ
    const source = createModuleSource();
    const starter = createEngineStarter();
    const controller = new AbortController();
    const opts = options({ importModule: source.importModule, signal: controller.signal });

    const first = starter.start(opts);
    controller.abort();
    source.finish();
    expect((await first).mode).toBe("wasm");

    await starter.start(opts);
    expect(source.state.started).toBe(1);
  });

  test("ダミー経路は覚えない(参加のたびに待たせる)", async () => {
    let imports = 0;
    const starter = createEngineStarter();
    const opts = options({
      importModule: () => {
        imports++;
        return Promise.reject(new Error("404"));
      },
    });

    expect((await starter.start(opts)).mode).toBe("fallback");
    expect((await starter.start(opts)).mode).toBe("fallback");
    expect(imports).toBe(2);
  });
});
