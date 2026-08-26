import { useEffect, useRef, useState } from "react";
import { startWasmEngine } from "../webrtc/wasmEngine";
import type { EngineRole, EngineStartResult, ReleaseBuf } from "../webrtc/wasmEngine";
import type { LlamaPeerManager } from "../webrtc/peerManager";

/**
 * ①のWASMの起動を画面から呼ぶための繋ぎ込み。両画面が同じ形で使う
 * (参加者はrpc-server役、発表者はrpc-client役。違いは `role` だけ)。
 *
 * 起動そのものは `webrtc/wasmEngine.ts` にあり、こちらが持つのは
 * 「いつ始めるか」「終わったら誰に知らせるか」だけ。フェーズの判断はしない
 * (`useHonoSocket` / `useWebrtcSignaling` と同じ)。
 */
export type WasmEngineStatus = "idle" | "starting" | "wasm" | "fallback";

export type UseWasmEngineOptions = {
  role: EngineRole;
  /** `Module.PeerManager` に載せる本体。`usePeerManager()` の `manager` */
  manager: LlamaPeerManager;
  /** 自分のclientId(`lib/clientId.ts`) */
  nodeId: string;
  /** trueのあいだ起動する。参加者画面は `phase === "preparing"` を渡す */
  enabled: boolean;
  /** 起動が終わった。WASMでもダミーでも同じように呼ばれる */
  onReady: () => void;
  /**
   * `Module.release_conn` を包んだもの(無いビルドでは undefined)。
   *
   * ここで受けた値は `usePeerManager({ releaseBuf })` へ渡す。`setOptions` を
   * 直接叩かないのは、`usePeerManager` が描画のたびに渡されたオプションで
   * 上書きするので、外から入れた値が次の描画で消えるため。
   */
  onReleaseBuf?: (releaseBuf: ReleaseBuf | undefined) => void;
};

export function useWasmEngine(options: UseWasmEngineOptions): WasmEngineStatus {
  const { role, manager, nodeId, enabled } = options;
  const [status, setStatus] = useState<WasmEngineStatus>("idle");

  // 描画のたびに最新のコールバックを預け直す。依存配列に入れると、
  // 描画のたびに起動をやり直してしまう
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  // 一度WASMが載ったら載せ直さない。`Module.PeerManager` を差し替える手段が無く、
  // rpc-server役も動いたままなので、再参加では起動済みのものを使い回す。
  // ダミー経路はここに残さない(参加のたびに従来どおり待たせる)
  const started = useRef<EngineStartResult | null>(null);

  useEffect(() => {
    if (!enabled) return;

    if (started.current) {
      setStatus("wasm");
      latest.current.onReady();
      return;
    }

    const controller = new AbortController();
    setStatus("starting");

    void startWasmEngine({ role, manager, nodeId, signal: controller.signal }).then((result) => {
      // 中断されていても、載ったことは覚えておく。忘れると離脱→再参加で
      // もう一度 startServer() を呼んでしまう
      if (result.mode === "wasm") {
        started.current = result;
        latest.current.onReleaseBuf?.(result.releaseBuf);
      }
      // 画面を離れたあとに準備完了を出さない(離脱してから前の起動が返ることがある)
      if (controller.signal.aborted) return;
      setStatus(result.mode);
      latest.current.onReady();
    });

    return () => controller.abort();
  }, [enabled, role, manager, nodeId]);

  return status;
}
