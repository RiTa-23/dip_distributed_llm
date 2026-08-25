import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useJoinUrl } from "../hooks/useJoinUrl";
import styles from "./JoinQr.module.css";

type Props = {
  /** 参加者を募っている最中は大きく出す。埋まった後も消さず、小さく残す */
  emphasized?: boolean;
};

/**
 * 参加者を集めるQR。
 *
 * QRはSVGで描く。外部のQR生成APIは会場LAN完結の前提(AGENTS.md 前提6)に反する上、
 * COEP: require-corp で読み込み自体がブロックされる。
 *
 * 配色はQRだけ反転させている(明地に暗いモジュール)。暗い背景のままだと
 * 読み取れないカメラアプリがある。
 */
export function JoinQr({ emphasized = false }: Props) {
  const { url, candidates, select } = useJoinUrl();
  const [projecting, setProjecting] = useState(false);

  // 投影中はEscで閉じられるようにする(発表中にマウスを探さなくて済む)
  useEffect(() => {
    if (!projecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setProjecting(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [projecting]);

  return (
    <div>
      <div className={styles.sectionLabel}>参加者を集める</div>

      <button
        type="button"
        className={`${styles.code} ${emphasized ? styles.large : styles.small}`}
        onClick={() => setProjecting(true)}
        title="クリックで拡大(投影用)"
      >
        <QRCodeSVG value={url} size={emphasized ? 168 : 96} marginSize={2} {...QR_COLORS} />
      </button>

      <div className={styles.url}>{url}</div>

      {candidates.length > 1 && (
        <select
          className={styles.picker}
          value={url}
          onChange={(e) => select(e.target.value)}
          aria-label="参加URLの候補"
        >
          {candidates.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )}

      {projecting && (
        <div
          className={styles.overlay}
          role="dialog"
          aria-label="参加用QRコード"
          onClick={() => setProjecting(false)}
        >
          <QRCodeSVG value={url} size={420} marginSize={2} {...QR_COLORS} />
          <div className={styles.overlayUrl}>{url}</div>
          <p className={styles.warning}>{CERT_WARNING_HINT}</p>
          <p className={styles.close}>クリックまたはEscで閉じる</p>
        </div>
      )}
    </div>
  );
}

/** QRだけは明地・暗モジュール。index.cssのトークンと同じ値を直に使う(SVG属性のため) */
const QR_COLORS = { bgColor: "#f7f1e4", fgColor: "#2e3131" } as const;

/**
 * mkcertのローカルCAは飛び入り参加者の端末に入っていないため、証明書の警告は必ず出る。
 * SharedArrayBufferにHTTPSが要る以上HTTPへは逃げられないので、通過手順を画面に出しておく。
 */
const CERT_WARNING_HINT =
  "証明書の警告が出たら「詳細設定」→「アクセスする」で進んでください(会場内のPCです)";
