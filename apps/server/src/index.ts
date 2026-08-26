import { Hono } from "hono";
import { createBunWebSocket, serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { Coordinator, type Socket } from "./coordinator";
import { parseClientMessage } from "./parse";
import { buildJoinUrls } from "./lanAddress";

const app = new Hono();
const { upgradeWebSocket, websocket } = createBunWebSocket();
const coordinator = new Coordinator();

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

// --- 制御プレーン(#16-19) ---
// /ws は静的配信・SPAフォールバックより前に登録する(index.html に飲まれないため)。
// Hono が扱うのは JSON(ロスター・シグナリング)のみ。実データは WebRTC P2P(AGENTS.md 前提2)。
app.get(
  "/ws",
  upgradeWebSocket(() => {
    let clientId: string | null = null;
    let socket: Socket | null = null;

    return {
      onOpen(_evt, ws) {
        // 半開き接続への送信で broadcast が止まらないよう send を保護する。
        socket = {
          send: (d) => {
            try {
              ws.send(d);
            } catch {
              // 送信先が閉じかけ。無視して他の宛先を続行。
            }
          },
        };
      },
      onMessage(evt, ws) {
        if (!socket) socket = { send: (d) => ws.send(d) };
        let raw: unknown;
        try {
          raw = JSON.parse(evt.data as string);
        } catch {
          return; // JSON として壊れている。無視(接続は維持)
        }
        // 構造検証。不正・不足は破棄(msg.type にアクセスする前に弾く)。
        const msg = parseClientMessage(raw);
        if (!msg) return;
        switch (msg.type) {
          case "hello":
            if (clientId) break; // 1接続につき hello は一度だけ。2回目以降は無視する。
            // 拒否(例: 2人目の requester)された接続は clientId を確定しない → 以後のメッセージも無視される。
            if (coordinator.hello(msg.clientId, msg.role, msg.displayName, socket)) {
              clientId = msg.clientId;
            }
            break;
          case "peer_status":
            if (clientId) coordinator.peerStatus(clientId, msg.status); // hello 前は無視
            break;
          case "webrtc_signal":
            if (clientId) coordinator.signal(msg);
            break;
          case "requester_accepting":
            if (clientId) coordinator.requesterAccepting(clientId, msg.accepting);
            break;
        }
      },
      onClose() {
        if (clientId && socket) coordinator.disconnect(clientId, socket);
      },
    };
  }),
);
// /ws 配下も制御プレーン用に予約(SPAフォールバックに飲ませない)。
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
  websocket,
  ...(hasTls ? { tls: { cert: Bun.file(CERT), key: Bun.file(KEY) } } : {}),
};
