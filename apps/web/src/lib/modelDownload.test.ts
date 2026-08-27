import { describe, expect, test } from "bun:test";
import { parseContentLength, readWithProgress } from "./modelDownload";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("parseContentLength", () => {
  test("数値のContent-Lengthを返す", () => {
    expect(parseContentLength(new Headers({ "Content-Length": "1024" }))).toBe(1024);
  });

  test("無い・空文字・非数値・0以下はnull(チャンク転送に戻った場合)", () => {
    expect(parseContentLength(new Headers())).toBeNull();
    expect(parseContentLength(new Headers({ "Content-Length": "" }))).toBeNull();
    expect(parseContentLength(new Headers({ "Content-Length": "abc" }))).toBeNull();
    expect(parseContentLength(new Headers({ "Content-Length": "0" }))).toBeNull();
    expect(parseContentLength(new Headers({ "Content-Length": "-5" }))).toBeNull();
  });
});

describe("readWithProgress", () => {
  test("Content-Lengthがある応答は、最後のonProgressが総バイト数と一致する", async () => {
    const body = streamOf(["hello", "world", "!"]);
    const res = new Response(body, { headers: { "Content-Length": "11" } });
    const calls: Array<[number, number | null]> = [];
    const receivedTotal = await readWithProgress(res, (r, t) => calls.push([r, t]));
    expect(receivedTotal).toBe(11);
    const [lastReceived, lastTotal] = calls[calls.length - 1];
    expect(lastReceived).toBe(11);
    expect(lastTotal).toBe(11);
  });

  test("Content-Lengthが無い応答でも読み切れて、totalはnullで通知される", async () => {
    const body = streamOf(["abc", "de"]);
    const res = new Response(body);
    const calls: Array<[number, number | null]> = [];
    const receivedTotal = await readWithProgress(res, (r, t) => calls.push([r, t]));
    expect(receivedTotal).toBe(5);
    for (const [, t] of calls) expect(t).toBeNull();
  });

  test("bodyが無い応答は0を返し、onProgressは呼ばれない", async () => {
    const res = new Response(null);
    let calls = 0;
    const receivedTotal = await readWithProgress(res, () => {
      calls += 1;
    });
    expect(receivedTotal).toBe(0);
    expect(calls).toBe(0);
  });
});
