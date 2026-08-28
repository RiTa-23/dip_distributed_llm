/**
 * `/model-info` の応答を検証して、モデル名と層数を取り出す。
 *
 * 契約に合わないものは捨てる([`parseJoinUrls`](./joinInfo.ts)と同じ方針)。
 * 空文字や非正数を通すと、モデルURLが `/models/` のまま壊れたり層バーが破綻する。
 */
export type ModelInfo = {
  /** `/models/<name>` の `<name>` */
  name: string;
  totalLayers: number;
};

/**
 * `/model-info` の応答を検証して `ModelInfo` を取り出す。
 *
 * 契約(文字列で非空の `name`、正整数の `totalLayers`)に合わないものは捨てて `null` を
 * 返す(呼び出し側は `config.ts` のフォールバックへ落ちる)。
 * 適合しない値を通すと、モデルURLが `/models/` のまま壊れたり層バーが破綻する。
 */
export function parseModelInfo(body: unknown): ModelInfo | null {
  if (typeof body !== "object" || body === null) return null;
  const { name, totalLayers } = body as { name?: unknown; totalLayers?: unknown };
  if (typeof name !== "string" || name === "") return null;
  if (typeof totalLayers !== "number" || !Number.isInteger(totalLayers) || totalLayers <= 0) {
    return null;
  }
  return { name, totalLayers };
}
