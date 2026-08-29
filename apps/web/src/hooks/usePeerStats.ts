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

/**
 * 相手ごとの内訳(#115)。発表者画面が「誰に何バイト送ったか」を出すのに使う。
 *
 * 合計を返す `usePeerStats` と分けてあるのは、**必要な側が違う**ため。
 * 参加者は自分の受信量しか要らないが、発表者は配布が偏っていないか・
 * 特定の相手で止まっていないかを見たい。
 *
 * これが要るのは、大きいモデルで2台以上つなぐと配布が失敗する問題の切り分け(#115)。
 * 層分割が効いていれば各peerは**モデルサイズ / 台数**程度を受け取るはずで、
 * 1台がモデル全体を受け取っていれば分割が効いていないことになる。
 * 止まった位置が送信キュー上限(64MB)と受信キュー上限(256MB)のどちらの
 * 近傍かでも、原因が割れる。
 *
 * サンプリング間隔と「変化が無ければ再描画しない」方針は `usePeerStats` と同じ。
 */
export function usePeerStatsByRemote(
  stats: PeerStatsReader,
  enabled: boolean,
): Map<string, PeerStatsSnapshot> {
  const [byRemote, setByRemote] = useState<Map<string, PeerStatsSnapshot>>(new Map());

  const [wasEnabled, setWasEnabled] = useState(enabled);
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled);
    setByRemote(new Map());
  }

  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => {
      const next = new Map<string, PeerStatsSnapshot>();
      for (const remoteId of stats.remoteIds()) next.set(remoteId, stats.snapshotOf(remoteId));
      setByRemote((current) => (sameByRemote(current, next) ? current : next));
    }, SAMPLE_MS);
    return () => clearInterval(id);
  }, [stats, enabled]);

  return byRemote;
}

/** 表示に効く値が全相手で同じか。同じなら再描画しない */
function sameByRemote(
  a: Map<string, PeerStatsSnapshot>,
  b: Map<string, PeerStatsSnapshot>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, next] of b) {
    const current = a.get(id);
    if (!current) return false;
    if (
      current.bytesReceived !== next.bytesReceived ||
      current.bytesSent !== next.bytesSent ||
      current.turns !== next.turns
    ) {
      return false;
    }
  }
  return true;
}
