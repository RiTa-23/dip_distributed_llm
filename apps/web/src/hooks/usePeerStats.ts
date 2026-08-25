import { useEffect, useState } from "react";
import { EMPTY_STATS } from "../webrtc/peerStats";
import type { PeerStatsReader, PeerStatsSnapshot } from "../webrtc/peerStats";
import { FAKE_METRICS } from "../config";

/**
 * PeerManager が数えている計測値を画面へ渡す。
 *
 * 毎フレーム通知にしないのは、大きなテンソルの転送中は `send`/`recv` が秒間数百回
 * 呼ばれるため。そのたびに再描画すると、計算を借りに来ているはずのPCで
 * 画面の更新が主な負荷になる。読む側を一定間隔にして、数える側は加算だけにしてある。
 */

/** 読み取り間隔。docs/frontend.md に書いてある250msと揃えてある */
export const SAMPLE_MS = 250;

/** 直近これだけの間に何か流れていれば「動いている」とみなす。脈動に使う */
export const BUSY_MS = 400;

export type PeerStatsView = PeerStatsSnapshot & {
  /** 一度でも本文が流れたか。falseのあいだ画面は数字ではなく `—` を出す */
  started: boolean;
  /** 直近 BUSY_MS 以内に動きがあったか */
  busy: boolean;
};

const EMPTY_VIEW: PeerStatsView = { ...EMPTY_STATS, started: false, busy: false };

/** 表示に効く値が同じか。同じなら再描画しない(lastActivityAtは表示に出ないので見ない) */
function same(a: PeerStatsView, b: PeerStatsView): boolean {
  return (
    a.bytesReceived === b.bytesReceived &&
    a.bytesSent === b.bytesSent &&
    a.turns === b.turns &&
    a.responseMs === b.responseMs &&
    a.started === b.started &&
    a.busy === b.busy
  );
}

/** 実測の代わりに出す作り物。差し替え前の `PeerView` と同じ増え方にしてある */
function fakeNext(prev: PeerStatsView): PeerStatsView {
  return {
    bytesReceived: prev.bytesReceived + 1_400_000 + Math.floor(Math.random() * 400_000),
    bytesSent: prev.bytesSent + 120_000,
    turns: prev.turns + 1,
    responseMs: 84,
    lastActivityAt: performance.now(),
    started: true,
    busy: true,
  };
}

/**
 * @param stats  `rpc.manager.stats`。参加中は同じ実体が渡り続ける
 * @param enabled 参加していないあいだは false。読み取りを止めて表示も空に戻す
 */
export function usePeerStats(stats: PeerStatsReader, enabled: boolean): PeerStatsView {
  const [view, setView] = useState<PeerStatsView>(EMPTY_VIEW);

  // 離脱・再参加で前回の数字を持ち越さない。効果の中で消すと、
  // 前回の値が出たままの描画が1回挟まるので描画中にそろえる
  // (useWebrtcSignaling が表示を空に戻しているのと同じ形)
  const [wasEnabled, setWasEnabled] = useState(enabled);
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled);
    setView(EMPTY_VIEW);
  }

  useEffect(() => {
    if (!enabled) return;

    // 実測を作り物へ戻す口。返す形は同じなので、呼ぶ側は変わらない(config.ts参照)
    if (FAKE_METRICS) {
      const id = window.setInterval(() => setView(fakeNext), 420);
      return () => clearInterval(id);
    }

    const id = window.setInterval(() => {
      const snapshot = stats.snapshot();
      const next: PeerStatsView = {
        ...snapshot,
        started: snapshot.lastActivityAt !== null,
        busy:
          snapshot.lastActivityAt !== null && performance.now() - snapshot.lastActivityAt < BUSY_MS,
      };
      // 何も流れていない参加者の画面を秒間4回描き直さない
      setView((current) => (same(current, next) ? current : next));
    }, SAMPLE_MS);
    return () => clearInterval(id);
  }, [stats, enabled]);

  return view;
}
