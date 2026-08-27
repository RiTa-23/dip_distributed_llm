import { describe, expect, test } from "bun:test";
import { createAcceptingSignal } from "./requesterAccepting";

// 見るのは edge 検出のルールだけ。Reactに依存しない層なので、`generating` の並びを
// そのまま流して「いつ何を送るか」を確かめられる。
//
// ここが守っているのは、DataChannel が落ちた世代の後始末:
// 生成中に回線が死ぬと drain が `generating` を false へ戻すが、その変化を拾わないと
// `requester_accepting: false` を送ったきりになり、Honoは新規peerを永久に取り込めなくなる。

describe("createAcceptingSignal", () => {
  test("生成を始めたら accepting:false、終わったら accepting:true", () => {
    const signal = createAcceptingSignal();

    expect(signal.next(true)).toBe(false);
    expect(signal.next(false)).toBe(true);
  });

  test("変わっていなければ何も送らない", () => {
    // generating は複数の経路から書かれる。同じ値で呼ばれるたびに送ると、
    // Hono 側の再編成デバウンスが無意味に往復する
    const signal = createAcceptingSignal();

    expect(signal.next(false)).toBeNull();
    expect(signal.next(true)).toBe(false);
    expect(signal.next(true)).toBeNull();
    expect(signal.next(true)).toBeNull();
  });

  test("生成中に回線が死んだ場合、drain の false で accepting:true を1回だけ取り戻す", () => {
    const signal = createAcceptingSignal();
    const sent: boolean[] = [];
    const feed = (generating: boolean) => {
      const accepting = signal.next(generating);
      if (accepting !== null) sent.push(accepting);
    };

    feed(true); // 送信ボタン
    feed(true); // 描画が挟まっても増えない
    feed(false); // 現行世代の失敗による drain
    feed(false); // 旧 run の遅れた finally が同じ値で来ても増えない

    expect(sent).toEqual([false, true]);
  });

  test("往復しても、そのつど1回ずつ", () => {
    const signal = createAcceptingSignal();

    expect(signal.next(true)).toBe(false);
    expect(signal.next(false)).toBe(true);
    expect(signal.next(true)).toBe(false);
    expect(signal.next(false)).toBe(true);
  });

  test("初期値を指定できる(初回の描画で偽の変化を作らない)", () => {
    // 実体は component の寿命に1つ。既定は「生成していない」から始める
    expect(createAcceptingSignal().next(false)).toBeNull();
    expect(createAcceptingSignal(true).next(true)).toBeNull();
    expect(createAcceptingSignal(true).next(false)).toBe(true);
  });
});
