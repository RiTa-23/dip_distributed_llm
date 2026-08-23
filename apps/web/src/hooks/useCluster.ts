import { useEffect, useMemo, useReducer } from "react";
import { clusterReducer } from "./clusterReducer";
import { useHonoSocketMock as useHonoSocket } from "./useHonoSocket.mock";
// ↑ ステップ3ではこの1行を useHonoSocket に差し替える
import { initialClusterState } from "../types/cluster";
import type { LayerAssignment } from "../types/cluster";
import { deriveAssignments } from "../lib/assignments";
import { TOTAL_LAYERS } from "../config";
import type { SocketDebug } from "./useHonoSocket.mock";
import type { ClusterAction } from "./clusterReducer";
import type { ClusterState } from "../types/cluster";
import type { ClientMessage } from "@dip_distributed_llm/shared-types/messages";

export type Cluster = {
  state: ClusterState;
  dispatch: (a: ClusterAction) => void;
  send: (msg: ClientMessage) => void;
  assignments: LayerAssignment[];
  debug: SocketDebug | null;
};

/**
 * 両画面が状態に触る唯一の入口。
 * ここを通しておけば、モックから本物への差し替えがこのファイルの中で完結する。
 */
export function useCluster(options: { enabled: boolean }): Cluster {
  const [state, dispatch] = useReducer(clusterReducer, initialClusterState);
  const { connected, lastMessage, send, debug } = useHonoSocket(options);

  useEffect(() => {
    dispatch(connected ? { type: "socket_opened" } : { type: "socket_closed" });
  }, [connected]);

  useEffect(() => {
    if (lastMessage) dispatch({ type: "server", msg: lastMessage });
  }, [lastMessage]);

  // 表示用の仮の割り当て。本物は①の getLayerAssignment() から来る
  const assignments = useMemo(() => deriveAssignments(state.roster, TOTAL_LAYERS), [state.roster]);

  return { state, dispatch, send, assignments, debug };
}
