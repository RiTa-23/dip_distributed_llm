import { describe, expect, test } from "bun:test";
import type {
  GenerationAbortedMessage,
  GenerationStartMessage,
} from "@dip_distributed_llm/shared-types/messages";
import { clusterReducer } from "./clusterReducer";
import type { ClusterAction } from "./clusterReducer";
import { initialClusterState } from "../types/cluster";
import type { ClusterState } from "../types/cluster";

/**
 * 自分を `c-1` と名乗る参加者。実際の画面では useCluster が myId と role を
 * 初期状態に入れるので、既定値(myId は空文字)のままでは自分がどの編成にも
 * 入っていないことになり、generation_start で connecting へ進まない
 */
const asPeer: ClusterState = { ...initialClusterState, myId: "c-1", role: "peer" };

/** 続けて流し込む。実際の画面も1件ずつ dispatch するので同じ順で並べる */
function run(actions: ClusterAction[], from: ClusterState = asPeer): ClusterState {
  return actions.reduce(clusterReducer, from);
}

function start(generation: number, peerIds: string[] = ["c-1", "c-2"]): GenerationStartMessage {
  return { type: "generation_start", generation, peerIds };
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

describe("clusterReducer の generationPeerIds(#81)", () => {
  test("generation_start でpeerIdsが保存される", () => {
    expect(running.generationPeerIds).toEqual(["c-1", "c-2"]);
  });

  test("次の世代のpeerIdsに置き換わる", () => {
    const s = clusterReducer(running, {
      type: "server",
      msg: { type: "generation_start", generation: 2, peerIds: ["c-1", "c-3"] },
    });
    expect(s.generationPeerIds).toEqual(["c-1", "c-3"]);
  });

  test("socket_closed で空に戻る", () => {
    expect(clusterReducer(running, { type: "socket_closed" }).generationPeerIds).toEqual([]);
  });

  test("reset で空に戻る", () => {
    expect(clusterReducer(running, { type: "reset" }).generationPeerIds).toEqual([]);
  });
});

describe("clusterReducer の編成外の判定(#78, #79)", () => {
  /** 編成が組まれるのを待っている参加者 */
  const waiting = run([{ type: "socket_opened" }, { type: "local_ready" }]);

  test("編成に入っていれば connecting へ進む", () => {
    const s = clusterReducer(waiting, { type: "server", msg: start(1, ["c-1", "c-2"]) });
    expect(s.phase).toBe("connecting");
  });

  test("編成に入っていなければ waiting に留まる", () => {
    const s = clusterReducer(waiting, { type: "server", msg: start(1, ["c-2", "c-3"]) });
    // 進めると来ないofferを待って永久に止まる
    expect(s.phase).toBe("waiting");
    // 世代と編成の顔ぶれは、自分が入っていなくても追いかける
    expect(s.generation).toBe(1);
    expect(s.generationPeerIds).toEqual(["c-2", "c-3"]);
  });

  test("errorの参加者は編成外でも error のまま残る", () => {
    const failed = clusterReducer(waiting, { type: "failed", message: "起動に失敗しました" });
    const s = clusterReducer(failed, { type: "server", msg: start(1, ["c-2", "c-3"]) });
    // waiting に戻すと、なぜ外されたのかが画面から消える
    expect(s.phase).toBe("error");
    expect(s.errorMessage).toBe("起動に失敗しました");
  });

  test("errorの参加者は generation_aborted でも error のまま残る", () => {
    // 実機では generation_aborted が generation_start より先に届く。ここで
    // reorganizing にしてしまうと、上のテストの error 判定に届かない
    const failed = clusterReducer(waiting, { type: "failed", message: "起動に失敗しました" });
    const s = clusterReducer(failed, { type: "server", msg: aborted(1, "connection_failed") });
    expect(s.phase).toBe("error");
    expect(s.errorMessage).toBe("起動に失敗しました");
  });

  test("発表者は peerIds に載らないが connecting へ進む", () => {
    const asRequester: ClusterState = {
      ...initialClusterState,
      myId: "requester-1",
      role: "requester",
    };
    const s = run([{ type: "socket_opened" }, { type: "local_ready" }], asRequester);
    expect(clusterReducer(s, { type: "server", msg: start(1, ["c-1", "c-2"]) }).phase).toBe(
      "connecting",
    );
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

describe("peers_dismissed による全員解除(#114)", () => {
  const dismissed = {
    type: "server",
    msg: { type: "peers_dismissed", message: "発表者が編成を解除しました" },
  } as const satisfies ClusterAction;

  test("発表者は待機に戻り、ロスターと編成を手放す", () => {
    const asRequester: ClusterState = {
      ...initialClusterState,
      myId: "c-req",
      role: "requester",
    };
    const active = run(
      [
        { type: "socket_opened" },
        { type: "local_ready" },
        { type: "server", msg: start(1, ["c-1"]) },
        { type: "datachannel_open" },
      ],
      asRequester,
    );
    expect(active.phase).toBe("active");

    const after = clusterReducer(active, dismissed);
    expect(after.phase).toBe("waiting");
    expect(after.roster).toEqual([]);
    expect(after.generationPeerIds).toEqual([]);
  });

  test("発表者を reorganizing にはしない", () => {
    // 次の generation_start は誰かが参加し直すまで来ない。「まもなく再開します」は嘘になる
    const asRequester: ClusterState = { ...initialClusterState, role: "requester" };
    expect(clusterReducer(asRequester, dismissed).phase).not.toBe("reorganizing");
  });

  test("参加者側では状態を動かさない(離脱は PeerView が行う)", () => {
    // ここで idle に落とすと、離脱が反映される前の1描画で参加前の画面が出る
    expect(clusterReducer(running, dismissed)).toBe(running);
  });
});
