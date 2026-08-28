import { describe, expect, test } from "bun:test";
import { parseClientMessage } from "./parse";

describe("parseClientMessage", () => {
  test("非オブジェクト(null / 数値 / 文字列)は null", () => {
    expect(parseClientMessage(null)).toBeNull();
    expect(parseClientMessage(42)).toBeNull();
    expect(parseClientMessage("hello")).toBeNull();
    expect(parseClientMessage(undefined)).toBeNull();
  });

  test("未知の type は null", () => {
    expect(parseClientMessage({ type: "bogus" })).toBeNull();
    expect(parseClientMessage({})).toBeNull();
  });

  test("hello: フィールド不足・不正な role は null", () => {
    expect(parseClientMessage({ type: "hello", role: "peer" })).toBeNull();
    expect(
      parseClientMessage({ type: "hello", role: "boss", clientId: "c", displayName: "n" }),
    ).toBeNull();
  });

  test("hello: 妥当なら既知フィールドだけ通す", () => {
    const m = parseClientMessage({
      type: "hello",
      role: "peer",
      clientId: "c-1",
      displayName: "太郎のPC",
      extra: "ignored",
    });
    expect(m).toEqual({ type: "hello", role: "peer", clientId: "c-1", displayName: "太郎のPC" });
  });

  test("peer_status: 不正な status は null / 妥当ならオプショナルも通す", () => {
    expect(parseClientMessage({ type: "peer_status", status: "bogus" })).toBeNull();
    expect(parseClientMessage({ type: "peer_status", status: "ready" })).toEqual({
      type: "peer_status",
      status: "ready",
    });
    expect(
      parseClientMessage({ type: "peer_status", status: "error", errorMessage: "boom" }),
    ).toEqual({ type: "peer_status", status: "error", errorMessage: "boom" });
  });

  test("webrtc_signal: payload/kind の検証", () => {
    expect(parseClientMessage({ type: "webrtc_signal", targetId: "a", fromId: "b" })).toBeNull();
    expect(
      parseClientMessage({
        type: "webrtc_signal",
        targetId: "a",
        fromId: "b",
        payload: { kind: "bogus" },
      }),
    ).toBeNull();
    const m = parseClientMessage({
      type: "webrtc_signal",
      targetId: "a",
      fromId: "b",
      payload: { kind: "offer", sdp: "v=0..." },
    });
    expect(m).toEqual({
      type: "webrtc_signal",
      targetId: "a",
      fromId: "b",
      payload: { kind: "offer", sdp: "v=0..." },
    });
  });

  test("requester_accepting: acceptingがboolean以外なら null", () => {
    expect(parseClientMessage({ type: "requester_accepting" })).toBeNull();
    expect(parseClientMessage({ type: "requester_accepting", accepting: "true" })).toBeNull();
  });

  test("requester_accepting: 妥当なら通す", () => {
    expect(parseClientMessage({ type: "requester_accepting", accepting: false })).toEqual({
      type: "requester_accepting",
      accepting: false,
    });
    expect(parseClientMessage({ type: "requester_accepting", accepting: true })).toEqual({
      type: "requester_accepting",
      accepting: true,
    });
  });
});

describe("generation_failed(#56)", () => {
  test("正しい形は通す", () => {
    expect(parseClientMessage({ type: "generation_failed", generation: 3 })).toEqual({
      type: "generation_failed",
      generation: 3,
    });
  });

  test("世代0も有効", () => {
    expect(parseClientMessage({ type: "generation_failed", generation: 0 })).toEqual({
      type: "generation_failed",
      generation: 0,
    });
  });

  test("generation が無い", () => {
    expect(parseClientMessage({ type: "generation_failed" })).toBeNull();
  });

  test("generation が数値でない", () => {
    expect(parseClientMessage({ type: "generation_failed", generation: "3" })).toBeNull();
  });

  test("小数・NaN・負数は弾く(現世代との比較が常に外れるため)", () => {
    expect(parseClientMessage({ type: "generation_failed", generation: 1.5 })).toBeNull();
    expect(parseClientMessage({ type: "generation_failed", generation: NaN })).toBeNull();
    expect(parseClientMessage({ type: "generation_failed", generation: -1 })).toBeNull();
  });
});

describe("model_changed(モデル差し替えによる組み直し)", () => {
  test("正しい形は通す", () => {
    expect(parseClientMessage({ type: "model_changed", generation: 3 })).toEqual({
      type: "model_changed",
      generation: 3,
    });
  });

  test("generation が無い", () => {
    expect(parseClientMessage({ type: "model_changed" })).toBeNull();
  });

  test("小数・負数・NaN は弾く", () => {
    // 通すと現世代との比較が常に外れ、「押しているのに何も起きない」になる
    for (const generation of [1.5, -1, Number.NaN]) {
      expect(parseClientMessage({ type: "model_changed", generation })).toBeNull();
    }
  });
});
