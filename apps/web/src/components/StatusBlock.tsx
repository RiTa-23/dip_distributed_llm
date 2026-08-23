import styles from "./StatusBlock.module.css";

type Props = {
  title: string;
  hint?: string;
  /** 稼働中かどうか。丸を塗って脈打たせる */
  active?: boolean;
  /** 丸そのものを出すか(未参加のときは出さない) */
  showDot?: boolean;
};

export function StatusBlock({ title, hint, active = false, showDot = true }: Props) {
  return (
    <div className={styles.block}>
      <div className={styles.label}>STATUS</div>
      <div className={styles.line}>
        {showDot && (
          <span
            className={`${styles.dot} ${active ? `${styles.filled} ${styles.pulse}` : styles.hollow}`}
            aria-hidden="true"
          />
        )}
        <span className={`${styles.title} ${active ? styles.isActive : ""}`}>{title}</span>
      </div>
      {hint && <p className={styles.hint}>{hint}</p>}
    </div>
  );
}
