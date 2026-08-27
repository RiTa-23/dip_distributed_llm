import type { ReactNode } from "react";
import styles from "./Metric.module.css";

export function MetricGrid({ children }: { children: ReactNode }) {
  return <div className={styles.grid}>{children}</div>;
}

export function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.card}>
      <div className={styles.label}>{label}</div>
      <div className={styles.value}>{value}</div>
    </div>
  );
}
