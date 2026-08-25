import { describe, expect, test } from "bun:test";
import type {
  ServerMessage,
  WebrtcSignalMessage,
} from "@dip_distributed_llm/shared-types/messages";
import { Coordinator, type Socket } from "./coordinator";

/** 送られたメッセージを記録するフェイク Socket。 */
function fakeSocket(): Socket & { sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  return {
    sent,
    send: (d: string) => {
      sent.push(JSON.parse(d) as ServerMessage);
    },
  };
}

function typesOf(s: { sent: ServerMessage[] }): string[] {
  return s.sent.map((m) => m.type);
}

describe("Coordinator wiring", () => {
  test("hello の roster_update は接続中の全socketに届く", () => {
    const co = new Coordinator();
    const req = fakeSocket();
    const p1 = fakeSocket();
    co.hello("req", "requester", "発表者", req);
    co.hello("p1", "peer", "太郎のPC", p1);

    // p1 の hello 時点で req・p1 の双方に roster_update が届く
    expect(typesOf(req)).toContain("roster_update");
    expect(typesOf(p1)).toContain("roster_update");
  });

  test("未知の targetId への signal は例外を投げない", () => {
    const co = new Coordinator();
    const p1 = fakeSocket();
    co.hello("p1", "peer", "P1", p1);
    const signal: WebrtcSignalMessage = {
      type: "webrtc_signal",
      targetId: "nobody",
      fromId: "p1",
      payload: { kind: "ice-candidate", candidate: null },
    };
    expect(() => co.signal(signal)).not.toThrow();
  });

  test("signal は targetId の socket にだけ届く", () => {
    const co = new Coordinator();
    const a = fakeSocket();
    const b = fakeSocket();
    co.hello("a", "peer", "A", a);
    co.hello("b", "peer", "B", b);
    a.sent.length = 0;
    b.sent.length = 0;

    const signal: WebrtcSignalMessage = {
      type: "webrtc_signal",
      targetId: "b",
      fromId: "a",
      payload: { kind: "offer", sdp: "v=0..." },
    };
    co.signal(signal);
    expect(b.sent).toEqual([signal]);
    expect(a.sent).toEqual([]);
  });

  test("identity ガード: 旧接続の onClose は新接続のエントリを消さない", () => {
    const co = new Coordinator();
    const s1 = fakeSocket();
    co.hello("c1", "peer", "P1", s1);
    // 同じ clientId でリロード再接続(新しい socket)
    const s2 = fakeSocket();
    co.hello("c1", "peer", "P1", s2);

    // 遅れて届いた旧接続の onClose → identity 不一致でスキップされるべき
    co.disconnect("c1", s1);

    // c1 はまだ生きている。新規 peer を足すと roster に c1 が残っている
    const s3 = fakeSocket();
    co.hello("c2", "peer", "P2", s3);
    const lastRoster = [...s3.sent].reverse().find((m) => m.type === "roster_update");
    expect(lastRoster?.type).toBe("roster_update");
    const ids =
      lastRoster?.type === "roster_update" ? lastRoster.peers.map((p) => p.clientId).sort() : [];
    expect(ids).toEqual(["c1", "c2"]);
    // 新接続 s2 は生きているので配信を受け取れる
    expect(typesOf(s2)).toContain("roster_update");
  });

  test("2人目の requester(別clientId)は拒否され、保持も配信もされない", () => {
    const co = new Coordinator();
    const req1 = fakeSocket();
    const req2 = fakeSocket();
    expect(co.hello("req-1", "requester", "発表者1", req1)).toBe(true);
    expect(co.hello("req-2", "requester", "発表者2", req2)).toBe(false);

    // 拒否された req2 には何も送られていない
    expect(req2.sent).toEqual([]);

    // 以後の broadcast(peer 参加)も req2 には届かない(保持されていない)
    req1.sent.length = 0;
    co.hello("p1", "peer", "P1", fakeSocket());
    expect(typesOf(req1)).toContain("roster_update");
    expect(req2.sent).toEqual([]);
  });

  test("同一clientId の reconnect は active 中に generation_aborted を出す", () => {
    const co = new Coordinator();
    const req = fakeSocket();
    const p1 = fakeSocket();
    co.hello("req", "requester", "発表者", req);
    co.hello("p1", "peer", "P1", p1);
    co.peerStatus("p1", "ready"); // gen 1 開始
    req.sent.length = 0;

    // p1 がリロード再接続(新しい socket)
    co.hello("p1", "peer", "P1", fakeSocket());
    expect(typesOf(req)).toContain("generation_aborted");
  });
});
