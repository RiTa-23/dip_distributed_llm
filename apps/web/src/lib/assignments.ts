import type { PeerInfo } from "@dip_distributed_llm/shared-types/messages";
import type { LayerAssignment } from "../types/cluster";

/**
 * 層の割り当ての仮置き。均等割りで見た目を作るためだけのもの。
 *
 * 本物の割り当てはllama.cpp本体が各ピアの空きメモリから比例配分して決める
 * (AGENTS.md「絶対に踏み外してはいけないアーキテクチャ前提」3)。
 * ①が getLayerAssignment() を用意したら、この関数の呼び出しごと差し替える。
 * ここで計算した値を割り当ての決定に使ってはいけない。表示専用。
 */
export function deriveAssignments(peers: PeerInfo[], totalLayers: number): LayerAssignment[] {
  if (peers.length === 0) return [];
  const base = Math.floor(totalLayers / peers.length);
  const rest = totalLayers % peers.length;
  let cursor = 0;
  return peers.map((p, i) => {
    const span = base + (i < rest ? 1 : 0);
    const a: LayerAssignment = {
      clientId: p.clientId,
      startLayer: cursor,
      endLayer: cursor + span - 1,
    };
    cursor += span;
    return a;
  });
}
