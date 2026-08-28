import { useEffect, useRef, useState } from "react";
import { startPeerRuntime } from "../webrtc/wasmEngine";
import type { PeerRuntime, RuntimeBox } from "../webrtc/wasmEngine";
import type { LlamaPeerManager } from "../webrtc/peerManager";

/**
 * peer役(RPCサーバ)のRuntimeを画面から使うための繋ぎ込み。
 *
 * 起動そのものは `webrtc/wasmEngine.ts` にあり、こちらが持つのは
 * 「いつ始めるか」「終わったら誰に知らせるか」だけ。フェーズの判断はしない
 * (`useHonoSocket` / `useWebrtcSignaling` と同じ)。
 *
 * **Runtimeの寿命は join → leave/unmount**。フェーズでは止めない。
 * 世代交代のたびに落とすと、次の世代のためにモデル無しのRPCサーバを
 * 立て直すことになり、待ち時間がそのぶん伸びる。世代の切り替えは
 * PeerManager側の張り替えで吸収する(`usePeerManager` の `onReset`)。
 *
 * requester役は寿命が違う(世代ごとに作り直す)ので、この箱を共用しない。
 * あちらは `hooks/useRequesterRuntime.ts`。
 */
export type UseWasmEngineOptions = {
  /** `Module.PeerManager` に載せる本体。`usePeerManager()` の `manager` */
  manager: LlamaPeerManager;
  /** trueのあいだ動かす。参加者画面は「参加した」かどうかを渡す */
  enabled: boolean;
  /** stdout/stderr。画面には出さず、コンソールで追う用 */
  onLog?: (line: string) => void;
  /** Runtimeが異常終了した。ダミーへは落ちないので、ここに来たら失敗 */
  onError?: (error: unknown) => void;
  /**
   * peerをCPUバックエンドで動かす。MoEモデルはWebGPU peerだとfirst tokenに
   * 到達しない(Runtime側のO11)ため、MoEを載せるあいだはtrueにする。
   */
  disableWebGPU?: boolean;
};

export type PeerRuntimeState = {
  /** `runtime.ready` が解決した。一度trueになったら、その参加のあいだ変わらない */
  ready: boolean;
  /** 読み込みか起動に失敗した。**ready とは排他** */
  error: string | null;
};

export function useWasmEngine(options: UseWasmEngineOptions): PeerRuntimeState {
  const { manager, enabled, disableWebGPU } = options;
  const [state, setState] = useState<PeerRuntimeState>({ ready: false, error: null });

  // 描画のたびに最新のコールバックを預け直す。依存配列に入れると、
  // 描画のたびに起動をやり直してしまう
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  // 起動中でも止められるように、箱は同期で持つ。AbortSignalだけを片付けの手段に
  // すると、abortしてもRuntime自体は起動を続けてしまう
  const boxRef = useRef<RuntimeBox<PeerRuntime> | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let live = true;
    setState({ ready: false, error: null });

    // `startPeerRuntime` は箱を同期で返す。ここで即refへ入れておけば、
    // 読み込みの途中で離脱してもcleanupが確実に止められる
    const box = startPeerRuntime({
      manager,
      disableWebGPU,
      onLog: (line) => latest.current.onLog?.(line),
      onError: (error) => latest.current.onError?.(error),
    });
    boxRef.current = box;

    void box.started
      .then(async (runtime) => {
        await runtime.ready;
        // 画面を離れたあとに準備完了を出さない
        if (!live) return;
        setState({ ready: true, error: null });
      })
      .catch((error: unknown) => {
        if (!live) return;
        setState({ ready: false, error: describe(error) });
        latest.current.onError?.(error);
      });

    return () => {
      live = false;
      boxRef.current = null;
      void box.stop();
    };
  }, [enabled, manager, disableWebGPU]);

  return state;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
