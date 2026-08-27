import { describe, expect, test } from "bun:test";
import { parseJoinUrls } from "./joinInfo";

describe("parseJoinUrls", () => {
  test("http(s)の絶対URLだけを通す", () => {
    const body = { joinUrls: ["https://192.168.11.5:8443/", "http://10.0.5.7:3000/"] };
    expect(parseJoinUrls(body)).toEqual(["https://192.168.11.5:8443/", "http://10.0.5.7:3000/"]);
  });

  test("空文字は捨てる(QRと表示が空になるため)", () => {
    expect(parseJoinUrls({ joinUrls: ["", "https://192.168.11.5:8443/"] })).toEqual([
      "https://192.168.11.5:8443/",
    ]);
  });

  test("相対パス・http以外のスキームは捨てる", () => {
    expect(parseJoinUrls({ joinUrls: ["/join", "javascript:alert(1)", "ws://x/"] })).toEqual([]);
  });

  test("文字列以外が混ざっていても落ちない", () => {
    expect(parseJoinUrls({ joinUrls: [null, 42, "https://192.168.11.5:8443/"] })).toEqual([
      "https://192.168.11.5:8443/",
    ]);
  });

  test("形が違うものは空配列(index.htmlが返るdevサーバなど)", () => {
    expect(parseJoinUrls(null)).toEqual([]);
    expect(parseJoinUrls("<!doctype html>")).toEqual([]);
    expect(parseJoinUrls({})).toEqual([]);
    expect(parseJoinUrls({ joinUrls: "https://192.168.11.5:8443/" })).toEqual([]);
  });
});
