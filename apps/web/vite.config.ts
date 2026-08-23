import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // WASM版llama.cppがpthreadを使うためSharedArrayBufferが要る。
    // 本番のHono側と同じヘッダを開発サーバーにも付けないと、devでだけ動かない状態になる。
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
