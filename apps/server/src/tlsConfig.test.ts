import { describe, expect, test } from "bun:test";
import {
  DEMO_CERT,
  DEMO_KEY,
  LOCAL_CERT,
  LOCAL_KEY,
  pickTlsFiles,
  publicHostFromSan,
  publicOriginFrom,
} from "./tlsConfig";

/** 「これらのパスだけが存在する」という exists を作る */
const only =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);

describe("pickTlsFiles(証明書の優先順位)", () => {
  test("本番用があればそれを使う(デモ優先。環境変数は要らない)", () => {
    const choice = pickTlsFiles(only(DEMO_CERT, DEMO_KEY, LOCAL_CERT, LOCAL_KEY), {});
    expect(choice).toEqual({ cert: DEMO_CERT, key: DEMO_KEY, source: "demo" });
  });

  test("本番用が無ければ開発用(mkcert)に落ちる", () => {
    const choice = pickTlsFiles(only(LOCAL_CERT, LOCAL_KEY), {});
    expect(choice).toEqual({ cert: LOCAL_CERT, key: LOCAL_KEY, source: "local" });
  });

  test("どちらも無ければ null(HTTPで起動する)", () => {
    expect(pickTlsFiles(only(), {})).toBeNull();
  });

  test("環境変数の明示指定が最優先", () => {
    const choice = pickTlsFiles(only("/tmp/c.pem", "/tmp/k.pem", DEMO_CERT, DEMO_KEY), {
      TLS_CERT: "/tmp/c.pem",
      TLS_KEY: "/tmp/k.pem",
    });
    expect(choice).toEqual({ cert: "/tmp/c.pem", key: "/tmp/k.pem", source: "env" });
  });

  test("環境変数が指すファイルが無ければ既定の探索に落ちる", () => {
    const choice = pickTlsFiles(only(DEMO_CERT, DEMO_KEY), {
      TLS_CERT: "/tmp/none.pem",
      TLS_KEY: "/tmp/none-key.pem",
    });
    expect(choice?.source).toBe("demo");
  });

  test("環境変数が片方だけなら採用しない(書き間違いを拾わない)", () => {
    const choice = pickTlsFiles(only("/tmp/c.pem", LOCAL_CERT, LOCAL_KEY), {
      TLS_CERT: "/tmp/c.pem",
    });
    expect(choice?.source).toBe("local");
  });

  describe("鍵と証明書が揃っていない場合は使わない", () => {
    test("本番用の鍵だけ欠けていれば開発用へ", () => {
      const choice = pickTlsFiles(only(DEMO_CERT, LOCAL_CERT, LOCAL_KEY), {});
      expect(choice?.source).toBe("local");
    });

    test("開発用の鍵だけ欠けていれば null", () => {
      expect(pickTlsFiles(only(LOCAL_CERT), {})).toBeNull();
    });
  });
});

describe("publicHostFromSan(証明書から配布ホスト名を決める)", () => {
  test("公開CAの証明書からドメインを取り出す", () => {
    expect(publicHostFromSan("DNS:llm.example.com")).toBe("llm.example.com");
  });

  test("mkcertの証明書からは取れない(localhostしか無いため)", () => {
    const mkcert = "DNS:localhost, IP Address:127.0.0.1, IP Address:192.168.1.43";
    expect(publicHostFromSan(mkcert)).toBeNull();
  });

  test("IPアドレスは見ない(公開CAが発行しないため)", () => {
    expect(publicHostFromSan("IP Address:192.168.1.43")).toBeNull();
  });

  test("localhost を飛ばして実在ドメインを拾う", () => {
    expect(publicHostFromSan("DNS:localhost, DNS:llm.example.com")).toBe("llm.example.com");
  });

  test("ワイルドカードはホスト名として使えないので飛ばす", () => {
    expect(publicHostFromSan("DNS:*.example.com, DNS:llm.example.com")).toBe("llm.example.com");
  });

  test(".local は会場の他端末から引けないので飛ばす", () => {
    expect(publicHostFromSan("DNS:mac.local, DNS:llm.example.com")).toBe("llm.example.com");
  });

  test("複数の実在ドメインがあれば先頭を使う", () => {
    expect(publicHostFromSan("DNS:a.example.com, DNS:b.example.com")).toBe("a.example.com");
  });

  test("SANが無ければ null", () => {
    expect(publicHostFromSan(undefined)).toBeNull();
    expect(publicHostFromSan("")).toBeNull();
  });
});

describe("publicOriginFrom", () => {
  test("ポートまで含めたオリジンにする", () => {
    expect(publicOriginFrom("llm.example.com", 8443)).toBe("https://llm.example.com:8443");
  });

  test("ホスト名が無ければ null", () => {
    expect(publicOriginFrom(null, 8443)).toBeNull();
  });
});
