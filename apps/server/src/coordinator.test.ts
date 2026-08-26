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

  test("requesterAccepting: requesterがfalseにすると新規peerのreadyで再編成されない", () => {
    const co = new Coordinator();
    const req = fakeSocket();
    const p1 = fakeSocket();
    co.hello("req", "requester", "発表者", req);
    co.hello("p1", "peer", "P1", p1);
    co.peerStatus("p1", "ready"); // gen 1 開始

    co.requesterAccepting("req", false);
    req.sent.length = 0;
    const p2 = fakeSocket();
    co.hello("p2", "peer", "P2", p2);
    co.peerStatus("p2", "ready");
    expect(typesOf(req)).not.toContain("generation_aborted");

    // trueに戻すと取り込まれる
    co.requesterAccepting("req", true);
    expect(typesOf(req)).toContain("generation_aborted");
    expect(typesOf(req)).toContain("generation_start");
  });

  test("requesterAccepting: peerが送っても無視される", () => {
    const co = new Coordinator();
    const req = fakeSocket();
    const p1 = fakeSocket();
    co.hello("req", "requester", "発表者", req);
    co.hello("p1", "peer", "P1", p1);
    co.peerStatus("p1", "ready"); // gen 1 開始

    co.requesterAccepting("p1", false); // p1はpeerなので無視されるべき
    req.sent.length = 0;
    const p2 = fakeSocket();
    co.hello("p2", "peer", "P2", p2);
    co.peerStatus("p2", "ready");
    // 無視されていれば既定trueのままなので、通常通り再編成される
    expect(typesOf(req)).toContain("generation_aborted");
  });
});

describe("status() のスナップショット(#58)", () => {
  test("接続前は空の状態を返す", () => {
    const co = new Coordinator();
    const st = co.status();
    expect(st.phase).toBe("idle");
    expect(st.generation).toBe(0);
    expect(st.requesterConnected).toBe(false);
    expect(st.peers).toEqual([]);
  });

  test("requester の接続を反映する", () => {
    const co = new Coordinator();
    co.hello("req", "requester", "Req", fakeSocket());
    expect(co.status().requesterConnected).toBe(true);
  });

  test("ロスターと世代を反映する", () => {
    const co = new Coordinator();
    co.hello("req", "requester", "Req", fakeSocket());
    co.hello("p1", "peer", "P1", fakeSocket());
    co.peerStatus("p1", "ready");

    const st = co.status();
    expect(st.phase).toBe("active");
    expect(st.generation).toBe(1);
    expect(st.peers.map((p) => p.clientId)).toEqual(["p1"]);
    expect(st.activeGenerationPeerIds).toEqual(["p1"]);
  });

  test("読み出しても状態は変わらない", () => {
    const co = new Coordinator();
    co.hello("p1", "peer", "P1", fakeSocket());
    const before = co.status();
    co.status();
    expect(co.status()).toEqual(before);
  });

  test("statsを書き換えても内部状態に影響しない(コピーを返す)", () => {
    const co = new Coordinator();
    co.hello("p1", "peer", "P1", fakeSocket());
    const st = co.status();
    st.stats.totalPeers = 999;
    expect(co.status().stats.totalPeers).toBe(1);
  });
});

describe("参加統計(#60)", () => {
  test("peer の累計人数を数える(requester は数えない)", () => {
    const co = new Coordinator();
    co.hello("req", "requester", "Req", fakeSocket());
    co.hello("p1", "peer", "P1", fakeSocket());
    co.hello("p2", "peer", "P2", fakeSocket());
    expect(co.status().stats.totalPeers).toBe(2);
  });

  test("同じ clientId の再接続は二重に数えない", () => {
    const co = new Coordinator();
    const first = fakeSocket();
    co.hello("p1", "peer", "P1", first);
    co.disconnect("p1", first);
    co.hello("p1", "peer", "P1", fakeSocket()); // リロードで戻ってきた
    expect(co.status().stats.totalPeers).toBe(1);
  });

  test("同時接続の最大値を覚えている(減っても下がらない)", () => {
    const co = new Coordinator();
    const a = fakeSocket();
    const b = fakeSocket();
    const c = fakeSocket();
    co.hello("p1", "peer", "P1", a);
    co.hello("p2", "peer", "P2", b);
    co.hello("p3", "peer", "P3", c);
    expect(co.status().stats.peakPeers).toBe(3);

    co.disconnect("p2", b);
    co.disconnect("p3", c);
    expect(co.status().peers.length).toBe(1);
    expect(co.status().stats.peakPeers).toBe(3); // 最大値は下がらない
  });

  test("開始した世代の数を数える", () => {
    const co = new Coordinator();
    const req = fakeSocket();
    const p1 = fakeSocket();
    const p2 = fakeSocket();
    co.hello("req", "requester", "Req", req);
    co.hello("p1", "peer", "P1", p1);
    co.peerStatus("p1", "ready"); // gen 1
    co.hello("p2", "peer", "P2", p2);
    co.peerStatus("p2", "ready"); // gen 2(生成中の加入で再編成)
    expect(co.status().stats.generationsStarted).toBe(2);
  });
});

describe("状態遷移のログ(#58)", () => {
  test("渡さなければ何も出さない(テスト出力を汚さない)", () => {
    const co = new Coordinator();
    expect(() => co.hello("p1", "peer", "P1", fakeSocket())).not.toThrow();
  });

  test("ロスターの増減と世代の開始を1行ずつ流す", () => {
    const lines: string[] = [];
    const co = new Coordinator((l) => lines.push(l));
    co.hello("req", "requester", "Req", fakeSocket());
    co.hello("p1", "peer", "P1", fakeSocket());
    co.peerStatus("p1", "ready");

    expect(lines.some((l) => l.includes("roster peers=1"))).toBe(true);
    expect(lines.some((l) => l.includes("generation_start gen=1 peers=p1"))).toBe(true);
  });

  test("中断は理由まで出す", () => {
    const lines: string[] = [];
    const co = new Coordinator((l) => lines.push(l));
    const req = fakeSocket();
    const p1 = fakeSocket();
    co.hello("req", "requester", "Req", req);
    co.hello("p1", "peer", "P1", p1);
    co.peerStatus("p1", "ready");
    co.disconnect("p1", p1);

    expect(
      lines.some((l) => l.includes("generation_aborted") && l.includes("peer_disconnected")),
    ).toBe(true);
  });

  test("signal の中継はログに出さない(量が多く埋もれるため)", () => {
    const lines: string[] = [];
    const co = new Coordinator((l) => lines.push(l));
    co.hello("a", "peer", "A", fakeSocket());
    co.hello("b", "peer", "B", fakeSocket());
    const before = lines.length;
    co.signal({
      type: "webrtc_signal",
      targetId: "b",
      fromId: "a",
      payload: { kind: "offer", sdp: "v=0..." },
    });
    expect(lines.length).toBe(before);
  });
});
