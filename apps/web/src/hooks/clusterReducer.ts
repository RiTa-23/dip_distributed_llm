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

/** サーバー通知とブラウザ内イベントから参加者・発表者の状態を更新する。 */
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

        case "generation_start": {
          // 編成し直しが済んだ。きっかけはもう表示しない。
          //
          // ただし編成に自分が入っていないpeerは connecting へ進めない。進めると
          // 来ないofferを待って永久に止まる(スタック検知は reorganizing にしか
          // 付いていないので逃げ道がない)。#57でHonoが status: "error" のpeerを
          // 編成から外すようになり、#79でそのerrorを実際に送るようになったことで
          // 到達するようになった経路(2026/8/27の実機確認で確定)
          const excluded = s.role === "peer" && !a.msg.peerIds.includes(s.myId);
          return {
            ...s,
            generation: a.msg.generation,
            // errorのpeerは error のまま残す。waiting に戻すと失敗の理由が画面から消える
            phase: excluded ? (s.phase === "error" ? "error" : "waiting") : "connecting",
            abortReason: null,
            // 編成外でも持つ。層バー(#81)は「今動いている編成」を出すものなので、
            // 自分がそこに入っているかとは別の話
            generationPeerIds: a.msg.peerIds,
            abortMessage: null,
          };
        }

        case "generation_aborted":
          // 古い世代の通知が遅れて届くことがある。捨てないと正常な編成が巻き込まれる
          if (a.msg.generation < s.generation) return s;
          return {
            ...s,
            // 失敗して止まっている画面は、再編成中に見せない(2026/8/27の実機確認)。
            // Honoはこの端末を status: "error" として編成から外したままなので
            // (#57)、「メンバーが変わりました。まもなく再開します」は嘘になる。
            // 戻る道は「参加し直す」だけで、それは error の画面にしか出ない
            phase: s.phase === "error" ? "error" : "reorganizing",
            abortReason: a.msg.reason,
            abortMessage: a.msg.message,
          };

        case "webrtc_signal":
          // 接続手続きのメッセージ。フェーズには関係しない
          return s;
      }
  }
}
