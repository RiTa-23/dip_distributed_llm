import type { PeerInfo } from "@dip_distributed_llm/shared-types/messages";
import type { LayerAssignment } from "../types/cluster";
import styles from "./LayerBar.module.css";

type Props = {
  totalLayers: number;
  assignments: LayerAssignment[];
  roster: PeerInfo[];
  /** 今まさに計算しているピア。発表者画面で使う */
  computingClientId?: string | null;
  /** 自分として強調するピア。参加者画面で使う */
  highlightClientId?: string | null;
  /** 区間の中に名前を出すか */
  showLabels?: boolean;
};

/**
 * 全層を1本のバーにし、各ピアの担当区間を並べる。
 * 参加者画面は「自分」を、発表者画面は「計算中」を強調する。見え方が違うだけで同じ部品。
 */
export function LayerBar({
  totalLayers,
  assignments,
  roster,
  computingClientId = null,
  highlightClientId = null,
  showLabels = true,
}: Props) {
  if (assignments.length === 0) {
    return (
      <div>
        <div className={styles.empty} />
        <div className={styles.scale}>
          <span>参加者がいません</span>
          <span>全{totalLayers}層</span>
        </div>
      </div>
    );
  }

  const nameOf = (clientId: string) =>
    roster.find((p) => p.clientId === clientId)?.displayName ?? clientId;

  const sorted = [...assignments].sort((a, b) => a.startLayer - b.startLayer);
  const computingIndex = sorted.findIndex((a) => a.clientId === computingClientId);

  return (
    <div>
      <div className={styles.bar}>
        {sorted.map((a, i) => {
          const span = a.endLayer - a.startLayer + 1;
          const isComputing = a.clientId === computingClientId;
          const isHighlight = a.clientId === highlightClientId;
          const isDone = computingIndex >= 0 && i < computingIndex;
          const mark = isComputing
            ? styles.computing
            : isHighlight
              ? styles.highlight
              : isDone
                ? styles.done
                : "";
          return (
            <div
              key={a.clientId}
              className={`${styles.seg} ${mark}`}
              style={{ flexGrow: span }}
              title={`${nameOf(a.clientId)} / 第${a.startLayer}〜${a.endLayer}層`}
            >
              {showLabels && (isHighlight || isComputing) ? nameOf(a.clientId) : ""}
            </div>
          );
        })}
      </div>
      <div className={styles.scale}>
        <span>第0層</span>
        <span>全{totalLayers}層</span>
      </div>
    </div>
  );
}
