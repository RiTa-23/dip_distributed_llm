import { useEffect, useState } from "react";
import { createPeerManager } from "../webrtc/peerManager";
import type { WebrtcPeerManager } from "../webrtc/peerManager";
import { installRpcConsole } from "../webrtc/rpcConsole";

/**
 * WebRTCのDataChannelとWASM版llama.cppの間に PeerManager を置く。
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
  /**
   * **データプレーンを壊す直前**に呼ばれる。世代の持ち主を手放す口(`fence`)。
   *
   * `close()` / `detach()` は待機中のrecvを起こす(`peerManager.ts` の `destroy()` が
   * `wake()` と `accepted(false)` を呼ぶ)。起こされた旧Runtimeは失敗を返してくるので、
   * **壊す前に世代を失効させておかないと**、正常な再編成が画面のエラーになる。
   */
  fence?: () => void;
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
  /** 今の `Module.PeerManager` に載せる本体 */
  manager: WebrtcPeerManager;
  handlers: PeerManagerHandlers;
  /** 描画のたびに最新のコールバックを預け直す。フックの中からだけ呼ぶ */
  setOptions: (options: PeerManagerOptions) => void;
  /** WASM側の生成実装がtokenと完了通知を画面へ渡す入口 */
  emitGenerationEvent: (event: GenerationEvent) => void;
  /** 実体が入れ替わったら呼ばれる。フックが再描画するために使う */
  subscribe: (listener: () => void) => () => void;
  /** unmount。**破壊経路はここも含めて `retireCurrent()` に一本化してある** */
  /**
   * 退役していたら新しい実体へ移る。StrictMode の setup 再実行で呼ぶ。
   * **戻すのではなく作り直す**(理由は実装側のコメント)。
   */
  activate: () => void;
  close: () => void;
};

/** `createPeerManager` に渡すぶんのうち、ここが決めるもの */
export type ManagerFactory = (options: { onError: (message: string) => void }) => WebrtcPeerManager;

export type CreateBridgeOptions = {
  /**
   * **世代ごとに実体を作り直すか。**
   *
   * requester は世代ごとにRuntimeを立て直す。そのとき同じ manager を渡してしまうと、
   * まだ止まりきっていない旧Runtimeが新世代と同じfd空間を触れてしまう
   * (`stop()` は止まった証明にならない — Runtime側の契約)。true にすると
   * 旧実体を退役させて新しいものへ差し替えるので、旧Runtimeが握っているのは
   * **退役済みの旧実体だけ**になり、新世代には届かない。
   *
   * peer は join → leave のあいだRuntimeが1つ(B-1のlong-lived契約)。作り直す理由が
   * 無いので既定は false。
   */
  isolateGenerations?: boolean;
  /** 実体の作り方。テストで差し替えるためだけに開けてある */
  createManager?: ManagerFactory;
};

/** 実体1つぶん。**退役したかどうかを実体と一緒に持つ** */
type Entry = {
  manager: WebrtcPeerManager;
  /**
   * **true → false の単調**。戻してはいけない。退役済みの実体を生き返らせると、
   * それを握ったままの旧Runtimeも一緒に復活してしまう。
   */
  active: boolean;
};

/**
 * Reactの外で組み立てる。フックはこれを1回作って持ち回るだけにしてあり、
 * 描画のたびに関数が作り直されない・依存配列が要らない形になる。
 *
 * **Reactに依存しないので、退役の実行順はそのままテストできる**
 * (`usePeerManager.test.ts`)。
 */
export function createBridge(options: CreateBridgeOptions = {}): PeerManagerBridge {
  const { isolateGenerations = false, createManager = createPeerManager } = options;

  // ①のWASMは後から来る。コールバックが途中で埋まっても PeerManager を
  // 作り直さずに済むよう、呼ぶ先はこの箱を1段はさんで解決する
  const latest: PeerManagerOptions = {};
  const listeners = new Set<() => void>();

  const createEntry = (): Entry => {
    // `releaseBuf` は渡さない。受信バッファの所有権はWASMのglue側にあり、
    // 実際に解放する関数をここへ配線すると glue の `close_peer()` と二重解放になる
    // (Runtimeのhandoff契約)。adapterの `releaseConn()` も no-op のまま
    const created: Entry = { manager: undefined as unknown as WebrtcPeerManager, active: true };
    created.manager = createManager({
      // **退役した実体からの通知は捨てる。** 畳むときに起こされた旧Runtimeの悲鳴で、
      // 現行世代の画面をエラーにしない
      onError: (message) => {
        if (!created.active) return;
        latest.onError?.(message);
      },
    });
    return created;
  };

  let entry = createEntry();

  /**
   * 実体を終わらせる。**壊す前に必ず失効させ、通知も止める。**
   *
   * 破壊経路はすべてここを通す。`onClose` / `onReset` だけに置くと、unmount の
   * 直接 close が素通りしてしまう。
   */
  const retireCurrent = (replace: boolean) => {
    latest.fence?.(); // 1. 旧世代のトークンを失効させる
    entry.active = false; // 2. この実体からの通知を止める
    entry.manager.close(); // 3. 全linkを畳む(ここで旧Runtimeが起床する)
    if (!replace) return;
    entry = createEntry(); // 4. 新しい実体
    for (const listener of listeners) listener();
  };

  return {
    get manager() {
      return entry.manager;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setOptions: (next) => {
      latest.onError = next.onError;
      latest.onGenerationEvent = next.onGenerationEvent;
      latest.fence = next.fence;
    },
    emitGenerationEvent: (event) => latest.onGenerationEvent?.(event),
    /**
     * 退役していたら**新しい実体を作る**。戻すのではない。
     *
     * `stop()` は止まった証明にならないので、cleanup の後も旧Runtimeが生きている
     * 可能性がある。退役済みの実体を active に戻すと、**その実体を握っている
     * 旧Runtimeごと復活**し、late な send / connect / onError が現行へ再び作用できる。
     *
     * StrictMode(dev) は mount で setup → cleanup → setup を走らせるので、これが無いと
     * cleanup で退役したまま戸が閉じ、PeerManager の onError が永久に捨てられる。
     */
    activate: () => {
      if (entry.active) return; // 通常の mount。差し替えない
      entry = createEntry();
      for (const listener of listeners) listener();
    },
    close: () => retireCurrent(false),
    handlers: {
      // どのハンドラも**その時点の実体**へ向ける。入れ替わった後に旧実体へ
      // 配ってしまわないよう、キャプチャせず毎回読む
      onOpen: (remoteId, channel) => {
        entry.manager.attach(remoteId, channel);
      },
      onData: (remoteId, data) => {
        entry.manager.handleMessage(remoteId, data);
      },
      onClose: (remoteId) => {
        if (!isolateGenerations) {
          // peer: 相手が1人落ちた。待たせているrecvを失敗で返し、載っている論理接続を畳む。
          // ここを繋がないと、WASM側が Atomics.wait のまま起きなくなる
          entry.manager.detach(remoteId);
          return;
        }
        // requester: RPC deviceは起動時の引数で固定されるので、**1本失った時点で
        // その世代は続行不能**。`detach` だけだと他のlinkが実体に残り、まだ止まって
        // いない旧Runtimeがそこへ send/recv/connect できてしまう。世代ごと畳む
        retireCurrent(true);
      },
      // 世代の切り替え・離脱。DataChannelは受け口を外してから閉じるので
      // onClose は飛んでこない。まとめて畳むのはこちらの役
      onReset: () => {
        if (!isolateGenerations) {
          // peer: 実体は次の世代でも使い続ける。ここで退役させると以降エラーが
          // 永久に届かなくなる(long-lived契約)
          entry.manager.close();
          return;
        }
        retireCurrent(true);
      },
    },
  };
}

export type UsePeerManagerOptions = PeerManagerOptions &
  Pick<CreateBridgeOptions, "isolateGenerations">;

export function usePeerManager(options: UsePeerManagerOptions = {}): PeerManagerBridge {
  const { isolateGenerations = false } = options;
  // マウント時に1回だけ組む。`isolateGenerations` は画面ごとに固定で、途中で
  // 変わることはない(requester=true / peer=false)
  const [bridge] = useState(() => createBridge({ isolateGenerations }));

  // 実体が入れ替わったら描画し直す。`bridge.manager` の identity が変わることで、
  // それを依存に持つ `useRequesterRuntime` の効果が張り替わる
  const [, bumpRotation] = useState(0);
  useEffect(() => bridge.subscribe(() => bumpRotation((n) => n + 1)), [bridge]);

  // `fence` もここで預け直す。効果の登録順は usePeerManager → useWebrtcSignaling
  // なので、`onReset` が呼ばれる時点では必ず入っている
  useEffect(() => {
    bridge.setOptions(options);
  });

  // StrictMode(dev) の setup → cleanup → setup に耐える形にする。cleanup だけだと
  // 退役したまま戻らず、以降 PeerManager の onError が永久に捨てられる
  useEffect(() => {
    bridge.activate();
    return () => bridge.close();
  }, [bridge]);

  // ①のWASMが来るまでのあいだ、実物のDataChannelでRPCを試すための口。
  // 開発中だけ生える(`webrtc/rpcConsole.ts` の使い方を参照)。
  // 入れ替わったら張り直す — 退役した旧実体を指したままにしない
  const manager = bridge.manager;
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    return installRpcConsole(manager);
  }, [manager]);

  return bridge;
}
