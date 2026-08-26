import { useEffect, useState } from "react";
import { createPeerManager } from "../webrtc/peerManager";
import type { WebrtcPeerManager } from "../webrtc/peerManager";
import { installRpcConsole } from "../webrtc/rpcConsole";

/**
 * WebRTCのDataChannelとWASM版llama.cppの間に PeerManager を1つ置く。
 *
 * 接続を張るのは useWebrtcSignaling の役目で、こちらはその上に論理接続を載せるだけ。
 * 両者を分けてあるのは、制御プレーン(Honoのシグナリング)とデータプレーン
 * (DataChannel上のRPC)を混ぜないため(AGENTS.md 前提2)。
 */
export type PeerManagerOptions = {
  /** 異常の通知。画面に出す用で、制御には使わない */
  onError?: (message: string) => void;
  /** WASMの生成結果を画面へ渡す。tokenは1回につき1トークン以上を受け取る */
  onGenerationEvent?: (event: GenerationEvent) => void;
};

export type GenerationEvent = { type: "token"; token: string } | { type: "generation_end" };

/** useWebrtcSignaling へそのまま広げて渡せる形 */
export type PeerManagerHandlers = {
  onOpen: (remoteId: string, channel: RTCDataChannel) => void;
  onData: (remoteId: string, data: unknown) => void;
  onClose: (remoteId: string) => void;
  onReset: () => void;
};

export type PeerManagerBridge = {
  /** `Module.PeerManager` に載せる本体。マウント中は同じ実体 */
  manager: WebrtcPeerManager;
  handlers: PeerManagerHandlers;
  /** 描画のたびに最新のコールバックを預け直す。フックの中からだけ呼ぶ */
  setOptions: (options: PeerManagerOptions) => void;
  /** WASM側の生成実装がtokenと完了通知を画面へ渡す入口 */
  emitGenerationEvent: (event: GenerationEvent) => void;
};

/**
 * 使い方:
 *
 * ```ts
 * const rpc = usePeerManager();
 * const rtc = useWebrtcSignaling({ ..., ...rpc.handlers });
 * // ①のWASMが起動したら
 * Module.PeerManager = rpc.manager;
 * ```
 */
/**
 * Reactの外で組み立てる。フックはこれを1回作って持ち回るだけにしてあり、
 * 描画のたびに関数が作り直されない・依存配列が要らない形になる。
 */
function createBridge(): PeerManagerBridge {
  // ①のWASMは後から来る。コールバックが途中で埋まっても PeerManager を
  // 作り直さずに済むよう、呼ぶ先はこの箱を1段はさんで解決する
  const latest: PeerManagerOptions = {};

  // `releaseBuf` は渡さない。受信バッファの所有権はWASMのglue側にあり、
  // 実際に解放する関数をここへ配線すると glue の `close_peer()` と二重解放になる
  // (Runtimeのhandoff契約)。adapterの `releaseConn()` も no-op のまま
  const manager = createPeerManager({
    onError: (message) => latest.onError?.(message),
  });

  return {
    manager,
    setOptions: (options) => {
      latest.onError = options.onError;
      latest.onGenerationEvent = options.onGenerationEvent;
    },
    emitGenerationEvent: (event) => latest.onGenerationEvent?.(event),
    handlers: {
      onOpen: (remoteId, channel) => {
        manager.attach(remoteId, channel);
      },
      onData: (remoteId, data) => {
        manager.handleMessage(remoteId, data);
      },
      // 相手が1人落ちた。待たせているrecvを失敗で返し、載っている論理接続を畳む。
      // ここを繋がないと、WASM側が Atomics.wait のまま起きなくなる
      onClose: (remoteId) => {
        manager.detach(remoteId);
      },
      // 世代の切り替え・離脱。DataChannelは受け口を外してから閉じるので
      // onClose は飛んでこない。まとめて畳むのはこちらの役
      onReset: () => {
        manager.close();
      },
    },
  };
}

export function usePeerManager(options: PeerManagerOptions = {}): PeerManagerBridge {
  // マウント時に1回だけ組む。一度 Module.PeerManager に載せた実体を後から
  // 差し替える手段がないため、世代が変わっても作り直さず close() で畳んで使い回す
  const [bridge] = useState(createBridge);

  useEffect(() => {
    bridge.setOptions(options);
  });

  useEffect(
    () => () => {
      bridge.manager.close();
    },
    [bridge],
  );

  // ①のWASMが来るまでのあいだ、実物のDataChannelでRPCを試すための口。
  // 開発中だけ生える(`webrtc/rpcConsole.ts` の使い方を参照)
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    return installRpcConsole(bridge.manager);
  }, [bridge]);

  return bridge;
}
