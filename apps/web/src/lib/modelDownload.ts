/**
 * `Content-Length` を取り出す。数値にならない・0以下はチャンク転送等で
 * 分母が無い扱いにする(`null`)。
 */
export function parseContentLength(headers: Headers): number | null {
  const raw = headers.get("Content-Length");
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * `res.body` を読み進め、受信バイト数の累計を `onProgress` で通知する。
 *
 * 受信したチャンクは保持せず、長さだけ数えて捨てる。GB級のGGUFを丸ごと
 * メモリへ載せないためで、①のWASMへデータそのものを渡す経路は #71 の範囲。
 * このIssue(#80)は進捗表示までが対象で、受信データの保存・転送はしない。
 */
export async function readWithProgress(
  res: Response,
  onProgress: (received: number, total: number | null) => void,
  signal?: AbortSignal,
): Promise<number> {
  const total = parseContentLength(res.headers);
  const body = res.body;
  if (!body) return 0;

  const reader = body.getReader();
  let received = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      onProgress(received, total);
    }
  } finally {
    reader.releaseLock();
  }
  return received;
}
