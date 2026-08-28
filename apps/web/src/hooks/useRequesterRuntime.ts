import { useCallback, useEffect, useRef, useState } from "react";
import { startRequesterRuntime } from "../webrtc/wasmEngine";
import type { ModelSource, RequesterRuntime, RuntimeBox } from "../webrtc/wasmEngine";
import type { GenerationOwner, GenerationToken } from "../webrtc/generationOwner";
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
 *
 * **世代の持ち主(`webrtc/generationOwner.ts`)は画面が1つだけ作り、ここへ渡す。**
 * `stop()` は止まった証明にならないので、古い世代のRuntimeが遅れて呼んでくる前提で、
 * 現行世代でない呼び出しをすべて落とす。
 *
 * claim するのは**ここだけ**。失効させるのはここと、データプレーンを壊す側
 * (`usePeerManager` の `retireCurrent`)。壊す側が持ち主を共有していないと、
 * `close()` で起こされた旧Runtimeの失敗がまだ有効なトークンを素通りしてしまう。
 */
export type UseRequesterRuntimeOptions = {
  /** `Module.PeerManager` に載せる本体。`usePeerManager()` の `manager` */
  manager: LlamaPeerManager;
  /**
   * 世代の持ち主。**画面が1つだけ作って、データプレーンを壊す側と共有する。**
   * claim するのはこのフックだけ。
   */
  owner: GenerationOwner;
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
   * `model` が確定したか(#65)。`useModelInfo` の `/model-info` 取得が終わるまでは
   * フォールバック値の可能性がある。Runtimeはこれを**待ってから起動**しないと、
   * 仮置きモデル名で立ち上がって後から乖離する(CodeRabbit #101)。
   */
  modelSettled: boolean;
  /**
   * 生成された文字。**起動時のstdoutも同じ口に来る**ので、呼ぶ側で
   * generateの前後を区切ってから成否に使うこと(`RequesterView` の window)。
   * 古い世代のRuntimeからのぶんはここに来る前に落ちる。
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
  /**
   * 今この瞬間の持ち主を取る。画面側の非同期処理(生成1回ぶん)は**始めるときに**
   * これで掴んでおき、解決したときに `isCurrent()` で自分がまだ持ち主かを
   * 確かめてから状態に触る。まだ世代が始まっていなければ null。
   *
   * 描画に載せず関数で渡すのは、欲しいのが「押した瞬間の値」だからで、
   * state にすると描画1回ぶんの遅れが入る余地ができる。
   */
  currentToken: () => GenerationToken | null;
};

/** 世代交代でRuntimeを畳んだことが原因の中断。**画面のエラーにはしない** */
export class GenerationSupersededError extends Error {
  constructor() {
    super("再編成のため中断しました");
    this.name = "GenerationSupersededError";
  }
}

export function useRequesterRuntime(options: UseRequesterRuntimeOptions): UseRequesterRuntime {
  const { manager, owner, generation, allOpen, modelSettled } = options;
  const [state, setState] = useState<RequesterRuntimeState>({
    ready: false,
    error: null,
    generation: 0,
  });

  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const tokenRef = useRef<GenerationToken | null>(null);

  // 起動中でも止められるように箱を同期で持つ。世代が変わったら前のを止めてから立て直す
  const boxRef = useRef<RuntimeBox<RequesterRuntime> | null>(null);
  // **どの世代のRuntimeかを一緒に持つ。** 世代だけ見て代入すると、遅れて解決した
  // 古い箱が現行のRuntimeを上書きしてしまう
  const runtimeRef = useRef<{ token: GenerationToken; runtime: RequesterRuntime } | null>(null);
  // effectが何度評価されても、同じ世代で二度起動しない
  const startedGenerationRef = useRef(0);

  useEffect(() => {
    if (generation <= 0 || !allOpen || !modelSettled) {
      // 立てられる状態ではない。ここに来るのは世代前・再編成中・相手が落ちたとき・
      // モデル情報がまだ確定していないとき(#65)。
      // 直前の cleanup でRuntimeは畳んでいるので、**持ち主も手放す**。
      // ここで手放さないと、畳んだ後のトークンが現行のままになり、
      // 進行中だった生成の reject を画面が障害として受け取ってしまう
      startedGenerationRef.current = 0;
      owner.release();
      tokenRef.current = null;
      return;
    }
    if (startedGenerationRef.current === generation) return;
    startedGenerationRef.current = generation;

    // ここから先、この世代が持ち主。前のトークンはこの瞬間に失効する
    const mine = owner.claim(generation);
    tokenRef.current = mine;
    setState({ ready: false, error: null, generation });

    // `/model-info` の確定を待ってから起動するので、ここで渡す model が仮置きの
    // ままで立ち上がることはない(#65)。確定後に値は変わらないため、生成途中で
    // Runtimeを張り替える必要もない
    const box = startRequesterRuntime({
      manager,
      peerIds: [...latest.current.peerIds],
      model: latest.current.model,
      // 古い世代のRuntimeが遅れて吐いたぶんを、現行世代の画面へ流さない
      onText: mine.guard((delta: string) => latest.current.onText(delta)),
      onLog: mine.guard((line: string) => latest.current.onLog?.(line)),
      onError: mine.guard((error: unknown) => latest.current.onError?.(error)),
    });
    boxRef.current = box;

    void box.started
      .then(async (runtime) => {
        // **`isCurrent()` を通してから代入する。** 遅れて解決した古い箱に
        // 現行のRuntimeを上書きさせない
        if (!mine.isCurrent()) return;
        runtimeRef.current = { token: mine, runtime };
        await runtime.ready;
        if (!mine.isCurrent()) return;
        setState({ ready: true, error: null, generation });
      })
      .catch((error: unknown) => {
        if (!mine.isCurrent()) return;
        setState({ ready: false, error: describe(error), generation });
        latest.current.onError?.(error);
      });

    return () => {
      if (boxRef.current === box) boxRef.current = null;
      // 参照を外す**前に**打ち切る。先に null にすると cancel する相手を見失う
      const held = runtimeRef.current;
      if (held?.token === mine) {
        runtimeRef.current = null;
        // 生成の途中なら先に打ち切る。`stop()` だけだと止めきるまで走り続ける
        // (止まった証明にはならないので、トークン側でも落とす)
        try {
          held.runtime.cancel();
        } catch {
          // すでに畳んだ。打ち切る対象がない
        }
      }
      void box.stop();
    };
  }, [manager, owner, generation, allOpen, modelSettled]);

  // unmount で持ち主を手放す。以降どのトークンも通らない
  useEffect(() => () => owner.release(), [owner]);

  const currentToken = useCallback(() => tokenRef.current, []);

  const generate = useCallback(async (prompt: string) => {
    const held = runtimeRef.current;
    if (!held) throw new Error("Runtimeがまだ起動していません");
    // 起動した世代がもう持ち主でなければ、その Runtime は畳まれている
    if (!held.token.isCurrent()) throw new GenerationSupersededError();
    await held.runtime.generate(prompt);
  }, []);

  // **ready はここで同期に絞る。** effectのsetStateに任せると1描画ぶん遅れ、
  // `allOpen` が落ちた瞬間に前の世代の true が漏れる。漏れると `canSubmit` が通り、
  // 畳んだ Runtime へプロンプトを送れてしまう
  const ready = state.ready && state.generation === generation && generation > 0 && allOpen;

  return { ...state, ready, generate, currentToken };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
