import { describe, expect, test } from "bun:test";
import { createGenerationOwner } from "./generationOwner";

describe("createGenerationOwner", () => {
  test("claim した世代が現行になる", () => {
    const owner = createGenerationOwner();
    expect(owner.current()).toBe(0);

    const token = owner.claim(1);
    expect(owner.current()).toBe(1);
    expect(token.generation).toBe(1);
    expect(token.isCurrent()).toBe(true);
  });

  test("次を claim すると前のトークンは失効する", () => {
    const owner = createGenerationOwner();
    const first = owner.claim(1);
    const second = owner.claim(2);

    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
    expect(owner.current()).toBe(2);
  });

  test("同じ世代番号でも、claim し直せば前のトークンは失効する", () => {
    // 中断が挟まると同じ番号を二度 claim しうる。番号一致で見ていると
    // 前の世代のRuntimeが持つトークンが生き残ってしまう
    const owner = createGenerationOwner();
    const first = owner.claim(3);
    const second = owner.claim(3);

    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
  });

  test("release すると誰も現行でなくなる", () => {
    const owner = createGenerationOwner();
    const token = owner.claim(1);

    owner.release();

    expect(token.isCurrent()).toBe(false);
    expect(owner.current()).toBe(0);
  });

  describe("guard", () => {
    test("現行のあいだは引数ごと通す", () => {
      const owner = createGenerationOwner();
      const seen: string[] = [];
      const guarded = owner.claim(1).guard((delta: string) => seen.push(delta));

      guarded("あ");
      guarded("い");

      expect(seen).toEqual(["あ", "い"]);
    });

    test("失効したら落とす(古いRuntimeの遅れた出力)", () => {
      const owner = createGenerationOwner();
      const seen: string[] = [];
      const stale = owner.claim(1).guard((delta: string) => seen.push(delta));

      stale("世代1のぶん");
      owner.claim(2); // 世代交代
      stale("世代1の遅れたぶん");

      expect(seen).toEqual(["世代1のぶん"]);
    });

    test("release 後も落とす", () => {
      const owner = createGenerationOwner();
      let calls = 0;
      const guarded = owner.claim(1).guard(() => {
        calls += 1;
      });

      owner.release();
      guarded();

      expect(calls).toBe(0);
    });

    test("新旧のトークンが混ざっても、通るのは現行だけ", () => {
      const owner = createGenerationOwner();
      const seen: string[] = [];
      const old = owner.claim(1).guard(() => seen.push("old"));
      const fresh = owner.claim(2).guard(() => seen.push("fresh"));

      old();
      fresh();
      old();

      expect(seen).toEqual(["fresh"]);
    });
  });
});
