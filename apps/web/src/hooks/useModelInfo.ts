import { useEffect, useState } from "react";
import { MODEL_INFO_PATH, MODEL_NAME, TOTAL_LAYERS } from "../config";
import { parseModelInfo, type ModelInfo } from "../lib/modelInfo";

/** `/model-info` が取れなかったときの保険(#65)。config.ts の仮置き値 */
const FALLBACK: ModelInfo = { name: MODEL_NAME, totalLayers: TOTAL_LAYERS };

export type UseModelInfo = ModelInfo & {
  /**
   * `/model-info` の取得が完了または失敗確定した(値がこれ以上変わらない)。
   * `false` の間は `model` が仮置きの可能性がある。
   */
  settled: boolean;
};

/**
 * モデル名・層数をHonoから受け取る(`/model-info`)。
 *
 * `useJoinUrl` と同じく同一オリジンへ問い合わせる。devは vite.config.ts のプロキシが
 * Honoへ中継する。取得に失敗しても `FALLBACK` に落ちて画面は成立する(#65)。
 * 既知のモデルだけを扱うなら値は描画の途中で変わらないが、層バーの総数が出る前に
 * 1描画ぶん仮置き値で引けないよう、取得は初回だけにしている。
 *
 * `settled` は、フォールバック(`model` が仮置き)でRuntimeを起動して後から乖離する
 * 事故を避けるために返す(`useRequesterRuntime` が起動を待つ)。取得し終わったら以後
 * 変わらないので、`settled` になった時点の値が確定値になる。
 */
export function useModelInfo(): UseModelInfo {
  const [model, setModel] = useState<ModelInfo>(FALLBACK);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(MODEL_INFO_PATH, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: unknown) => {
        const parsed = parseModelInfo(body);
        if (parsed) setModel(parsed);
        setSettled(true);
      })
      .catch(() => {
        // 取得できなくても既定値で成立するので握りつぶす
        setSettled(true);
      });
    return () => controller.abort();
  }, []);

  return { ...model, settled };
}
