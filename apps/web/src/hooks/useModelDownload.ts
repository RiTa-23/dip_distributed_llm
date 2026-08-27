import { useEffect, useState } from "react";
import { MODEL_NAME } from "../config";
import { readWithProgress } from "../lib/modelDownload";

export type ModelDownload = {
  received: number;
  /** Content-Length が取れなかったら null(分母不明) */
  total: number | null;
  status: "loading" | "done" | "failed";
  /** total があるときだけ 0〜1。無ければ null */
  progress: number | null;
};

/**
 * モデル本体(GGUF)を取得しながら進捗を実測する。
 *
 * `useEffect` + `AbortController` にしているのは `useJoinUrl` と同じ理由で、
 * StrictModeの二重実行で2回ダウンロードしないため。
 *
 * 取得に失敗しても `status: "failed"` を返すだけで例外は投げない。
 * モデル本体はまだ推論に使われていない(①のWASMへ渡すのは #71 の範囲)ので、
 * GGUFが置いてあるかどうかだけでデモが死ぬのを避ける(本人判断、2026/8/27)。
 */
export function useModelDownload(): ModelDownload {
  const [received, setReceived] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [status, setStatus] = useState<ModelDownload["status"]>("loading");

  useEffect(() => {
    const controller = new AbortController();
    // チャンクごとにsetStateすると、GB級の転送で毎秒100回超の再描画になり、
    // WebRTC/WASMが動いている最中に一番負荷をかけたくない場所で重なる。
    // usePeerStats.ts と同じ250ms刻みへ間引く。最後の値は completion 側で必ず反映する
    let lastFlush = 0;
    fetch(`/models/${MODEL_NAME}`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        return readWithProgress(
          res,
          (r, t) => {
            const now = Date.now();
            if (now - lastFlush < 250) return;
            lastFlush = now;
            setReceived(r);
            setTotal(t);
          },
          controller.signal,
        );
      })
      .then((finalReceived) => {
        setReceived(finalReceived);
        setStatus("done");
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setStatus("failed");
      });
    return () => controller.abort();
  }, []);

  const progress = total === null ? null : Math.min(1, received / total);

  return { received, total, status, progress };
}
