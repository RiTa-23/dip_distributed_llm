import { describe, expect, test } from "bun:test";
import { handleModelRequest, modelNameFromPath, parseRange } from "./modelFile";
import type { ModelFile, ModelFileLookup } from "./modelFile";

// `serveStatic` が `/models/*` の **HEAD** に `content-length: 0` を返すことが Gate B-1 で
// 実測された。Runtime adapter は HEAD の `Content-Length` からモデルサイズを決めるので、
// そこが 0 だと URL 経路のモデル読み込みが成立しない。これが専用handlerを置く理由。
// (Range については Bun が BunFile backed Response に 206/416 を自動で返す。B-1 で
//  「Range が効かない」と見えたのは、確定後の `c.header()` による Response 組み直しの
//  二次症状だった。ここで自前に組むのは、その暗黙の振る舞いに依存しないため。)
// ここで見るのは HEAD / 206 / 416 と、掘らせないこと。

const SIZE = 491_400_032;
const NAME = "qwen2.5-0.5b-instruct-q4_k_m.gguf";

/** 実ファイルを置かずに大きさだけ持つ偽物。sliceの引数を記録する */
function createLookup(size = SIZE): ModelFileLookup & { slices: (number | undefined)[][] } {
  const slices: (number | undefined)[][] = [];
  const file: ModelFile = {
    size,
    slice: (start, endExclusive) => {
      slices.push([start, endExclusive]);
      // 中身は見ないので、長さだけ合った空Blobでよい(491MBを実体化しない)
      const length = start === undefined ? 0 : (endExclusive ?? size) - start;
      return new Blob([new Uint8Array(Math.min(length, 8))]);
    },
  };
  const lookup = ((name: string) =>
    Promise.resolve(name === NAME ? file : null)) as ModelFileLookup & {
    slices: (number | undefined)[][];
  };
  lookup.slices = slices;
  return lookup;
}

function request(method: string, path: string, range?: string): Request {
  return new Request(`http://localhost:3100${path}`, {
    method,
    headers: range ? { Range: range } : undefined,
  });
}

describe("modelNameFromPath", () => {
  test("1階層のファイル名だけ通す", () => {
    expect(modelNameFromPath("/models/a.gguf")).toBe("a.gguf");
    expect(modelNameFromPath(`/models/${NAME}`)).toBe(NAME);
  });

  test("掘らせない", () => {
    for (const path of [
      "/models/../../etc/passwd",
      "/models/sub/dir.gguf",
      "/models/..%2f..%2fsecret",
      "/models/a\\b.gguf",
      "/models/",
      "/models/.env",
      "/other/a.gguf",
    ]) {
      expect(modelNameFromPath(path)).toBeNull();
    }
  });

  test("パーセントエンコードされた区切りも通さない", () => {
    // %2F は decode すると "/" になる。decode してから判定する必要がある
    expect(modelNameFromPath("/models/a%2Fb.gguf")).toBeNull();
  });
});

describe("parseRange", () => {
  test("開始と終了", () => {
    expect(parseRange("bytes=0-1", 100)).toEqual({ kind: "range", start: 0, end: 1 });
  });

  test("終了を省くと最後まで", () => {
    expect(parseRange("bytes=10-", 100)).toEqual({ kind: "range", start: 10, end: 99 });
  });

  test("末尾からの長さ", () => {
    expect(parseRange("bytes=-20", 100)).toEqual({ kind: "range", start: 80, end: 99 });
  });

  test("大きすぎる終了は切り詰める", () => {
    expect(parseRange("bytes=90-999", 100)).toEqual({ kind: "range", start: 90, end: 99 });
  });

  test("開始がサイズ以上なら unsatisfiable", () => {
    expect(parseRange("bytes=100-", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=500-600", 100)).toEqual({ kind: "unsatisfiable" });
  });

  test("解釈できないものは無視して全体を返す", () => {
    expect(parseRange("items=0-1", 100)).toEqual({ kind: "ignore" });
    expect(parseRange("bytes=abc", 100)).toEqual({ kind: "ignore" });
    expect(parseRange("bytes=5-1", 100)).toEqual({ kind: "ignore" });
    // 複数レンジはサーバが無視してよい
    expect(parseRange("bytes=0-1,5-6", 100)).toEqual({ kind: "ignore" });
  });

  test("Rangeが無ければ none", () => {
    expect(parseRange(null, 100)).toEqual({ kind: "none" });
  });
});

describe("handleModelRequest", () => {
  test("HEAD は 200 + 実サイズの Content-Length + Accept-Ranges、bodyは空", async () => {
    const res = await handleModelRequest(request("HEAD", `/models/${NAME}`), createLookup());
    expect(res).not.toBeNull();
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-length")).toBe(String(SIZE));
    expect(res?.headers.get("accept-ranges")).toBe("bytes");
    expect(res?.body).toBeNull();
  });

  test("Range無しの GET は 200 + 実サイズの Content-Length", async () => {
    const res = await handleModelRequest(request("GET", `/models/${NAME}`), createLookup());
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-length")).toBe(String(SIZE));
    expect(res?.headers.get("accept-ranges")).toBe("bytes");
  });

  test("単一 Range は 206 + Content-Range + その長さの Content-Length", async () => {
    const lookup = createLookup();
    const res = await handleModelRequest(request("GET", `/models/${NAME}`, "bytes=0-1"), lookup);
    expect(res?.status).toBe(206);
    expect(res?.headers.get("content-range")).toBe(`bytes 0-1/${String(SIZE)}`);
    expect(res?.headers.get("content-length")).toBe("2");
    // endは含むので、sliceには end+1 を渡す
    expect(lookup.slices).toEqual([[0, 2]]);
  });

  test("範囲外の Range は 416 + Content-Range: bytes */size", async () => {
    const res = await handleModelRequest(
      request("GET", `/models/${NAME}`, `bytes=${String(SIZE)}-`),
      createLookup(),
    );
    expect(res?.status).toBe(416);
    expect(res?.headers.get("content-range")).toBe(`bytes */${String(SIZE)}`);
    expect(res?.body).toBeNull();
  });

  test("HEAD でも Range を尊重して 206 を返す(bodyは空)", async () => {
    const res = await handleModelRequest(
      request("HEAD", `/models/${NAME}`, "bytes=10-19"),
      createLookup(),
    );
    expect(res?.status).toBe(206);
    expect(res?.headers.get("content-length")).toBe("10");
    expect(res?.body).toBeNull();
  });

  test("無いファイルは担当外として null(呼び出し側の404へ落とす)", async () => {
    const res = await handleModelRequest(request("GET", "/models/none.gguf"), createLookup());
    expect(res).toBeNull();
  });

  test("掘ろうとするパスは担当外", async () => {
    const res = await handleModelRequest(request("GET", "/models/../index.ts"), createLookup());
    expect(res).toBeNull();
  });

  test("GET / HEAD 以外は担当外", async () => {
    const res = await handleModelRequest(request("POST", `/models/${NAME}`), createLookup());
    expect(res).toBeNull();
  });
});
