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

export function parseModelInfo(body: unknown): ModelInfo | null {
  if (typeof body !== "object" || body === null) return null;
  const { name, totalLayers } = body as { name?: unknown; totalLayers?: unknown };
  if (typeof name !== "string" || name === "") return null;
  if (typeof totalLayers !== "number" || !Number.isInteger(totalLayers) || totalLayers <= 0) {
    return null;
  }
  return { name, totalLayers };
}
