import type {
  GenerationAbortedMessage,
  PeerInfo,
} from "@dip_distributed_llm/shared-types/messages";

/**
 * 再編成が始まったきっかけ。Honoの generation_aborted の reason をそのまま持つ。
 * 契約の値が増えたらここも自動で追随する(独自の文字列を定義しない)。
 */
export type AbortReason = GenerationAbortedMessage["reason"];

/**
 * 画面が取りうる状態。
 * booleanを複数持つと「繋がっていないのに貢献中」のようなありえない組み合わせが
 * 表現できてしまうため、常にこの7つのうち1つだけを持つ。
 *
 * 参加者・発表者のどちらも同じ順で通る。違うのは各フェーズで何をするかだけ。
 *   参加者   preparing = エンジン起動   / connecting = モデル受信
 *   発表者   preparing = 参加者待ち     / connecting = モデル配布
 */
export type Phase =
  | "idle"
  | "preparing"
  | "waiting"
  | "connecting"
  | "active"
  | "reorganizing"
  | "error";

export const ALL_PHASES: Phase[] = [
  "idle",
  "preparing",
  "waiting",
  "connecting",
  "active",
  "reorganizing",
  "error",
];

/**
 * 層の割り当て。docs/api-contract.md にはまだ無い。
 * 契約に layer_assignment を足す提案を①②に出す予定で、それまではweb内のローカル型。
 */
export type LayerAssignment = {
  clientId: string;
  startLayer: number;
  endLayer: number;
};

export type ClusterState = {
  phase: Phase;
  roster: PeerInfo[];
  generation: number;
  errorMessage: string | null;
  /**
   * 直前の再編成のきっかけ。人が増えたのか減ったのかを画面が出し分けるために持つ。
   * 編成が終わったら(次の世代が始まったら)null に戻す
   */
  abortReason: AbortReason | null;
  /**
   * 現在の世代の編成に入っているpeerのID(generation_startのpeerIdsをそのまま持つ)。
   * roster(参加者一覧)には status: "error" のpeerも含まれるため、層の割り当ては
   * これで絞り込んだpeerに対してのみ行う(#81)
   */
  generationPeerIds: string[];
};

export const initialClusterState: ClusterState = {
  phase: "idle",
  roster: [],
  generation: 0,
  errorMessage: null,
  abortReason: null,
  generationPeerIds: [],
};
