import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClientMessage,
  PeerInfo,
  ServerMessage,
} from "@dip_distributed_llm/shared-types/messages";

/** 開発用パネルから呼ぶ操作。本物の接続では null になる */
export type SocketDebug = {
  addPeer: (displayName: string) => void;
  removeLastPeer: () => void;
  startGeneration: () => void;
};

export type HonoSocket = {
  connected: boolean;
  lastMessage: ServerMessage | null;
  send: (msg: ClientMessage) => void;
  debug: SocketDebug | null;
};

export type SocketOptions = {
  /** false のあいだは接続しない。参加者は「参加する」を押すまで false */
  enabled: boolean;
};

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

  useEffect(() => {
    if (enabled) return;
    peers.current = [];
    queue.current = [];
    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, [enabled]);

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

  const emitAborted = useCallback(() => {
    emit({
      type: "generation_aborted",
      generation: generation.current,
      reason: "peer_disconnected",
      message: "メンバーが変わったため再編成します",
    });
  }, [emit]);

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
    [emitRoster, startGeneration],
  );

  const addPeer = useCallback(
    (displayName: string) => {
      peers.current = [
        ...peers.current,
        { clientId: crypto.randomUUID(), displayName, status: "ready" },
      ];
      emitRoster();
      // 新しい人が来ても全員を組み直す方針(異常系を1パターンに保つため)
      emitAborted();
    },
    [emitRoster, emitAborted],
  );

  const removeLastPeer = useCallback(() => {
    if (peers.current.length === 0) return;
    peers.current = peers.current.slice(0, -1);
    emitRoster();
    emitAborted();
  }, [emitRoster, emitAborted]);

  return {
    connected: enabled,
    lastMessage,
    send,
    debug: { addPeer, removeLastPeer, startGeneration },
  };
}
