import { describe, expect, test } from "bun:test";
import type {
  GenerationAbortedMessage,
  GenerationStartMessage,
} from "@dip_distributed_llm/shared-types/messages";
import { clusterReducer } from "./clusterReducer";
import type { ClusterAction } from "./clusterReducer";
import { initialClusterState } from "../types/cluster";
import type { ClusterState } from "../types/cluster";

/** 続けて流し込む。実際の画面も1件ずつ dispatch するので同じ順で並べる */
function run(actions: ClusterAction[], from: ClusterState = initialClusterState): ClusterState {
  return actions.reduce(clusterReducer, from);
}

function start(generation: number): GenerationStartMessage {
  return { type: "generation_start", generation, peerIds: ["c-1", "c-2"] };
}

function aborted(
  generation: number,
  reason: GenerationAbortedMessage["reason"],
): GenerationAbortedMessage {
  return { type: "generation_aborted", generation, reason, message: "再編成します" };
}

/** 第1世代が動いている状態。再編成の試験はここから始める */
const running = run([
  { type: "socket_opened" },
  { type: "local_ready" },
  { type: "server", msg: start(1) },
  { type: "datachannel_open" },
]);

describe("clusterReducer の再編成", () => {
  test("動いている状態を用意できている", () => {
    expect(running.phase).toBe("active");
    expect(running.generation).toBe(1);
  });

  test("人が増えたときの理由を保持する", () => {
    const s = clusterReducer(running, { type: "server", msg: aborted(1, "peer_joined") });
    expect(s.phase).toBe("reorganizing");
    expect(s.abortReason).toBe("peer_joined");
  });

  test("人が減ったときの理由を保持する", () => {
    const s = clusterReducer(running, { type: "server", msg: aborted(1, "peer_disconnected") });
    expect(s.abortReason).toBe("peer_disconnected");
  });

  test("古い世代の generation_aborted は捨てる", () => {
    const s2 = clusterReducer(running, { type: "server", msg: start(2) });
    // 第1世代あての遅れた通知。拾うと正常に始まった第2世代を巻き込む
    const s = clusterReducer(s2, { type: "server", msg: aborted(1, "peer_disconnected") });
    expect(s).toBe(s2);
    expect(s.phase).toBe("connecting");
    expect(s.abortReason).toBeNull();
  });

  test("次の世代が始まったら理由を消す", () => {
    const s = run(
      [
        { type: "server", msg: aborted(1, "peer_joined") },
        { type: "server", msg: start(2) },
      ],
      running,
    );
    expect(s.phase).toBe("connecting");
    expect(s.generation).toBe(2);
    expect(s.abortReason).toBeNull();
  });

  test("離脱・切断でも理由を消す", () => {
    const abortedState = clusterReducer(running, {
      type: "server",
      msg: aborted(1, "peer_joined"),
    });
    expect(clusterReducer(abortedState, { type: "reset" }).abortReason).toBeNull();
    expect(clusterReducer(abortedState, { type: "socket_closed" }).abortReason).toBeNull();
  });
});

describe("clusterReducer のエラー", () => {
  test("失敗の内容をそのまま持つ", () => {
    const s = clusterReducer(running, { type: "failed", message: "DataChannelが開けません" });
    expect(s.phase).toBe("error");
    expect(s.errorMessage).toBe("DataChannelが開けません");
  });

  test("繋ぎ直したら前回の失敗を消す", () => {
    const failed = clusterReducer(running, { type: "failed", message: "起動できません" });
    expect(clusterReducer(failed, { type: "socket_opened" }).errorMessage).toBeNull();
  });
});
