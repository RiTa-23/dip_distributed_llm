export function formatBytes(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} GB`;
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)} MB`;
  return `${Math.round(n / 1000)} KB`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("ja-JP");
}

/**
 * 実測がまだ1件も無いときに出す印。
 * 0と書くと「計測して0だった」に見えるので、動いていないことと区別する。
 */
export const NO_VALUE = "—";

/** 応答時間。桁を跨いでも表示の幅が暴れないように単位を切り替える */
export function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 10) return `${Math.round(ms)} ms`;
  return `${ms.toFixed(1)} ms`;
}
