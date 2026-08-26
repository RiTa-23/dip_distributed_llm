import { useEffect, useRef, useState } from "react";
import { createEngineStarter } from "../webrtc/wasmEngine";
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

/**
 * 返すのは直近の起動の結果(まだ終わっていなければ `null`)。表示には使っていないが、
 * WASMで載ったのかダミー経路なのかを画面から見分けられるようにしてある。
 */
export function useWasmEngine(options: UseWasmEngineOptions): EngineStartResult | null {
  const { role, manager, nodeId, enabled } = options;
  const [result, setResult] = useState<EngineStartResult | null>(null);

  // 描画のたびに最新のコールバックを預け直す。依存配列に入れると、
  // 描画のたびに起動をやり直してしまう
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  // 「1つのPeerManagerにエンジンは1つ」を守るのはこの箱の役目。走っている最中の
  // 再参加は相乗りし、載ったあとは覚えたものが返る(`webrtc/wasmEngine.ts`)
  const [starter] = useState(createEngineStarter);

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();

    void starter.start({ role, manager, nodeId, signal: controller.signal }).then((started) => {
      if (started.mode === "wasm") latest.current.onReleaseBuf?.(started.releaseBuf);
      // 画面を離れたあとに準備完了を出さない(離脱してから前の起動が返ることがある)
      if (controller.signal.aborted) return;
      setResult(started);
      latest.current.onReady();
    });

    return () => controller.abort();
  }, [enabled, role, manager, nodeId, starter]);

  return result;
}
