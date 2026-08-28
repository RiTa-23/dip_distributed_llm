import { CELLS, isLit, SIZE } from "../lib/lightsOut";
import styles from "./LightsOut.module.css";

type Props = {
  /** 25ビットの盤面 */
  board: number;
  moves: number;
  cleared: boolean;
  onPress: (index: number) => void;
  onReset: () => void;
};

/** マスの並び。描画のたびに作らないようモジュールの外に出しておく */
const CELL_INDEXES = Array.from({ length: CELLS }, (_, i) => i);

/**
 * 待ち時間に遊ぶライツアウトの盤面(#106)。**状態は持たない**(`useLightsOut` が持つ)。
 *
 * ゲームループを持たないのが要点。押されたときだけ再描画するので、GGUFの受信や
 * RPCが走っている裏でメインスレッドを取り合わない。canvasを使わないのも同じ理由で、
 * DOMなら見た目の変化はCSSのtransition(コンポジタ側)が受け持つ。
 *
 * キーイベントを `window` に張らない。素の `<button>` なのでTabとEnterでは操作できるが、
 * 「離脱する」など画面の既存の操作を奪わないため、ショートカットの類は持たせない。
 */
export function LightsOut({ board, moves, cleared, onPress, onReset }: Props) {
  return (
    <section className={styles.game} aria-label="待ち時間のパズル">
      <div className={styles.head}>
        <span>ライツアウト</span>
        <span>{moves}手</span>
      </div>

      <div className={styles.board}>
        {CELL_INDEXES.map((index) => {
          const lit = isLit(board, index);
          return (
            <button
              key={index}
              type="button"
              className={`${styles.cell} ${lit ? styles.lit : ""}`}
              aria-pressed={lit}
              aria-label={`${Math.floor(index / SIZE) + 1}行${(index % SIZE) + 1}列`}
              onClick={() => onPress(index)}
            />
          );
        })}
      </div>

      {cleared ? (
        <p className={styles.cleared} role="status">
          {moves}手でクリア
        </p>
      ) : (
        <p className={styles.hint}>押したマスと上下左右が反転します。全部消すとクリア</p>
      )}

      <button type="button" className={styles.reset} onClick={onReset}>
        {cleared ? "もう一問" : "作り直す"}
      </button>
    </section>
  );
}
