import styles from "./StatusBlock.module.css";

type Props = {
  title: string;
  hint?: string;
  /** 稼働中かどうか。丸を塗る */
  active?: boolean;
  /**
   * 丸を脈打たせるか。既定は `active` と同じ。
   * 実測の動きに合わせて点滅させたいときだけ、塗りと分けて渡す
   * (稼働中でも一瞬データが途切れる。そこで塗りまで消えると点滅して見える)
   */
  pulsing?: boolean;
  /** 丸そのものを出すか(未参加のときは出さない) */
  showDot?: boolean;
};

export function StatusBlock({ title, hint, active = false, pulsing, showDot = true }: Props) {
  const beating = pulsing ?? active;
  return (
    // フェーズの見出し・説明文がここでしか変わらないので、状態変化の読み上げ領域は
    // このブロックそのものに付ける(#66)。dot の pulse はクラス属性だけの変化で
    // テキストノードを触らないため、脈打つたびに読み上げが連呼される心配はない
    <div className={styles.block} aria-live="polite" aria-atomic="true">
      <div className={styles.label}>STATUS</div>
      <div className={styles.line}>
        {showDot && (
          <span
            className={`${styles.dot} ${active ? styles.filled : styles.hollow} ${beating ? styles.pulse : ""}`}
            aria-hidden="true"
          />
        )}
        <span className={`${styles.title} ${active ? styles.isActive : ""}`}>{title}</span>
      </div>
      {hint && <p className={styles.hint}>{hint}</p>}
    </div>
  );
}
