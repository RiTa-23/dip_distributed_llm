import { useEffect, useMemo, useReducer } from "react";
import { clusterReducer } from "./clusterReducer";
import { useHonoSocketMock } from "./useHonoSocket.mock";
import { useHonoSocket } from "./useHonoSocket";
import { useModelInfo } from "./useModelInfo";
import { initialClusterState } from "../types/cluster";
import type { LayerAssignment } from "../types/cluster";
import { deriveAssignments } from "../lib/assignments";
import type { ModelInfo } from "../lib/modelInfo";
import { USE_MOCK_SOCKET } from "../config";
import type { SocketDebug } from "../types/socket";
import type { ClusterAction } from "./clusterReducer";
import type { ClusterState } from "../types/cluster";
import type {
  ClientMessage,
  Role,
  ServerMessage,
} from "@dip_distributed_llm/shared-types/messages";

/**
 * モックと本物のどちらを使うかは、モジュールの読み込み時に1回だけ決まる。
 * 描画のたびに変わらないため、フックの呼び出し順は常に同じになる。
 * 切り替えは config.ts の USE_MOCK_SOCKET(環境変数 VITE_MOCK_SOCKET)。
 */
const useSocket = USE_MOCK_SOCKET ? useHonoSocketMock : useHonoSocket;

export type Cluster = {
  state: ClusterState;
  dispatch: (a: ClusterAction) => void;
  send: (msg: ClientMessage) => void;
  /** `/ws` から届いた直近の1件。useWebrtcSignaling が webrtc_signal を拾うために使う */
  lastMessage: ServerMessage | null;
  assignments: LayerAssignment[];
  debug: SocketDebug | null;
  /** モデル名・総層数(サーバ由来。#65)。取得失敗時はconfig.tsのフォールバック値 */
  model: ModelInfo;
  /** `/model-info` の取得完了・失敗確定(#65)。確定前は model が仮置きの可能性がある */
  modelSettled: boolean;
};

/**
 * 両画面が状態に触る唯一の入口。
 * ここを通しておけば、モックから本物への差し替えがこのファイルの中で完結する。
 */
export function useCluster(options: { enabled: boolean; myId: string; role: Role }): Cluster {
  // myId と role は初期状態に埋め込む。アクションを足して後から知らせる形にすると
  // 「その通知と generation_start のどちらが先に届くか」を考えることになるので、
  // 最初から持たせて順番の問題を作らない(reducerが自分の編成外を判定するのに要る)
  const [state, dispatch] = useReducer(clusterReducer, options, (o) => ({
    ...initialClusterState,
    myId: o.myId,
    role: o.role,
  }));
  const { connected, lastMessage, send, debug } = useSocket(options);
  // モデル名・総層数はサーバが配る(#65)。層バーの総数と仮の割り当てに使う
  const { settled, ...model } = useModelInfo();

  useEffect(() => {
    dispatch(connected ? { type: "socket_opened" } : { type: "socket_closed" });
  }, [connected]);

  useEffect(() => {
    if (lastMessage) dispatch({ type: "server", msg: lastMessage });
  }, [lastMessage]);

  // 層バーは現在の編成(generation_startのpeerIds)に入っているpeerだけを対象にする。
  // rosterには status: "error" のpeerも残るため、そのままでは誰も計算していない
  // 層が「担当」として表示されてしまう(#81)。ロスター一覧の表示自体は変えない。
  // generationPeerIdsが空(まだ一度もgeneration_startを受けていない)なら、
  // idle/preparing/waitingの間ずっと「参加者がいません」になってしまうため
  // ロスター全体にフォールバックする。これは「これから参加している人たちで
  // 分けるとこうなる」という仮表示で、#81が問題にしている「編成が存在するのに
  // 編成外のpeerが混ざる」ケースとは衝突しない
  const generationPeers = useMemo(
    () =>
      state.generationPeerIds.length === 0
        ? state.roster
        : state.roster.filter((p) => state.generationPeerIds.includes(p.clientId)),
    [state.roster, state.generationPeerIds],
  );

  // 表示用の仮の割り当て。本物は①の getLayerAssignment() から来る
  const assignments = useMemo(
    () => deriveAssignments(generationPeers, model.totalLayers),
    [generationPeers, model.totalLayers],
  );

  return { state, dispatch, send, lastMessage, assignments, debug, model, modelSettled: settled };
}
