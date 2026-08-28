// 配布するモデルの情報(#65)。`/model-info` はここをそのまま返す。
//
// モデル名は `public/models/` に置く実モデルと一致させること
// (`apps/server/README.md` の「モデル(GGUF)」参照)。サーバが配る値がフロントの
// 層バー・モデルURLの唯一の情報源になる。
//
// 層数は「本来は①のWASMから取れるはずの値」の仮置き。issue #59(モデル切り替え)で
// 動的に選ぶようになるまでは、この定数が情報源。

export const MODEL_NAME = "qwen2.5-0.5b-instruct-q4_k_m.gguf";
export const TOTAL_LAYERS = 32;

export type ModelInfo = {
  /** `/models/<name>` の `<name>` */
  name: string;
  totalLayers: number;
};

export function modelInfo(): ModelInfo {
  return { name: MODEL_NAME, totalLayers: TOTAL_LAYERS };
}
