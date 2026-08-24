import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { buildJoinUrls } from "./lanAddress";

const app = new Hono();

// --- TLS(#14 開発用: mkcert) ---
// 証明書があれば HTTPS、無ければ HTTP で起動(CI・クイック確認用)。
// フロント・/ws・モデルを 1 つの HTTPS オリジンから配信する(単一オリジン)。
// 本番デモの警告ゼロ化(飛び入り参加者向け)は別途 #23 で対応する。
const CERT = "./certs/cert.pem";
const KEY = "./certs/key.pem";
const hasTls = existsSync(CERT) && existsSync(KEY);
const port = Number(process.env.PORT ?? (hasTls ? 8443 : 3000));

// すべてのレスポンスに COOP/COEP を付与する(#13)。
// WASM版llama.cppがpthread(SharedArrayBuffer)を使うため cross-origin isolation が必須。
// secure context(HTTPS)と合わせて初めて crossOriginIsolated === true になる。
app.use("*", async (c, next) => {
  await next();
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Cross-Origin-Embedder-Policy", "require-corp");
});

// --- 制御プレーン(P1で実装) ---
// /ws は制御プレーン用に予約。静的配信・SPAフォールバックより前に登録し、
// index.html に飲まれないようにする。WebSocket未実装のうちは 404 を返す。
// P1で upgradeWebSocket(...) を実装する際は、この 404 スタブを置き換える。
app.get("/ws", (c) => c.notFound());
app.get("/ws/*", (c) => c.notFound());

// --- 参加URLの配布(#28) ---
// 発表者画面のQRに入れるURL。ブラウザからは会場のLAN IPが分からないため、
// サーバが自分のNICから割り出して渡す。/ws と同じ理由で静的配信より前に置く。
// WebSocketメッセージにしないのは、QRが接続確立より前に必要になるため(docs/frontend.md)。
app.get("/join-info", (c) =>
  c.json({ joinUrls: buildJoinUrls(networkInterfaces(), hasTls ? "https" : "http", port) }),
);

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

console.log(
  `Hono server listening on ${hasTls ? "https" : "http"}://localhost:${port} (tls=${hasTls})`,
);

export default {
  port,
  fetch: app.fetch,
  ...(hasTls ? { tls: { cert: Bun.file(CERT), key: Bun.file(KEY) } } : {}),
};
