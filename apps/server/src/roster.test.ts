import { describe, expect, test } from "bun:test";
import type {
  ServerMessage,
  WebrtcSignalMessage,
} from "@dip_distributed_llm/shared-types/messages";
import {
  applyDisconnect,
  applyHello,
  applyPeerStatus,
  applyRequesterAccepting,
  applySignal,
  createState,
  currentRoster,
  type Effect,
} from "./roster";

/** broadcast Effect のメッセージだけ取り出す。 */
function broadcasts(effects: Effect[]): ServerMessage[] {
  return effects.filter((e) => e.kind === "broadcast").map((e) => e.msg);
}

/** 指定 type の最初の broadcast を返す。 */
function firstOf<T extends ServerMessage["type"]>(
  effects: Effect[],
  type: T,
): Extract<ServerMessage, { type: T }> | undefined {
  return broadcasts(effects).find((m) => m.type === type) as
    | Extract<ServerMessage, { type: T }>
    | undefined;
}

describe("ロスター管理", () => {
  test("hello 後のロスターは peer のみ(requester は含まない)", () => {
    const s = createState();
    applyHello(s, "req", "requester", "発表者");
    applyHello(s, "p1", "peer", "太郎のPC");

    const roster = currentRoster(s);
    expect(roster).toEqual([{ clientId: "p1", displayName: "太郎のPC", status: "connecting" }]);
  });

  test("peer_status で status が反映される", () => {
    const s = createState();
    applyHello(s, "p1", "peer", "太郎のPC");
    applyPeerStatus(s, "p1", "ready");
    expect(currentRoster(s)[0]?.status).toBe("ready");
  });

  test("hello 前の peer_status は無視される(例外を投げない)", () => {
    const s = createState();
    expect(applyPeerStatus(s, "unknown", "ready")).toEqual([]);
  });
});

describe("generation_start 判定", () => {
  test("全peer ready + requester 接続で一度だけ発火し generation が増える", () => {
    const s = createState();
    applyHello(s, "req", "requester", "発表者");
    applyHello(s, "p1", "peer", "P1");
    applyHello(s, "p2", "peer", "P2");
    applyPeerStatus(s, "p1", "ready");

    // まだ p2 が connecting なので発火しない
    const notYet = applyPeerStatus(s, "p2", "connecting");
    expect(firstOf(notYet, "generation_start")).toBeUndefined();

    const started = applyPeerStatus(s, "p2", "ready");
    const gs = firstOf(started, "generation_start");
    expect(gs).toBeDefined();
    expect(gs?.generation).toBe(1);
    expect(gs?.peerIds.sort()).toEqual(["p1", "p2"]);
    expect(s.phase).toBe("active");
  });

  test("requester 不在では peer が全員 ready でも発火しない", () => {
    const s = createState();
    applyHello(s, "p1", "peer", "P1");
    const eff = applyPeerStatus(s, "p1", "ready");
    expect(firstOf(eff, "generation_start")).toBeUndefined();
    expect(s.phase).toBe("idle");

    // requester が後から来たら発火する
    const eff2 = applyHello(s, "req", "requester", "発表者");
    expect(firstOf(eff2, "generation_start")).toBeDefined();
  });

  // 「既存メンバーの再送では二重発火しない」は「生成中の新規peer加入(#34)」の
  // 「既に稼働中の世代に含まれるpeerがstatusを再送しても誤発火しない」でカバー。
  // 生成中に新規peerが加入した場合の再編成もそちらを参照。
});

describe("生成中の新規peer加入(#34)", () => {
  test("acceptingGrowth既定(true)なら新規peerがreadyになった瞬間に再編成される", () => {
    const s = createState();
    applyHello(s, "req", "requester", "発表者");
    applyHello(s, "p1", "peer", "P1");
    applyPeerStatus(s, "p1", "ready"); // gen 1 開始
    expect(s.generation).toBe(1);

    applyHello(s, "p2", "peer", "P2");
    const eff = applyPeerStatus(s, "p2", "ready");
    const aborted = firstOf(eff, "generation_aborted");
    expect(aborted?.reason).toBe("peer_joined");
    expect(aborted?.generation).toBe(1);
    const restarted = firstOf(eff, "generation_start");
    expect(restarted?.generation).toBe(2);
    expect(restarted?.peerIds.sort()).toEqual(["p1", "p2"]);
  });

  test("acceptingGrowth=falseの間はreadyになっても再編成されず、roster_updateのみ", () => {
    const s = createState();
    applyHello(s, "req", "requester", "発表者");
    applyHello(s, "p1", "peer", "P1");
    applyPeerStatus(s, "p1", "ready"); // gen 1 開始

    applyRequesterAccepting(s, "req", false);
    applyHello(s, "p2", "peer", "P2");
    const eff = applyPeerStatus(s, "p2", "ready");
    expect(firstOf(eff, "generation_aborted")).toBeUndefined();
    expect(firstOf(eff, "roster_update")).toBeDefined();
    expect(s.generation).toBe(1);
    expect(s.phase).toBe("active");
  });

  test("false→trueに戻した瞬間、保留中の複数readyがまとめて1回で取り込まれる", () => {
    const s = createState();
    applyHello(s, "req", "requester", "発表者");
    applyHello(s, "p1", "peer", "P1");
    applyPeerStatus(s, "p1", "ready"); // gen 1 開始

    applyRequesterAccepting(s, "req", false);
    applyHello(s, "p2", "peer", "P2");
    applyPeerStatus(s, "p2", "ready"); // 保留
    applyHello(s, "p3", "peer", "P3");
    applyPeerStatus(s, "p3", "ready"); // 保留

    const eff = applyRequesterAccepting(s, "req", true);
    const abortedCount = broadcasts(eff).filter((m) => m.type === "generation_aborted").length;
    expect(abortedCount).toBe(1); // 2人分まとめて1回だけ
    const restarted = firstOf(eff, "generation_start");
    expect(restarted?.generation).toBe(2);
    expect(restarted?.peerIds.sort()).toEqual(["p1", "p2", "p3"]);
  });

  test("requester以外(peer)がrequester_acceptingを送っても無視される", () => {
    const s = createState();
    applyHello(s, "req", "requester", "発表者");
    applyHello(s, "p1", "peer", "P1");
    applyPeerStatus(s, "p1", "ready"); // gen 1 開始

    const eff = applyRequesterAccepting(s, "p1", false); // p1はpeerなので無視されるべき
    expect(eff).toEqual([]);
    expect(s.acceptingGrowth).toBe(true);
  });

  test("requesterの切断でacceptingGrowthがtrueにリセットされる", () => {
    const s = createState();
    applyHello(s, "req", "requester", "発表者");
    applyHello(s, "p1", "peer", "P1");
    applyPeerStatus(s, "p1", "ready"); // gen 1 開始
    applyRequesterAccepting(s, "req", false);
    expect(s.acceptingGrowth).toBe(false);

    applyDisconnect(s, "req");
    expect(s.acceptingGrowth).toBe(true);
  });

  test("requesterのhello(再接続)でもacceptingGrowthがtrueにリセットされる", () => {
    const s = createState();
    applyHello(s, "req", "requester", "発表者");
    applyHello(s, "p1", "peer", "P1");
    applyPeerStatus(s, "p1", "ready"); // gen 1 開始
    applyRequesterAccepting(s, "req", false);
    expect(s.acceptingGrowth).toBe(false);

    applyHello(s, "req", "requester", "発表者"); // 同一clientIdでの直接再登録
    expect(s.acceptingGrowth).toBe(true);
  });

  test("既に稼働中の世代に含まれるpeerがstatusを再送しても誤発火しない", () => {
    const s = createState();
    applyHello(s, "req", "requester", "発表者");
    applyHello(s, "p1", "peer", "P1");
    applyPeerStatus(s, "p1", "ready"); // gen 1 開始

    const eff = applyPeerStatus(s, "p1", "ready"); // 冪等な再送
    expect(firstOf(eff, "generation_aborted")).toBeUndefined();
    expect(s.generation).toBe(1);
  });

  test("disconnectはacceptingGrowthの値に関わらず常に即座に再編成する", () => {
    const s = createState();
    applyHello(s, "req", "requester", "発表者");
    applyHello(s, "p1", "peer", "P1");
    applyHello(s, "p2", "peer", "P2");
    applyPeerStatus(s, "p1", "ready");
    applyPeerStatus(s, "p2", "ready"); // gen 1 開始
    applyRequesterAccepting(s, "req", false);

    const eff = applyDisconnect(s, "p2");
    const aborted = firstOf(eff, "generation_aborted");
    expect(aborted?.reason).toBe("peer_disconnected");
    expect(aborted?.generation).toBe(1);
  });
});

describe("切断処理", () => {
  test("active 中の peer 切断で中断通知(現世代番号)→ idle 復帰", () => {
    const s = createState();
    applyHello(s, "req", "requester", "発表者");
    applyHello(s, "p1", "peer", "P1");
    applyHello(s, "p2", "peer", "P2");
    applyPeerStatus(s, "p1", "ready");
    applyPeerStatus(s, "p2", "ready"); // gen 1 開始
    expect(s.generation).toBe(1);

    const eff = applyDisconnect(s, "p2");
    const aborted = firstOf(eff, "generation_aborted");
    expect(aborted).toBeDefined();
    expect(aborted?.generation).toBe(1); // 中断した「現」世代番号
    expect(aborted?.reason).toBe("peer_disconnected");
    // p2 が抜けたので残りは p1 のみ。全員 ready なので即座に次の世代へ
    const restarted = firstOf(eff, "generation_start");
    expect(restarted?.generation).toBe(2);
    expect(s.phase).toBe("active");
  });

  test("idle 中(未開始)の切断では中断通知を出さない", () => {
    const s = createState();
    applyHello(s, "p1", "peer", "P1");
    const eff = applyDisconnect(s, "p1");
    expect(firstOf(eff, "generation_aborted")).toBeUndefined();
    expect(firstOf(eff, "roster_update")).toBeDefined();
  });
});

describe("webrtc_signal 中継", () => {
  const signal: WebrtcSignalMessage = {
    type: "webrtc_signal",
    targetId: "p1",
    fromId: "req",
    payload: { kind: "offer", sdp: "v=0..." },
  };

  test("既知の targetId には unicast Effect を返す", () => {
    const s = createState();
    applyHello(s, "p1", "peer", "P1");
    const eff = applySignal(s, signal);
    expect(eff).toEqual([{ kind: "unicast", targetId: "p1", msg: signal }]);
  });

  test("未知の targetId は破棄(例外を投げない)", () => {
    const s = createState();
    expect(applySignal(s, signal)).toEqual([]);
  });
});
