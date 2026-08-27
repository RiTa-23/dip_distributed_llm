import { describe, expect, test } from "bun:test";
import type {
  ServerMessage,
  WebrtcSignalMessage,
} from "@dip_distributed_llm/shared-types/messages";
import {
  applyDisconnect,
  applyGenerationFailed,
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
    const eff = applySignal(s, "req", signal);
    expect(eff).toEqual([{ kind: "unicast", targetId: "p1", msg: signal }]);
  });

  test("未知の targetId は破棄(例外を投げない)", () => {
    const s = createState();
    expect(applySignal(s, "req", signal)).toEqual([]);
  });

  test("fromId が送信者と違えば中継しない(なりすまし防止 #54)", () => {
    const s = createState();
    applyHello(s, "p1", "peer", "P1");
    applyHello(s, "req", "requester", "Req");
    // 送信者は attacker なのに fromId は req を騙っている
    expect(applySignal(s, "attacker", signal)).toEqual([]);
  });

  test("なりすましは宛先が存在していても中継しない", () => {
    const s = createState();
    applyHello(s, "p1", "peer", "P1");
    applyHello(s, "attacker", "peer", "Atk");
    expect(applySignal(s, "attacker", signal)).toEqual([]);
  });

  test("自分名義なら向きを問わず中継する(peer→requester も通る)", () => {
    const s = createState();
    applyHello(s, "req", "requester", "Req");
    const fromPeer: WebrtcSignalMessage = {
      type: "webrtc_signal",
      targetId: "req",
      fromId: "p1",
      payload: { kind: "answer", sdp: "v=0..." },
    };
    expect(applySignal(s, "p1", fromPeer)).toEqual([
      { kind: "unicast", targetId: "req", msg: fromPeer },
    ]);
  });
});

describe("errorのpeerを編成から外す(#57)", () => {
  test("1台がerrorでも、残りのreadyな人だけで世代が始まる", () => {
    const s = createState();
    applyHello(s, "req", "requester", "Req");
    applyHello(s, "p1", "peer", "P1");
    applyHello(s, "p2", "peer", "P2");
    applyPeerStatus(s, "p1", "ready");
    const eff = applyPeerStatus(s, "p2", "error");

    const start = firstOf(eff, "generation_start");
    expect(start).toBeDefined();
    expect(start?.peerIds).toEqual(["p1"]); // errorのp2は含めない
  });

  test("connecting の人がいるあいだは待つ(準備中を置き去りにしない)", () => {
    const s = createState();
    applyHello(s, "req", "requester", "Req");
    applyHello(s, "p1", "peer", "P1");
    applyHello(s, "p2", "peer", "P2");
    const eff = applyPeerStatus(s, "p1", "ready"); // p2 はまだ connecting
    expect(firstOf(eff, "generation_start")).toBeUndefined();
  });

  test("全員がerrorなら世代を始めない", () => {
    const s = createState();
    applyHello(s, "req", "requester", "Req");
    applyHello(s, "p1", "peer", "P1");
    const eff = applyPeerStatus(s, "p1", "error");
    expect(firstOf(eff, "generation_start")).toBeUndefined();
  });

  test("errorから復帰してreadyを送り直すと編成に戻る", () => {
    const s = createState();
    applyHello(s, "req", "requester", "Req");
    applyHello(s, "p1", "peer", "P1");
    applyHello(s, "p2", "peer", "P2");
    applyPeerStatus(s, "p1", "ready");
    applyPeerStatus(s, "p2", "error"); // gen 1 は p1 だけで開始
    const eff = applyPeerStatus(s, "p2", "ready"); // 復帰

    const start = firstOf(eff, "generation_start");
    expect(start?.peerIds.sort()).toEqual(["p1", "p2"]);
  });
});

describe("generation_failed による復帰(#56)", () => {
  /** requester と2台のpeerで世代1を開始した状態を作る。 */
  function started() {
    const s = createState();
    applyHello(s, "req", "requester", "Req");
    applyHello(s, "p1", "peer", "P1");
    applyHello(s, "p2", "peer", "P2");
    applyPeerStatus(s, "p1", "ready");
    applyPeerStatus(s, "p2", "ready");
    expect(s.phase).toBe("active");
    expect(s.generation).toBe(1);
    return s;
  }

  test("requesterからの通知で idle に戻り、中断を全員に知らせる", () => {
    const s = started();
    const eff = applyGenerationFailed(s, "req", 1);

    const aborted = firstOf(eff, "generation_aborted");
    expect(aborted?.reason).toBe("connection_failed");
    expect(aborted?.generation).toBe(1); // 中断した現世代の番号
    expect(s.phase).toBe("idle");
  });

  test("同じ顔ぶれのままでは組み直さない(失敗の繰り返しを防ぐ)", () => {
    const s = started();
    const eff = applyGenerationFailed(s, "req", 1);
    expect(firstOf(eff, "generation_start")).toBeUndefined();
    expect(s.generation).toBe(1); // 世代番号も進めない
  });

  test("顔ぶれが変われば組み直す", () => {
    const s = started();
    applyGenerationFailed(s, "req", 1);
    // 失敗したp2がerrorを報告 → 顔ぶれが p1 だけに変わる
    const eff = applyPeerStatus(s, "p2", "error");

    const start = firstOf(eff, "generation_start");
    expect(start?.peerIds).toEqual(["p1"]);
    expect(s.generation).toBe(2);
  });

  test("新しい参加者が来ても顔ぶれが変わるので組み直す", () => {
    const s = started();
    applyGenerationFailed(s, "req", 1);
    applyHello(s, "p3", "peer", "P3");
    const eff = applyPeerStatus(s, "p3", "ready");

    const start = firstOf(eff, "generation_start");
    expect(start?.peerIds.sort()).toEqual(["p1", "p2", "p3"]);
  });

  test("requester以外からの送信は無視する", () => {
    const s = started();
    expect(applyGenerationFailed(s, "p1", 1)).toEqual([]);
    expect(s.phase).toBe("active");
  });

  test("未知のクライアントからの送信は無視する", () => {
    const s = started();
    expect(applyGenerationFailed(s, "unknown", 1)).toEqual([]);
    expect(s.phase).toBe("active");
  });

  test("古い世代の通知は無視する(遅れて届いた分で現世代を壊さない)", () => {
    const s = started();
    expect(applyGenerationFailed(s, "req", 0)).toEqual([]);
    expect(s.phase).toBe("active");
    expect(s.generation).toBe(1);
  });

  test("idle 中の通知は無視する", () => {
    const s = createState();
    applyHello(s, "req", "requester", "Req");
    expect(s.phase).toBe("idle");
    expect(applyGenerationFailed(s, "req", 0)).toEqual([]);
  });

  test("失敗の記録は次の世代が始まると消える", () => {
    const s = started();
    applyGenerationFailed(s, "req", 1);
    expect(s.failedPeerIds).toEqual(["p1", "p2"]);
    applyHello(s, "p3", "peer", "P3");
    applyPeerStatus(s, "p3", "ready"); // 顔ぶれが変わって gen 2 開始
    expect(s.failedPeerIds).toBeNull();
  });

  test("切断は failedPeerIds に関係なく従来通り再編成する(非退行)", () => {
    const s = started();
    applyGenerationFailed(s, "req", 1); // p1,p2 で失敗を記録
    const eff = applyDisconnect(s, "p2"); // 顔ぶれが p1 だけになる
    const start = firstOf(eff, "generation_start");
    expect(start?.peerIds).toEqual(["p1"]);
  });
});
