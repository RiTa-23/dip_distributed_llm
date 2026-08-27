import { Hono } from "hono";
import { createBunWebSocket, serveStatic } from "hono/bun";
import { existsSync, readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { networkInterfaces } from "node:os";
import { Coordinator, type Socket } from "./coordinator";
import { parseClientMessage } from "./parse";
import { buildJoinUrls, normalizePublicOrigin } from "./lanAddress";
import { pickTlsFiles, publicHostFromSan, publicOriginFrom } from "./tlsConfig";

const app = new Hono();
const { upgradeWebSocket, websocket } = createBunWebSocket();
// 状態遷移を1行ずつ出す(#58)。デモ中の切り分けに使う
const coordinator = new Coordinator((line) => console.log(line));

// --- TLS(#14 開発用: mkcert / #23 本番デモ用: Let's Encrypt) ---
// 証明書があれば HTTPS、無ければ HTTP で起動(CI・クイック確認用)。
// フロント・/ws・モデルを 1 つの HTTPS オリジンから配信する(単一オリジン)。
//
// **本番デモ用(certs/prod/)があればそちらを優先する**(#23)。当日に環境変数を
// 並べなくてよいようにするため。無ければ従来通り mkcert(certs/)に落ちるので、
// ネットワークが使えない場所での開発は今まで通り動く。判定は tlsConfig.ts。
const tls = pickTlsFiles(existsSync, process.env);
const hasTls = tls !== null;
const port = Number(process.env.PORT ?? (hasTls ? 8443 : 3000));

/**
 * 参加者に配るオリジン(#23)。QRの既定値になる。
 *
 * 既定では**証明書のSANから決める**。配布URLが証明書と食い違うと警告が出るので、
 * 設定を別に持たず証明書そのものを情報源にする。mkcertの証明書はDNS名が
 * `localhost` だけなので、ここは null になり従来通りLAN IPのURLだけが返る。
 * PUBLIC_ORIGIN を設定すればそちらが優先される。
 */
function resolvePublicOrigin(): string | undefined {
  const fromEnv = process.env.PUBLIC_ORIGIN;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
  if (tls === null) return undefined;
  try {
    const san = new X509Certificate(readFileSync(tls.cert)).subjectAltName;
    return publicOriginFrom(publicHostFromSan(san), port) ?? undefined;
  } catch {
    // 証明書が読めない形でも起動自体は止めない(TLSの起動時に別途失敗する)
    return undefined;
  }
}
const PUBLIC_ORIGIN = resolvePublicOrigin();

// --- 接続の生存確認(#55) ---
// 蓋を閉じたPCやWi-Fiが切れた端末は FIN を送らないため、TCPが死ぬまで onClose が来ない。
// その間ロスターに残り続け、「全員ready」の判定が実態とずれる。
//
// Bunの `idleTimeout` は当てにしない(実測で、無応答の接続を閉じてくれなかった)。
// 代わりにpingを撃って pong の有無を自分で数える。ブラウザはpingに自動でpongを
// 返すので、フロント側の実装は要らない。
// 検知までは最長で間隔の2倍かかる(1回落としただけでは切らないため)。
const WS_PING_INTERVAL_SEC = Number(process.env.WS_PING_INTERVAL_SEC ?? 30);
const WS_PING_INTERVAL_MS = Math.max(1000, WS_PING_INTERVAL_SEC * 1000);

/**
 * 接続ごとの応答状況。キーはBunの ServerWebSocket そのもの。
 * WeakMap にしておくと、接続が消えたときに一緒に回収される。
 */
const awaitingPong = new WeakMap<object, { pending: boolean }>();

/** Honoの型には出てこないが、Bunの ServerWebSocket が持っているもの。 */
type PingableSocket = { ping: () => void; close: (code?: number, reason?: string) => void };

function asPingable(raw: unknown): PingableSocket | null {
  if (raw === null || typeof raw !== "object") return null;
  const c = raw as Partial<PingableSocket>;
  return typeof c.ping === "function" && typeof c.close === "function"
    ? (c as PingableSocket)
    : null;
}

// すべてのレスポンスに COOP/COEP を付与する(#13)。
// WASM版llama.cppがpthread(SharedArrayBuffer)を使うため cross-origin isolation が必須。
// secure context(HTTPS)と合わせて初めて crossOriginIsolated === true になる。
//
// ここで `c.header()` を使ってはいけない(#53)。`c.header()` は Response を作り直し、
// その過程で本文が ReadableStream に化けて `Content-Length` が失われる。全レスポンスが
// チャンク転送になり、GGUFのダウンロードで
//   - 分母が分からずフロントが進捗率を出せない
//   - Range が効かず、途中で切れると最初からやり直しになる
// という症状が出ていた。既存の Headers を直接書き換えれば本文はそのまま通る。
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  c.res.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
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
          ping: () => {
            const sock = asPingable(ws.raw);
            if (!sock) return;
            const state = awaitingPong.get(sock) ?? { pending: false };
            awaitingPong.set(sock, state);
            try {
              if (state.pending) {
                // 前回のpingにpongが返っていない。応答が途絶えたとみなして閉じる。
                // close すると onClose が走り、ロスターからも外れる(#55)
                sock.close(1001, "no pong");
                return;
              }
              state.pending = true;
              sock.ping();
            } catch {
              // 既に閉じかけ。次の巡回か onClose で片付く
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
            // fromId が本人かどうかは roster 側で見る(#54)
            if (clientId) coordinator.signal(clientId, msg);
            break;
          case "requester_accepting":
            if (clientId) coordinator.requesterAccepting(clientId, msg.accepting);
            break;
          case "generation_failed":
            // requester かどうか・世代が合っているかは roster 側で見る(#56)
            if (clientId) coordinator.generationFailed(clientId, msg.generation);
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
  c.json({
    joinUrls: buildJoinUrls(networkInterfaces(), hasTls ? "https" : "http", port, PUBLIC_ORIGIN),
  }),
);

// --- 状態の確認(#58) ---
// デモ中に「何人つながっていて、どの世代で、誰が ready か」をブラウザで見るための口。
// 読み取り専用で、状態は一切変えない。/ws と同じ理由で静的配信より前に置く。
app.get("/status", (c) => c.json(coordinator.status()));

// --- 静的配信(#12) ---
// マウント順が重要: models / wasm を先に処理し、最後に web-dist(SPA)へフォールバックする。
// モデル(GGUF)・WASMグルーコードは ./public から配信。
// 実データ(テンソル)は WebRTC P2P で流れるため Hono は中継しない(AGENTS.md 前提2)。
// Range に対応していることを明示する。`serveStatic` は Range 要求に 206 を返せるが
// `Accept-Ranges` は付けないため、クライアントが試す前に判断できない(#53)
app.use("/models/*", async (c, next) => {
  await next();
  c.res.headers.set("Accept-Ranges", "bytes");
});
app.use("/wasm/*", async (c, next) => {
  await next();
  c.res.headers.set("Accept-Ranges", "bytes");
});
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

// 生きている接続の idleTimeout を延ばし、応答の無い接続を炙り出す(#55)
setInterval(() => coordinator.pingAll(), WS_PING_INTERVAL_MS);

const TLS_LABEL: Record<string, string> = {
  env: "TLS_CERT/TLS_KEY で明示指定",
  demo: "本番デモ用 certs/prod(公開CA。飛び入り参加者に警告が出ない)",
  local: "開発用 certs(mkcert。rootCA導入済みの端末のみ警告ゼロ)",
};

console.log(
  `Hono server listening on ${hasTls ? "https" : "http"}://localhost:${port} (tls=${hasTls})`,
);
if (tls !== null) {
  console.log(`  証明書: ${tls.cert} — ${TLS_LABEL[tls.source] ?? tls.source}`);
}
// 実際に採用される値をログに出す。設定した値がスキーム不一致などで捨てられたときに
// 「既定にします」と出てしまうと、起動ログを見ても気づけない
const effectiveOrigin = normalizePublicOrigin(PUBLIC_ORIGIN, hasTls ? "https" : "http");
if (effectiveOrigin !== null) {
  console.log(`  参加URL: ${effectiveOrigin} を既定にします`);
} else if (PUBLIC_ORIGIN !== undefined) {
  console.log(
    `  参加URL: LAN IP のみ(指定された ${PUBLIC_ORIGIN} は使えないため無視しました。` +
      `${hasTls ? "https" : "http"}:// で始まる絶対URLを指定してください)`,
  );
} else {
  console.log("  参加URL: LAN IP のみ(本番デモ用の証明書を置くとドメインが既定になります)");
}

export default {
  port,
  fetch: app.fetch,
  websocket: {
    ...websocket,
    // pong を受けたら「応答あり」に戻す(#55)。Honoのハンドラには無いので足す
    pong(ws: object) {
      const state = awaitingPong.get(ws);
      if (state) state.pending = false;
    },
  },
  ...(tls !== null ? { tls: { cert: Bun.file(tls.cert), key: Bun.file(tls.key) } } : {}),
};
