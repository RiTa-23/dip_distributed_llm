/**
 * 制御プレーンの接続先URLを組む。
 *
 * 既定は画面を配信しているオリジンと同じ。Honoがフロント・モデル・`/ws` を
 * 1つのHTTPSオリジンから配信するため(docs/api-contract.md「接続」)、
 * ホスト名を設定に持たせる必要がない。会場で配布するURLが変わっても追従する。
 *
 * `https:` のときだけ `wss:` にする。`ws:` のままだと混在コンテンツで
 * ブラウザに切られる。
 */
export function buildWsUrl(
  location: { protocol: string; host: string },
  path: string,
  override?: string,
): string {
  // viteのdevサーバ(5173)から動かすときだけ、別ポートのHonoを指す
  if (override) return override;
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}${path}`;
}
