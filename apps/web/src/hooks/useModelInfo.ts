import { useEffect, useState } from "react";
import { MODEL_INFO_PATH, MODEL_NAME, TOTAL_LAYERS } from "../config";
import { parseModelInfo, type ModelInfo } from "../lib/modelInfo";

/** `/model-info` が取れなかったときの保険(#65)。config.ts の仮置き値 */
const FALLBACK: ModelInfo = { name: MODEL_NAME, totalLayers: TOTAL_LAYERS };

/**
 * モデル名・層数をHonoから受け取る(`/model-info`)。
 *
 * `useJoinUrl` と同じく同一オリジンへ問い合わせる。devは vite.config.ts のプロキシが
 * Honoへ中継する。取得に失敗しても `FALLBACK` に落ちて画面は成立する(#65)。
 * 既知のモデルだけを扱うなら値は描画の途中で変わらないが、層バーの総数が出る前に
 * 1描画ぶん仮置き値で引けないよう、取得は初回だけにしている。
 */
export function useModelInfo(): ModelInfo {
  const [model, setModel] = useState<ModelInfo>(FALLBACK);

  useEffect(() => {
    const controller = new AbortController();
    fetch(MODEL_INFO_PATH, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: unknown) => {
        const parsed = parseModelInfo(body);
        if (parsed) setModel(parsed);
      })
      .catch(() => {
        // 取得できなくても既定値で成立するので握りつぶす
      });
    return () => controller.abort();
  }, []);

  return model;
}
