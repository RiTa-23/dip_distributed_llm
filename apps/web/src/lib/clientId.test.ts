import { describe, expect, test } from "bun:test";
import { getPeerIdOverride } from "./clientId";

describe("getPeerIdOverride", () => {
  test("peerIdをtrimして返す", () => {
    expect(getPeerIdOverride("?peerId=%20peer-1%20")).toBe("peer-1");
  });

  test("未指定・空文字はoverrideしない", () => {
    expect(getPeerIdOverride("")).toBeNull();
    expect(getPeerIdOverride("?peerId=%20%20")).toBeNull();
  });

  test("requester用のquery名はpeer overrideにならない", () => {
    expect(getPeerIdOverride("?requesterId=requester-1")).toBeNull();
  });
});
