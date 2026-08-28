/**
 * ライツアウト(5×5)の盤面。参加者画面の待ち時間に置くパズルの中身(#106)。
 *
 * 盤面は **25ビットのビットマスク(number 1個)** で持つ。`boolean[25]` にしない理由は3つ。
 *   - 1手が `^`(XOR)1回で済み、途中の配列を作らない
 *   - クリア判定が `board === 0` になる
 *   - 状態そのものが数値なので、Reactのstateに置いても比較が値の比較で済む
 *
 * ここに置くのは純関数だけで、Reactにも `window` にも依存しない。**タイマーは1つも持たない**。
 * 参加者のタブは裏で数GBのGGUFを受け取り、`active` ではRPCも走っている。`requestAnimationFrame`
 * や `setInterval` でメインスレッドを触りに行くと、そのぶんがRPCの応答遅延として出る。
 * このパズルは「押されたときだけ計算する」形にしてあり、待ち時間の裏で回り続けるものがない。
 */

/** 1辺のマス数。5×5以外は想定していない(`createBoard` の解ける保証は辺の長さに依らないが、見た目の実装が5前提) */
export const SIZE = 5;

/** マスの総数。ビットマスクの幅でもある */
export const CELLS = SIZE * SIZE;

/** 初期盤面を作るときに掛ける手数。少なすぎると一目で解け、多すぎると待ち時間に終わらない */
export const DEFAULT_SCRAMBLE = 6;

/**
 * `createBoard` が全消灯(= 最初から解けている)を引いたときのやり直しの上限。
 * 乱数が偏り続けても止まらないように、回数で切る。
 */
const MAX_ATTEMPTS = 8;

/** マスの位置。index は `行 * SIZE + 列` で、0〜CELLS-1 の範囲だけを渡すこと */
export function isLit(board: number, index: number): boolean {
  return (board & (1 << index)) !== 0;
}

/**
 * 1手。押したマスと、その上下左右を反転する。
 *
 * 盤の端では回り込まない(左端の左は右端ではない)。ここを回り込ませると別のパズルになり、
 * 「全消灯から逆順に戻せる」という `createBoard` の前提だけは残るので、間違えても気づきにくい。
 */
export function toggleAt(board: number, index: number): number {
  const row = Math.floor(index / SIZE);
  const col = index % SIZE;
  let next = board ^ (1 << index);
  if (row > 0) next ^= 1 << (index - SIZE);
  if (row < SIZE - 1) next ^= 1 << (index + SIZE);
  if (col > 0) next ^= 1 << (index - 1);
  if (col < SIZE - 1) next ^= 1 << (index + 1);
  return next;
}

/** 全部消えていればクリア */
export function isCleared(board: number): boolean {
  return board === 0;
}

/** 点いているマスの数。表示用 */
export function countLit(board: number): number {
  let count = 0;
  for (let bits = board; bits !== 0; bits >>>= 1) count += bits & 1;
  return count;
}

/**
 * 初期盤面を作る。
 *
 * **全消灯の状態からランダムに `moves` 回 `toggleAt` を適用する**。`toggleAt` は同じマスに
 * 2回掛けると元へ戻る(対合)ので、こうして作った盤面は同じマスをもう一度押せば必ず消える。
 * つまり**解けない盤面が出ない**。ランダムに点灯させる作り方だと解けない盤面が混ざる
 * (5×5のライツアウトでは全体の1/4しか解けない)ため、そちらは採らない。
 *
 * `rng` を引数にとるのはテストで手順を固定するため。既定は `Math.random`。
 */
export function createBoard(rng: () => number = Math.random, moves = DEFAULT_SCRAMBLE): number {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let board = 0;
    for (let i = 0; i < moves; i++) {
      board = toggleAt(board, Math.floor(rng() * CELLS) % CELLS);
    }
    // 偶数回の重なりで最初から消えていることがある。それは問題として成立しないので引き直す
    if (board !== 0) return board;
  }
  // 乱数が偏り続けた場合の逃げ道。中央を1回押した形は必ず遊べる
  return toggleAt(0, (CELLS - 1) / 2);
}
