import { useEffect, useState } from "react";

/**
 * ある状態が続いた時間を測り、しきい値を超えたら true を返す。
 *
 * 使い道は「待たせているのに何も起きない」ときの案内で、状態そのものは動かさない。
 * フェーズを進める判断は clusterReducer に閉じており(サーバの generation_start が
 * 唯一の出口)、時間切れで画面が勝手に別のフェーズへ移ると、遅れて届いた
 * generation_start と食い違う。
 *
 * `watching` が false になった時点で測り直す。再編成が一度終わってまた始まった
 * ときに、前回ぶんの経過を持ち越さないため。
 */
export function useStalled(watching: boolean, delayMs: number): boolean {
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    if (!watching) return;

    const timer = window.setTimeout(() => setStalled(true), delayMs);
    // 測り直しは後始末に置く。`watching` が false を通ったときにだけ起きるので、
    // 「もう見ていないのに true のまま」が残らない
    return () => {
      clearTimeout(timer);
      setStalled(false);
    };
  }, [watching, delayMs]);

  return stalled;
}
