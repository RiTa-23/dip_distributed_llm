// `/models/<name>` の**実配線**に対する HTTP レベルの回帰テスト。
//
// `modelFile.test.ts` は `handleModelRequest()` 単体を見ている。こちらが見るのは
// `index.ts` の配線そのもの — route の登録順と、COOP/COEP の付与形式。
//
// この2つは単体テストでは落ちない形で壊れる。特に COOP/COEP を `await next()` の**後**に
// `c.header()` で足すと、hono が確定済み Response を組み直して
//   - `Content-Length` が消える
//   - `BunFile.slice()` の body が範囲を失い、数バイトの Range に全ファイルが返る
// という状態になるが、`handleModelRequest()` 自体は正しい Response を返し続けるので
// 単体テストは緑のまま通る。実際にHTTPで叩いて初めて分かる。
//
// 巨大な GGUF は要らない。数百バイトの fixture で契約は全部確認できる。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import serverConfig from "./index";

/** `bunModelLookup("./public/models")` が見に行く先。cwd は apps/server */
const MODEL_DIR = "./public/models";
const FIXTURE_NAME = "__http-contract-fixture.gguf";
const FIXTURE_PATH = `${MODEL_DIR}/${FIXTURE_NAME}`;
/** 中身は何でもよいが、位置で判別できるようにしておく */
const BODY = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz".repeat(8), "utf8");

let base = "";
let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(async () => {
  await writeFile(FIXTURE_PATH, BODY);
  // `fetch` だけを使う。TLS や websocket はこのテストに要らないので持ち込まない。
  // ポートは 0(空きポート)にして、開発サーバと衝突させない。
  server = Bun.serve({ port: 0, fetch: serverConfig.fetch });
  base = `http://localhost:${String(server.port)}`;
});

afterAll(async () => {
  server?.stop(true);
  await rm(FIXTURE_PATH, { force: true });
});

/** 全レスポンスに載っていないといけないもの(SharedArrayBuffer の前提) */
function expectIsolated(res: Response) {
  expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  expect(res.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
}

describe("/models/<name> の HTTP 契約", () => {
  test("HEAD は 200 + 実サイズの正の Content-Length + Accept-Ranges", async () => {
    const res = await fetch(`${base}/models/${FIXTURE_NAME}`, { method: "HEAD" });
    expect(res.status).toBe(200);
    // Runtime adapter はこの値だけを頼りにモデルサイズを決める。0 だとその場で失敗する
    expect(res.headers.get("content-length")).toBe(String(BODY.byteLength));
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expectIsolated(res);
  });

  test("Range 無しの GET は 200 + 実サイズ + 中身一致", async () => {
    const res = await fetch(`${base}/models/${FIXTURE_NAME}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(BODY.byteLength));
    const got = Buffer.from(await res.arrayBuffer());
    expect(got.byteLength).toBe(BODY.byteLength);
    expect(got.equals(BODY)).toBe(true);
    expectIsolated(res);
  });

  test("単一 Range は 206 + Content-Range + その長さだけの body", async () => {
    const res = await fetch(`${base}/models/${FIXTURE_NAME}`, {
      headers: { Range: "bytes=10-19" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 10-19/${String(BODY.byteLength)}`);
    expect(res.headers.get("content-length")).toBe("10");
    const got = Buffer.from(await res.arrayBuffer());
    // ここが全 body になっていたら、Response が組み直されて範囲が失われている
    expect(got.byteLength).toBe(10);
    expect(got.equals(BODY.subarray(10, 20))).toBe(true);
    expectIsolated(res);
  });

  test("範囲外の Range は 416 + Content-Range: bytes */size", async () => {
    const res = await fetch(`${base}/models/${FIXTURE_NAME}`, {
      headers: { Range: "bytes=9000000000-" },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${String(BODY.byteLength)}`);
    expectIsolated(res);
  });

  test("無いモデルは 404(SPA の index.html に落ちない)", async () => {
    const res = await fetch(`${base}/models/does-not-exist.gguf`);
    expect(res.status).toBe(404);
    expectIsolated(res);
  });
});

describe("Hono が作る Response 側", () => {
  // 生の Response(上のモデル配信)だけでなく、Hono 製の Response にも同じ形式で
  // 載ることを確認する。`/join-info` は fresh clone でも必ず存在する経路。
  // SPA フォールバックは web-dist が無い環境では 404 と見分けが付かないので使わない。
  test("/join-info にも COOP/COEP が載る", async () => {
    const res = await fetch(`${base}/join-info`);
    expect(res.status).toBe(200);
    expectIsolated(res);
  });
});
