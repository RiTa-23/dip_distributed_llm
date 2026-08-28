// `/model-info` の HTTP 契約(#65)。
//
// フロントはこの値を使って層バーの総数とモデルURLを組み立てる。取得に失敗しても
// フォールバックで画面は成立するが、「サーバが返す値が情報源」という契約自体は
// HTTPレベルで固めておく。`hono が作る Response` 経路なので COOP/COEP も確認する
// (`modelRoute.test.ts` と同じ形式)。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import serverConfig from "./index";
import { MODEL_NAME, TOTAL_LAYERS } from "./modelInfo";

let base = "";
let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(async () => {
  server = Bun.serve({ port: 0, fetch: serverConfig.fetch });
  base = `http://localhost:${String(server.port)}`;
});

afterAll(async () => {
  server?.stop(true);
});

describe("/model-info の HTTP 契約", () => {
  test("モデル名と層数を返す", async () => {
    const res = await fetch(`${base}/model-info`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name?: unknown; totalLayers?: unknown };
    expect(body).toEqual({ name: MODEL_NAME, totalLayers: TOTAL_LAYERS });
  });

  test("COOP/COEP が載る(フロント側に同じヘッダがいらない)", async () => {
    const res = await fetch(`${base}/model-info`);
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(res.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
  });

  test("層数は1以上(0だと層バーが破綻する)", async () => {
    expect(TOTAL_LAYERS).toBeGreaterThan(0);
  });
});
