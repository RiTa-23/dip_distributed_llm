import { useCallback, useEffect, useRef, useState } from "react";
import { startRequesterRuntime } from "../webrtc/wasmEngine";
import type { ModelSource, RequesterRuntime, RuntimeBox } from "../webrtc/wasmEngine";
import type { LlamaPeerManager } from "../webrtc/peerManager";

/**
 * requester役(RPCクライアント)のRuntimeを画面から使うための繋ぎ込み。
 *
 * peer役(`hooks/useWasmEngine.ts`)とは寿命が違うので、箱を共用しない。
 *
 * - peer … join → leave のあいだ1つ。世代交代では落とさない
 * - requester … **世代ごとに作り直す**。RPC deviceは起動時の `-rpc` 引数で
 *   固定されるため、顔ぶれが変わったら新しいRuntimeを立てるしかない
 *
 * 起動の条件は「その世代のDataChannelが全部開いたあと」。開ききる前に立てると、
 * まだ繋がっていない相手をRPC deviceとして登録してしまう。
 */
export type UseRequesterRuntimeOptions = {
  /** `Module.PeerManager` に載せる本体。`usePeerManager()` の `manager` */
  manager: LlamaPeerManager;
  /** WebRTC側の世代。0は「まだ世代が始まっていない」 */
  generation: number;
  /** その世代で繋ぐべき相手が全部openしたか */
  allOpen: boolean;
  /**
   * この世代のpeerのid。**`rtc.expectedIds` を順序ごとそのまま渡すこと。**
   * 並びがそのままRPC deviceの登録順になる。
   */
  peerIds: string[];
  model: ModelSource;
  /**
   * 生成された文字。**起動時のstdoutも同じ口に来る**ので、呼ぶ側で
   * generateの前後を区切ってから成否に使うこと(`RequesterView` の window)。
   */
  onText: (delta: string) => void;
  onLog?: (line: string) => void;
  onError?: (error: unknown) => void;
};

export type RequesterRuntimeState = {
  /** `runtime.ready` が解決した。プロンプトを送ってよいのはこれがtrueのときだけ */
  ready: boolean;
  error: string | null;
  /** 起動している世代。まだ立てていなければ 0 */
  generation: number;
};

export type UseRequesterRuntime = RequesterRuntimeState & {
  /** readyでなければ投げる。1回の生成が終わると解決する */
  generate: (prompt: string) => Promise<void>;
};

export function useRequesterRuntime(options: UseRequesterRuntimeOptions): UseRequesterRuntime {
  const { manager, generation, allOpen } = options;
  const [state, setState] = useState<RequesterRuntimeState>({
    ready: false,
    error: null,
    generation: 0,
  });

  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  // 起動中でも止められるように箱を同期で持つ。世代が変わったら前のを止めてから立て直す
  const boxRef = useRef<RuntimeBox<RequesterRuntime> | null>(null);
  const runtimeRef = useRef<RequesterRuntime | null>(null);
  // effectが何度評価されても、同じ世代で二度起動しない
  const startedGenerationRef = useRef(0);

  useEffect(() => {
    if (generation <= 0 || !allOpen) return;
    if (startedGenerationRef.current === generation) return;
    startedGenerationRef.current = generation;

    let live = true;
    setState({ ready: false, error: null, generation });

    const box = startRequesterRuntime({
      manager,
      peerIds: [...latest.current.peerIds],
      model: latest.current.model,
      onText: (delta) => latest.current.onText(delta),
      onLog: (line) => latest.current.onLog?.(line),
      onError: (error) => latest.current.onError?.(error),
    });
    boxRef.current = box;

    void box.started
      .then(async (runtime) => {
        runtimeRef.current = runtime;
        await runtime.ready;
        if (!live) return;
        setState({ ready: true, error: null, generation });
      })
      .catch((error: unknown) => {
        if (!live) return;
        setState({ ready: false, error: describe(error), generation });
        latest.current.onError?.(error);
      });

    return () => {
      live = false;
      if (boxRef.current === box) boxRef.current = null;
      runtimeRef.current = null;
      void box.stop();
    };
  }, [manager, generation, allOpen]);

  const generate = useCallback(async (prompt: string) => {
    const runtime = runtimeRef.current;
    if (!runtime) throw new Error("Runtimeがまだ起動していません");
    await runtime.generate(prompt);
  }, []);

  return { ...state, generate };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
