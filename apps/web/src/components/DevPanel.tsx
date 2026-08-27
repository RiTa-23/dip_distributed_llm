import type { ReactNode } from "react";
import { ALL_PHASES } from "../types/cluster";
import type { Phase } from "../types/cluster";
import type { SocketDebug } from "../types/socket";
import styles from "./DevPanel.module.css";

type Props = {
  phase: Phase;
  onPhase: (p: Phase) => void;
  debug?: SocketDebug | null;
  extra?: ReactNode;
};

/**
 * Honoが未完成のあいだ、フェーズとロスターの増減を手で再現するためのパネル。
 * 本番ビルドでは描画しない。
 */
export function DevPanel({ phase, onPhase, debug, extra }: Props) {
  if (!import.meta.env.DEV) return null;
  return (
    <div className={styles.panel}>
      <span className={styles.label}>PHASE</span>
      {ALL_PHASES.map((p) => (
        <button
          key={p}
          type="button"
          className={p === phase ? styles.on : ""}
          onClick={() => onPhase(p)}
        >
          {p}
        </button>
      ))}
      {debug && (
        <>
          <span className={styles.sep} />
          <span className={styles.label}>ROSTER</span>
          <button type="button" onClick={() => debug.addPeer(`参加者${Date.now() % 100}`)}>
            ピアを足す
          </button>
          <button type="button" onClick={debug.removeLastPeer}>
            ピアを抜く
          </button>
          <button type="button" onClick={debug.startGeneration}>
            生成開始
          </button>
        </>
      )}
      {extra}
    </div>
  );
}
