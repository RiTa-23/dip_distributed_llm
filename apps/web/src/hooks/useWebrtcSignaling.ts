import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClientMessage,
  Role,
  ServerMessage,
} from "@dip_distributed_llm/shared-types/messages";
import { isStaleAbort, isStaleForCurrent } from "../webrtc/session";
import type { SessionCallbacks, WebrtcSession } from "../webrtc/session";
import { createPeerSession } from "../webrtc/peerSession";
import { createRequesterSession } from "../webrtc/requesterSession";

/**
 * データプレーン(WebRTC)の状態。
 *   idle       … まだ張り始めていない
 *   connecting … 相手が決まって手続き中
 *   open       … 繋ぐべき相手すべてとDataChannelが開いた
 *   failed     … 現行世代のどれかが失敗した
 */
export type WebrtcStatus = "idle" | "connecting" | "open" | "failed";

export type WebrtcSignaling = {
  /** WebRTC側が今どの世代で繋いでいるか */
  generation: number;
  /** 繋ぐべき相手。peerはofferが来るまで空 */
  expectedIds: string[];
  /** DataChannelが開いている相手 */
  openIds: string[];
  status: WebrtcStatus;
};

export type WebrtcSignalingOptions = {
  role: Role;
  myId: string;
  /** false のあいだは接続しない。参加者は「参加する」を押すまで false */
  enabled: boolean;
  /** `/ws` から届いた直近の1件。useCluster が渡す */
  lastMessage: ServerMessage | null;
  send: (msg: ClientMessage) => void;
  /** DataChannelが開いた。PeerManager の attach へ繋ぐ */
  onOpen?: (remoteId: string, channel: RTCDataChannel) => void;
  /** DataChannel上でデータが届いた。PeerManager の handleMessage へ繋ぐ */
  onData?: (remoteId: string, data: unknown) => void;
  /** その相手との回線が閉じた。PeerManager の detach へ繋ぐ */
  onClose?: (remoteId: string) => void;
  /** 世代の切り替え・離脱で全部畳んだ。PeerManager の close へ繋ぐ */
  onReset?: () => void;
  onFailed?: (message: string) => void;
};

const EMPTY: WebrtcSignaling = {
  generation: 0,
  expectedIds: [],
  openIds: [],
  status: "idle",
};

/**
 * `webrtc_signal` の送受信と RTCPeerConnection の生き死にを持つ。
 *
 * このフックが持つのは接続と受け渡しだけで、フェーズの判断は一切しない
 * (useHonoSocket と同じ設計)。状態遷移のルールは clusterReducer.ts に閉じている。
 * 役割ごとの違いはここではなく webrtc/ の2実装にあり、両画面から同じ形で呼べる。
 *
 * 世代(generation)番号による古いメッセージの破棄は3か所に入れてある。
 *   1. generation_aborted 受信時 … 遅れて届いた古い中断通知を捨てる
 *   2. DataChannel開通時         … 古い世代の接続が遅れて開いても現在の画面を動かさない
 *   3. データ受信時              … 古い世代のDataChannelから届いたぶんを捨てる
 */
export function useWebrtcSignaling(options: WebrtcSignalingOptions): WebrtcSignaling {
  const { role, myId, enabled, lastMessage, send } = options;

  const [view, setView] = useState<WebrtcSignaling>(EMPTY);

  const sessionRef = useRef<WebrtcSession | null>(null);
  /** WebRTC側が今どの世代で繋いでいるか。3つの破棄判定はすべてこれと突き合わせる */
  const generationRef = useRef(0);
  /** 処理済みの1件。同じ値で効果が再実行されても二度処理しない */
  const seenRef = useRef<ServerMessage | null>(null);
  const failedRef = useRef(false);

  // 最新のコールバックをrefに置く。ビュー側が毎描画で新しい関数を渡しても
  // セッションを作り直さずに済む
  const onOpenRef = useRef(options.onOpen);
  const onDataRef = useRef(options.onData);
  const onCloseRef = useRef(options.onClose);
  const onResetRef = useRef(options.onReset);
  const onFailedRef = useRef(options.onFailed);
  useEffect(() => {
    onOpenRef.current = options.onOpen;
    onDataRef.current = options.onData;
    onCloseRef.current = options.onClose;
    onResetRef.current = options.onReset;
    onFailedRef.current = options.onFailed;
  });

  const sync = useCallback(() => {
    const session = sessionRef.current;
    if (!session) {
      setView(EMPTY);
      return;
    }
    const expectedIds = session.expectedIds();
    const openIds = session.openIds();
    const allOpen = expectedIds.length > 0 && openIds.length === expectedIds.length;
    setView({
      generation: session.generation,
      expectedIds,
      openIds,
      status: failedRef.current
        ? "failed"
        : allOpen
          ? "open"
          : session.generation > 0
            ? "connecting"
            : "idle",
    });
  }, []);

  const closeSession = useCallback(() => {
    sessionRef.current?.teardown();
    sessionRef.current = null;
    failedRef.current = false;
    // teardown() は受け口を外してから閉じるので onClose は飛んでこない。
    // データプレーン側を畳むのはここだけが頼り
    onResetRef.current?.();
  }, []);

  const teardown = useCallback(() => {
    closeSession();
    setView(EMPTY);
  }, [closeSession]);

  // 離脱・再参加でWebRTCの表示を持ち越さない。効果の中で片付けると、
  // 前回の接続数が出たままの描画が1回挟まるので、描画中にそろえる
  const [wasEnabled, setWasEnabled] = useState(enabled);
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled);
    setView(EMPTY);
  }

  const startSession = useCallback(
    (generation: number, peerIds: string[]) => {
      // 前の世代のDataChannelと、その上に載っていた論理接続をまとめて畳む
      closeSession();
      generationRef.current = generation;

      const callbacks: SessionCallbacks = {
        onOpen: (g, remoteId, channel) => {
          // 破棄判定2: 古い世代の接続が遅れて開くことがある。通すと再編成中の画面が
          // datachannel_open で稼働中へ戻ってしまう
          if (isStaleForCurrent(g, generationRef.current)) {
            channel.close();
            return;
          }
          onOpenRef.current?.(remoteId, channel);
          sync();
        },
        onData: (g, remoteId, data) => {
          // 破棄判定3: 古い世代のDataChannelから届いたぶんは捨てる
          if (isStaleForCurrent(g, generationRef.current)) return;
          onDataRef.current?.(remoteId, data);
        },
        onClose: (g, remoteId) => {
          // 古い世代の接続は attach されていないので、閉じても畳むものがない。
          // 通すと同じ相手の現行の接続を巻き添えに切ってしまう
          if (isStaleForCurrent(g, generationRef.current)) return;
          onCloseRef.current?.(remoteId);
        },
        onFailed: (g, _remoteId, message) => {
          if (isStaleForCurrent(g, generationRef.current)) return;
          failedRef.current = true;
          onFailedRef.current?.(message);
          sync();
        },
        onChange: sync,
      };

      const session =
        role === "requester"
          ? createRequesterSession({ generation, myId, send, callbacks })
          : createPeerSession({ generation, myId, send, callbacks });

      sessionRef.current = session;
      // requesterはこの顔ぶれへofferを出す。peerはofferが来るのを待つだけ
      session.start(peerIds);
      sync();
    },
    [role, myId, send, sync, closeSession],
  );

  useEffect(() => {
    if (!enabled || !lastMessage) return;
    if (seenRef.current === lastMessage) return;
    seenRef.current = lastMessage;

    switch (lastMessage.type) {
      case "generation_start":
        startSession(lastMessage.generation, lastMessage.peerIds);
        return;

      case "generation_aborted":
        // 破棄判定1: 遅れて届いた古い中断通知で、始まったばかりの編成を巻き込まない
        if (isStaleAbort(lastMessage.generation, generationRef.current)) return;
        teardown();
        return;

      case "webrtc_signal":
        // Honoは中身を解釈せず転送するだけなので、宛先の確認はここで行う
        if (lastMessage.targetId !== myId) return;
        sessionRef.current?.accept(lastMessage);
        return;

      case "roster_update":
        // 人の増減はフェーズにもWebRTCにも効かない。編成は generation_start で組み直す
        return;
    }
  }, [enabled, lastMessage, myId, startSession, teardown]);

  // 離脱したら全部閉じる。seenRef は残す(切れる前の1件で繋ぎ直さないため)
  useEffect(() => {
    if (enabled) return;
    generationRef.current = 0;
    closeSession();
  }, [enabled, closeSession]);

  useEffect(
    () => () => {
      sessionRef.current?.teardown();
      sessionRef.current = null;
    },
    [],
  );

  return view;
}
