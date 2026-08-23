import styles from "./ProgressBar.module.css";

type Props = {
  /** 0〜1 */
  value: number;
  label?: string;
};

export function ProgressBar({ value, label }: Props) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      className={styles.track}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <span className={styles.fill} style={{ width: `${pct}%` }} />
    </div>
  );
}
