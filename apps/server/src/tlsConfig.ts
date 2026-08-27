// どの証明書で起動するかの決定(#14 / #23)。
//
// 2つの使い方を両立させる。
//   本番デモ … 実在ドメイン + 公開CA(Let's Encrypt)。飛び入り参加者に警告が出ない。
//              名前解決だけネットに出る
//   開発     … mkcert。rootCAを入れた端末でのみ警告ゼロ。ネット不要で完結する
//
// **本番用があればそちらを優先する。** デモを最優先にしたいので、当日に環境変数を
// 並べる必要がない形にしてある。本番用が無ければ従来通り mkcert に落ちるので、
// ネットワークが使えない場所での開発は今まで通り動く。
//
// ファイルの有無を引数で受け取る純関数にしてあるのは、実際のディスクを触らずに
// 優先順位をテストするため。

/** 証明書の出どころ。起動ログに出して、いまどちらで動いているかを一目で分かるようにする。 */
export type TlsSource = "env" | "demo" | "local";

export type TlsChoice = { cert: string; key: string; source: TlsSource };

/** 本番デモ用。`bun run cert`(mkcert)はここを書かないので、上書き事故が起きない */
export const DEMO_CERT = "./certs/prod/cert.pem";
export const DEMO_KEY = "./certs/prod/key.pem";

/** 開発用(mkcert)。`bun run cert` が生成する先 */
export const LOCAL_CERT = "./certs/cert.pem";
export const LOCAL_KEY = "./certs/key.pem";

/**
 * 使う証明書を決める。見つからなければ null(呼び出し側はHTTPで起動する)。
 *
 * 優先順位:
 *   1. TLS_CERT / TLS_KEY … 明示指定。置き場所を自由にしたいとき
 *   2. certs/prod/       … 本番デモ用。**あればこれが既定**
 *   3. certs/           … 開発用(mkcert)
 */
export function pickTlsFiles(
  exists: (path: string) => boolean,
  env: Record<string, string | undefined>,
): TlsChoice | null {
  const TLS_CERT = env.TLS_CERT;
  const TLS_KEY = env.TLS_KEY;
  // 片方だけの指定は書き間違いの可能性が高い。黙って無視せず、呼び出し側で警告できるよう
  // 「両方揃っているときだけ採用する」に寄せてある
  if (TLS_CERT !== undefined && TLS_KEY !== undefined && exists(TLS_CERT) && exists(TLS_KEY)) {
    return { cert: TLS_CERT, key: TLS_KEY, source: "env" };
  }
  if (exists(DEMO_CERT) && exists(DEMO_KEY)) {
    return { cert: DEMO_CERT, key: DEMO_KEY, source: "demo" };
  }
  if (exists(LOCAL_CERT) && exists(LOCAL_KEY)) {
    return { cert: LOCAL_CERT, key: LOCAL_KEY, source: "local" };
  }
  return null;
}

/**
 * 証明書のSANから、参加者に配れるホスト名を1つ選ぶ。無ければ null。
 *
 * 配布URLは証明書と食い違ってはいけない(食い違うと警告が出る)ので、
 * 設定を別に持たず証明書そのものから決める。mkcertの証明書は DNS名が
 * `localhost` しか無いため、ここで自然に null になり本番扱いされない。
 *
 * `subjectAltName` の形式は `DNS:a.example.com, IP Address:192.168.1.1` のような
 * カンマ区切り(node:crypto の X509Certificate が返す形)。
 */
export function publicHostFromSan(subjectAltName: string | undefined): string | null {
  if (subjectAltName === undefined) return null;
  for (const entry of subjectAltName.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed.startsWith("DNS:")) continue; // IPアドレスは公開CAが発行しないので見ない
    const host = trimmed.slice("DNS:".length).trim();
    if (host === "") continue;
    // ワイルドカードはホスト名として使えない
    if (host.startsWith("*")) continue;
    // 手元でしか引けない名前は参加者に配れない
    if (host === "localhost" || host.endsWith(".localhost")) continue;
    if (host.endsWith(".local")) continue;
    return host;
  }
  return null;
}

/** 参加者に配るオリジン。ホスト名が取れなければ null。 */
export function publicOriginFrom(host: string | null, port: number): string | null {
  return host === null ? null : `https://${host}:${port}`;
}
