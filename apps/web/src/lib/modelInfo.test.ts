// `/model-info` の応答の検証(`parseModelInfo`)。
// 契約に合わないものは捨てて null(呼び出し側は config のフォールバックへ落ちる)。

import { describe, expect, test } from "bun:test";
import { parseModelInfo } from "./modelInfo";

describe("parseModelInfo", () => {
  test("正しい形はそのまま返す", () => {
    expect(parseModelInfo({ name: "model.gguf", totalLayers: 32 })).toEqual({
      name: "model.gguf",
      totalLayers: 32,
    });
  });

  test("層数が小数・0以下・非数は捨てる", () => {
    expect(parseModelInfo({ name: "model.gguf", totalLayers: 32.5 })).toBeNull();
    expect(parseModelInfo({ name: "model.gguf", totalLayers: 0 })).toBeNull();
    expect(parseModelInfo({ name: "model.gguf", totalLayers: -1 })).toBeNull();
    expect(parseModelInfo({ name: "model.gguf", totalLayers: "32" })).toBeNull();
    expect(parseModelInfo({ name: "model.gguf", totalLayers: NaN })).toBeNull();
  });

  test("モデル名が空・非文字列は捨てる", () => {
    expect(parseModelInfo({ name: "", totalLayers: 32 })).toBeNull();
    expect(parseModelInfo({ name: 123, totalLayers: 32 })).toBeNull();
  });

  test("形が違う・欠けているものは捨てる", () => {
    expect(parseModelInfo(null)).toBeNull();
    expect(parseModelInfo("model")).toBeNull();
    expect(parseModelInfo({ name: "model.gguf" })).toBeNull();
    expect(parseModelInfo({ totalLayers: 32 })).toBeNull();
    // index.html が返ってくるケース(プロキシ無し)も面と同じ扱い
    expect(parseModelInfo({ prop: "value" })).toBeNull();
  });
});
