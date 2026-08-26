import { describe, expect, test } from "bun:test";
import { startWasmEngine } from "./wasmEngine";
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
