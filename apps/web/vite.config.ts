import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * devサーバから `/join-info` をHonoへ中継する先。
 * 本番はHonoがフロントごと配るので同一オリジンで済み、この設定は使わない。
 * 未指定ならプロキシを張らず、QRは今開いているオリジンのURLになる。
 *   例: VITE_HONO_ORIGIN=https://localhost:8443 bun run dev
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
    proxy: honoOrigin
      ? { "/join-info": { target: honoOrigin, changeOrigin: true, secure: false } }
      : undefined,
    // WASM版llama.cppがpthreadを使うためSharedArrayBufferが要る。
    // 本番のHono側と同じヘッダを開発サーバーにも付けないと、devでだけ動かない状態になる。
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
