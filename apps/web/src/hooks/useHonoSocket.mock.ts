import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClientMessage,
  GenerationAbortedMessage,
  PeerInfo,
  ServerMessage,
} from "@dip_distributed_llm/shared-types/messages";
import type { HonoSocket, SocketOptions } from "../types/socket";
import { randomId } from "../lib/clientId";

// 型は本物と共有する。片方だけ形が変わると、差し替えたときに初めて壊れる
export type { HonoSocket, SocketDebug, SocketOptions } from "../types/socket";

const OTHER_PEERS: PeerInfo[] = [
  { clientId: "c-mock-taro", displayName: "太郎のPC", status: "ready" },
  { clientId: "c-mock-hanako", displayName: "花子のPC", status: "ready" },
];

/** 連続して届くメッセージの間隔。まとめて捨てられないよう1件ずつ流す */
const FRAME_MS = 60;

/**
 * Honoの代わり。返り値の形は本物の useHonoSocket と完全に同じにする。
 * ステップ3では useCluster の import を1行差し替えるだけで切り替わる。
 *
 * 挙動は本物のHonoに寄せてある。
 *   - hello を受け取ったら、その人を含むロスターを返す(役割が peer のときだけ)
 *   - しばらくして generation_start を配る
 *   - ピアが増減したら roster_update と generation_aborted を続けて配る
 */
export function useHonoSocketMock({ enabled }: SocketOptions): HonoSocket {
  const [lastMessage, setLastMessage] = useState<ServerMessage | null>(null);
  const peers = useRef<PeerInfo[]>([]);
  const generation = useRef(0);
  const timers = useRef<number[]>([]);
  const queue = useRef<ServerMessage[]>([]);
  const flushing = useRef(false);

  /**
   * 予約済みのタイマーを必ず捨てる。残すと、離脱したあとに emitRoster や
   * startGeneration が発火し、idle に戻ったはずの画面が connecting へ引き戻される。
   */
  const clearAll = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    queue.current = [];
    flushing.current = false;
    peers.current = [];
  }, []);

  useEffect(() => {
    // lastMessage は消さない。useCluster は値が変わったときだけ dispatch するので、
    // 古い1件が残っていても再送はされない
    if (!enabled) clearAll();
    return clearAll;
  }, [enabled, clearAll]);

  /**
   * 同じ tick で setState を2回呼ぶと後の1件しか残らない(前の1件は誰にも観測されない)。
   * 実際のWebSocketは別々のフレームで届くので、1件ずつ間隔を空けて流す。
   */
  const emit = useCallback((msg: ServerMessage) => {
    queue.current.push(msg);
    if (flushing.current) return;
    flushing.current = true;
    const step = () => {
      const next = queue.current.shift();
      if (!next) {
        flushing.current = false;
        return;
      }
      setLastMessage(next);
      timers.current.push(window.setTimeout(step, FRAME_MS));
    };
    step();
  }, []);

  const emitRoster = useCallback(() => {
    emit({ type: "roster_update", peers: [...peers.current] });
  }, [emit]);

  // 理由を呼び出し側から渡す(#68以前は常に peer_disconnected 固定で、
  // 参加者が増えたときの演出を本物のHonoに繋がずには確認できなかった)
  const emitAborted = useCallback(
    (reason: GenerationAbortedMessage["reason"], message: string) => {
      emit({
        type: "generation_aborted",
        generation: generation.current,
        reason,
        message,
      });
    },
    [emit],
  );

  const startGeneration = useCallback(() => {
    generation.current += 1;
    emit({
      type: "generation_start",
      generation: generation.current,
      peerIds: peers.current.map((p) => p.clientId),
    });
  }, [emit]);

  const send = useCallback(
    (msg: ClientMessage) => {
      // 全員解除(#114)。本物のHonoと同じく peers_dismissed → 空の roster_update の順。
      // ここを繋がないと、モックだけで開発しているときボタンが無反応になる
      if (msg.type === "dismiss_peers") {
        if (peers.current.length === 0) return;
        peers.current = [];
        emit({ type: "peers_dismissed", message: "発表者が編成を解除しました" });
        emitRoster();
        return;
      }
      if (msg.type !== "hello") return;
      const self: PeerInfo[] =
        msg.role === "peer"
          ? [{ clientId: msg.clientId, displayName: msg.displayName, status: "ready" }]
          : [];
      peers.current = [OTHER_PEERS[0], ...self, OTHER_PEERS[1]];
      timers.current.push(window.setTimeout(emitRoster, 400));
      // 待機中が一瞬で消えないよう、編成が組まれるまで少し間を置く
      timers.current.push(window.setTimeout(startGeneration, 4200));
    },
    [emit, emitRoster, startGeneration],
  );

  const addPeer = useCallback(
    (displayName: string) => {
      peers.current = [...peers.current, { clientId: randomId(), displayName, status: "ready" }];
      emitRoster();
      // 新しい人が来ても全員を組み直す方針(異常系を1パターンに保つため)
      emitAborted("peer_joined", "新しい参加者が加わりました");
    },
    [emitRoster, emitAborted],
  );

  const removeLastPeer = useCallback(() => {
    if (peers.current.length === 0) return;
    peers.current = peers.current.slice(0, -1);
    emitRoster();
    emitAborted("peer_disconnected", "メンバーが変わったため再編成します");
  }, [emitRoster, emitAborted]);

  return {
    connected: enabled,
    lastMessage,
    send,
    debug: { addPeer, removeLastPeer, startGeneration },
  };
}
