import { describe, expect, test } from "bun:test";
import { buildWsUrl } from "./wsUrl";

describe("buildWsUrl", () => {
  test("HTTPSで配信されていれば wss になる", () => {
    expect(buildWsUrl({ protocol: "https:", host: "192.168.1.10:8443" }, "/ws")).toBe(
      "wss://192.168.1.10:8443/ws",
    );
  });

  test("HTTP(localhostでの開発)なら ws になる", () => {
    expect(buildWsUrl({ protocol: "http:", host: "localhost:3000" }, "/ws")).toBe(
      "ws://localhost:3000/ws",
    );
  });

  test("上書きがあればそれを使う(devサーバとHonoが別ポートのとき)", () => {
    expect(
      buildWsUrl({ protocol: "http:", host: "localhost:5173" }, "/ws", "wss://localhost:8443/ws"),
    ).toBe("wss://localhost:8443/ws");
  });

  test("上書きが空文字なら同一オリジンへ繋ぐ", () => {
    expect(buildWsUrl({ protocol: "https:", host: "localhost:8443" }, "/ws", "")).toBe(
      "wss://localhost:8443/ws",
    );
  });
});
