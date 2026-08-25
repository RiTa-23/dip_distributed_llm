// 開発中だけブラウザのコンソールに出す口。
//
// `rpcStub.ts` を実物のRTCDataChannelの上で走らせるための入口で、①のWASMが
// 来るまでのあいだ、橋渡しの側を実機で確かめるのに使う。**製品の経路ではない**ので、
// `import.meta.env.DEV` のときしか生えない(`usePeerManager` が判定する)。
//
// 使い方(2タブ):
//   1. 参加者のタブ(`/`)で `__rpc.serve()`
//   2. 発表者のタブ(`/requester`)で `await __rpc.check()`
//      → 送ったものが加工されて戻れば `ok: true`
//
// 画面の状態には触らない。世代・フェーズの進み方は今までどおり `/ws` が決める。

import type { WebrtcPeerManager } from "./peerManager";
import { runStubClient, startStubServer } from "./rpcStub";
import type { StubClientResult, StubServer } from "./rpcStub";

export type RpcConsole = {
  /** 今つながっている相手 */
  remotes: () => string[];
  /** 参加者側。届いたぶんを加工して返し続ける */
  serve: () => string;
  /** 発表者側。既定は8MiBを1往復。相手を省くと最初の1人へ投げる */
  check: (options?: {
    nodeId?: string;
    sizeMiB?: number;
    rounds?: number;
  }) => Promise<StubClientResult>;
  /** 待ち受けを止める */
  stop: () => string;
};

declare global {
  interface Window {
    __rpc?: RpcConsole;
  }
}

/** コンソールに口を生やす。戻り値を呼ぶと片付く */
export function installRpcConsole(manager: WebrtcPeerManager): () => void {
  let server: StubServer | null = null;

  const api: RpcConsole = {
    remotes: () => manager.remoteIds(),

    serve: () => {
      if (server) return "すでに待ち受けています";
      server = startStubServer(manager, (message) => {
        console.info("[rpc]", message);
      });
      return "待ち受けを開始しました。発表者のタブで __rpc.check() を実行してください";
    },

    check: async (options = {}) => {
      const nodeId = options.nodeId ?? manager.remoteIds()[0];
      if (!nodeId) throw new Error("繋がっている相手がいません");
      const size = (options.sizeMiB ?? 8) * 1024 * 1024;
      const result = await runStubClient(manager, nodeId, { size, rounds: options.rounds ?? 1 });
      const mbps =
        result.ms > 0 ? (result.bytes / 1024 / 1024 / (result.ms / 1000)).toFixed(1) : "-";
      console.info(`[rpc] ${nodeId} と往復しました: ${String(result.ms)}ms (${mbps} MiB/s)`);
      return result;
    },

    stop: () => {
      if (!server) return "待ち受けていません";
      server.stop();
      server = null;
      return "待ち受けを止めました";
    },
  };

  window.__rpc = api;

  return () => {
    server?.stop();
    server = null;
    if (window.__rpc === api) delete window.__rpc;
  };
}
