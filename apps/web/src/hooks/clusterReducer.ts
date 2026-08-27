import type { ServerMessage } from "@dip_distributed_llm/shared-types/messages";
import type { ClusterState, Phase } from "../types/cluster";

/**
 * 画面の状態を動かすきっかけ。出どころは2つある。
 *   server  … Honoから届いたメッセージ(②の担当範囲)
 *   それ以外 … 自分のブラウザの中で起きたこと(フロントの担当範囲)
 */
export type ClusterAction =
  | { type: "socket_opened" }
  | { type: "socket_closed" }
  /** 自分の準備が終わった(参加者: エンジン起動完了 / 発表者: 接続完了) */
  | { type: "local_ready" }
  /** 相手と直接繋がった(WebRTCのDataChannelが開いた) */
  | { type: "datachannel_open" }
  | { type: "server"; msg: ServerMessage }
  | { type: "failed"; message: string }
  | { type: "reset" }
  /** 開発用パネル専用。任意のフェーズへ飛ばす */
  | { type: "dev_set_phase"; phase: Phase };

export function clusterReducer(s: ClusterState, a: ClusterAction): ClusterState {
  switch (a.type) {
    case "socket_opened":
      return { ...s, phase: "preparing", errorMessage: null };

    case "socket_closed":
      // 世代も戻す。残すと離脱後の上端に「0人 · 第N世代」が出る
      return {
        ...s,
        phase: "idle",
        roster: [],
        generation: 0,
        abortReason: null,
        generationPeerIds: [],
        abortMessage: null,
      };

    case "local_ready":
      // 編成が先に始まっていた場合に巻き戻さない
      return s.phase === "preparing" ? { ...s, phase: "waiting" } : s;

    case "datachannel_open":
      return s.phase === "connecting" ? { ...s, phase: "active" } : s;

    case "failed":
      return { ...s, phase: "error", errorMessage: a.message };

    case "reset":
      return {
        ...s,
        phase: "idle",
        roster: [],
        generation: 0,
        errorMessage: null,
        abortReason: null,
        generationPeerIds: [],
        abortMessage: null,
      };

    case "dev_set_phase":
      return { ...s, phase: a.phase };

    case "server":
      switch (a.msg.type) {
        case "roster_update":
          // 人が増減しただけ。フェーズは動かさない
          return { ...s, roster: a.msg.peers };

        case "generation_start":
<<<<<<< HEAD
          // 編成し直しが済んだ。きっかけはもう表示しない
=======
>>>>>>> be9efdf (fix: 発表者画面で再編成理由を保持する(#61))
          return {
            ...s,
            generation: a.msg.generation,
            phase: "connecting",
            abortReason: null,
            generationPeerIds: a.msg.peerIds,
            abortMessage: null,
          };

        case "generation_aborted":
          // 古い世代の通知が遅れて届くことがある。捨てないと正常な編成が巻き込まれる
          if (a.msg.generation < s.generation) return s;
          return {
            ...s,
            phase: "reorganizing",
            abortReason: a.msg.reason,
            abortMessage: a.msg.message,
          };

        case "webrtc_signal":
          // 接続手続きのメッセージ。フェーズには関係しない
          return s;
      }
  }
}
