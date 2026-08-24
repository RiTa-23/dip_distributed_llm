import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";

const app = new Hono();

// すべてのレスポンスに COOP/COEP を付与する(#13)。
// WASM版llama.cppがpthread(SharedArrayBuffer)を使うため cross-origin isolation が必須。
// secure context(HTTPS)と合わせて初めて crossOriginIsolated === true になる。
app.use("*", async (c, next) => {
  await next();
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Cross-Origin-Embedder-Policy", "require-corp");
});

// --- 制御プレーン(P1で実装) ---
// app.get("/ws", upgradeWebSocket(...)) を静的配信より前に登録すること。
// ここに来る前に処理されるので SPA フォールバックに飲まれない。

// --- 静的配信(#12) ---
// マウント順が重要: models / wasm を先に処理し、最後に web-dist(SPA)へフォールバックする。
// モデル(GGUF)・WASMグルーコードは ./public から配信。
// 実データ(テンソル)は WebRTC P2P で流れるため Hono は中継しない(AGENTS.md 前提2)。
app.use("/models/*", serveStatic({ root: "./public" }));
app.use("/wasm/*", serveStatic({ root: "./public" }));
// 見つからなければ 404。下の SPA フォールバックに落として index.html を返さないため。
app.get("/models/*", (c) => c.notFound());
app.get("/wasm/*", (c) => c.notFound());

// Reactビルド成果物(#12)。存在するファイルはそのまま配信。
app.use("/*", serveStatic({ root: "./public/web-dist" }));
// SPA フォールバック(#15)。未知パス(例: /requester 直開き)は index.html を返す。
// /models・/wasm は上で処理済みなのでここには来ない。
app.get("*", serveStatic({ path: "./public/web-dist/index.html" }));

// --- TLS(#14 開発用: mkcert) ---
// 証明書があれば HTTPS、無ければ HTTP で起動(CI・クイック確認用)。
// フロント・/ws・モデルを 1 つの HTTPS オリジンから配信する(単一オリジン)。
// 本番デモの警告ゼロ化(飛び入り参加者向け)は別途 #23 で対応する。
const CERT = "./certs/cert.pem";
const KEY = "./certs/key.pem";
const hasTls = existsSync(CERT) && existsSync(KEY);
const port = Number(process.env.PORT ?? (hasTls ? 8443 : 3000));

console.log(
  `Hono server listening on ${hasTls ? "https" : "http"}://localhost:${port} (tls=${hasTls})`,
);

export default {
  port,
  fetch: app.fetch,
  ...(hasTls ? { tls: { cert: Bun.file(CERT), key: Bun.file(KEY) } } : {}),
};
