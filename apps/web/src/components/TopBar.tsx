import type { ReactNode } from "react";
import styles from "./TopBar.module.css";

type Props = {
  left: ReactNode;
  right?: ReactNode;
};

export function TopBar({ left, right }: Props) {
  return (
    <header className={styles.bar}>
      <span>{left}</span>
      {right && <span className={styles.right}>{right}</span>}
    </header>
  );
}
