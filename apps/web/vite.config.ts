import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * devサーバから `/join-info` と `/ws` をHonoへ中継する先。
 * 本番はHonoがフロントごと配るので同一オリジンで済み、この設定は使わない。
 * 未指定ならプロキシを張らず、QRは今開いているオリジンのURLになる。
 *   例: VITE_HONO_ORIGIN=http://localhost:3000 bun run dev
 */
const honoOrigin = process.env.VITE_HONO_ORIGIN ?? "";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // QRから参加者のスマホで開くので、LANの他の端末から見える必要がある
    host: true,
    // 別オリジンのHonoを直接fetchするとCORSで弾かれるため、devだけプロキシで同一オリジンに見せる。
    // secure:false は mkcert の証明書をNode側が検証できないケースへの対応(dev限定)。
    // `/ws` も同じ入口に寄せる(ws:true)。こうしておくと VITE_HONO_WS_URL を使い分けずに済み、
    // dev でも本番と同じ「同一オリジンへ繋ぐ」経路をそのまま試せる。
    proxy: honoOrigin
      ? {
          "/join-info": { target: honoOrigin, changeOrigin: true, secure: false },
          "/ws": { target: honoOrigin, changeOrigin: true, secure: false, ws: true },
        }
      : undefined,
    // WASM版llama.cppがpthreadを使うためSharedArrayBufferが要る。
    // 本番のHono側と同じヘッダを開発サーバーにも付けないと、devでだけ動かない状態になる。
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
