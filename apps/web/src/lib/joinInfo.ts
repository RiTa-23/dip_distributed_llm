/**
 * `/join-info` の応答を検証して、参加URLの配列を取り出す。
 *
 * 契約に合わないものは捨てる([`parseServerMessage.ts`](./parseServerMessage.ts)と同じ方針)。
 * 空文字や相対パスを通すと、QRと画面のURL表示が空のまま出てしまい、
 * 呼び出し側の「同一オリジンへ落とす」フォールバックも働かなくなる。
 */
export function parseJoinUrls(body: unknown): string[] {
  if (typeof body !== "object" || body === null) return [];
  const urls = (body as { joinUrls?: unknown }).joinUrls;
  if (!Array.isArray(urls)) return [];
  return urls.filter(isHttpUrl);
}

/** 絶対URLで、かつ http(s) のものだけを通す */
function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
