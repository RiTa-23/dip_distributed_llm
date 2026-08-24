import { describe, expect, test } from "bun:test";
import type {
  GenerationAbortedMessage,
  GenerationStartMessage,
  RosterUpdateMessage,
  WebrtcSignalMessage,
} from "@dip_distributed_llm/shared-types/messages";
import { parseServerMessage } from "./parseServerMessage";

const roster: RosterUpdateMessage = {
  type: "roster_update",
  peers: [{ clientId: "c-1", displayName: "太郎のPC", status: "ready" }],
};

describe("parseServerMessage", () => {
  test("契約どおりの4種はそのまま通る", () => {
    expect(parseServerMessage(JSON.stringify(roster))).toEqual(roster);

    const start: GenerationStartMessage = {
      type: "generation_start",
      generation: 3,
      peerIds: ["c-1", "c-2"],
    };
    expect(parseServerMessage(JSON.stringify(start))).toEqual(start);

    const aborted: GenerationAbortedMessage = {
      type: "generation_aborted",
      generation: 3,
      reason: "peer_disconnected",
      message: "メンバーが変わったため再編成します",
    };
    expect(parseServerMessage(JSON.stringify(aborted))).toEqual(aborted);

    const signal: WebrtcSignalMessage = {
      type: "webrtc_signal",
      targetId: "c-1",
      fromId: "c-req",
      payload: { kind: "offer", sdp: "v=0..." },
    };
    expect(parseServerMessage(JSON.stringify(signal))).toMatchObject(signal);
  });

  test("ロスターが空でも通る(まだ誰も来ていない状態)", () => {
    const empty: RosterUpdateMessage = { type: "roster_update", peers: [] };
    expect(parseServerMessage(JSON.stringify(empty))).toEqual(empty);
  });

  test("candidate は中身を検証せずそのまま運ぶ", () => {
    const signal: WebrtcSignalMessage = {
      type: "webrtc_signal",
      targetId: "c-1",
      fromId: "c-req",
      payload: { kind: "ice-candidate", candidate: { candidate: "candidate:0 1 UDP ...", foo: 1 } },
    };
    const parsed = parseServerMessage(JSON.stringify(signal));
    expect(parsed).toMatchObject(signal);
  });

  test("壊れたJSONは捨てる", () => {
    expect(parseServerMessage("{")).toBeNull();
    expect(parseServerMessage("")).toBeNull();
  });

  test("契約にない type は捨てる", () => {
    expect(parseServerMessage(JSON.stringify({ type: "token", text: "あ" }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "hello", role: "peer" }))).toBeNull();
  });

  test("フィールドが欠けている・型が違うものは捨てる", () => {
    expect(parseServerMessage(JSON.stringify({ type: "roster_update" }))).toBeNull();
    // 1人でも壊れていたらロスター全体を捨てる
    expect(
      parseServerMessage(
        JSON.stringify({
          type: "roster_update",
          peers: [{ clientId: "c-1", displayName: "太郎のPC", status: "sleeping" }],
        }),
      ),
    ).toBeNull();
    expect(
      parseServerMessage(
        JSON.stringify({ type: "generation_start", generation: "3", peerIds: [] }),
      ),
    ).toBeNull();
    expect(
      parseServerMessage(
        JSON.stringify({ type: "generation_start", generation: 1, peerIds: [1, 2] }),
      ),
    ).toBeNull();
    expect(
      parseServerMessage(
        JSON.stringify({
          type: "generation_aborted",
          generation: 1,
          reason: "unknown",
          message: "",
        }),
      ),
    ).toBeNull();
    expect(
      parseServerMessage(
        JSON.stringify({ type: "webrtc_signal", targetId: "c-1", fromId: "c-req", payload: {} }),
      ),
    ).toBeNull();
  });

  test("JSONテキスト以外(Blob/ArrayBuffer)は捨てる", () => {
    expect(parseServerMessage(new ArrayBuffer(8))).toBeNull();
    expect(parseServerMessage(null)).toBeNull();
    expect(parseServerMessage(roster)).toBeNull();
  });
});
