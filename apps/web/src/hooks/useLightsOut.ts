import { useCallback, useState } from "react";
import { createBoard, isCleared, toggleAt } from "../lib/lightsOut";

export type LightsOutGame = {
  /** 25ビットの盤面。1が点灯 */
  board: number;
  /** ここまでに押した回数 */
  moves: number;
  cleared: boolean;
  press: (index: number) => void;
  /** 新しい問題を出す */
  reset: () => void;
};

/**
 * 待ち時間のパズルの状態(#106)。ロジックは `lib/lightsOut.ts` にあり、ここは持ち回るだけ。
 *
 * **これを呼ぶのは `PeerView`** で、盤面を描く `LightsOut` の中ではない。
 * 盤面が出るのは `connecting` と `active` の2つだが、そのあいだに `reorganizing` を
 * 挟むことがある(メンバーが変わるたびに `active → reorganizing → connecting → active`)。
 * 状態を `LightsOut` の中に置くと、その往復のたびにアンマウントされて**遊びかけの盤面が
 * 消える**。フェーズの外側に置いておけば、参加しているあいだは1問が続く。
 *
 * `PeerView` に状態が1つ増えると1手ごとに再描画されるが、`usePeerStats` が参加中は
 * 250msごとに再描画を起こしているので、実質的な増分はない。
 */
export function useLightsOut(): LightsOutGame {
  // 初期化は関数で渡す。そうしないと描画のたびに盤面を作ってしまう
  const [game, setGame] = useState(() => ({ board: createBoard(), moves: 0 }));

  const press = useCallback((index: number) => {
    setGame((prev) => {
      // クリア後の押下は手数に数えない。同じオブジェクトを返せばReactは再描画しない
      if (isCleared(prev.board)) return prev;
      return { board: toggleAt(prev.board, index), moves: prev.moves + 1 };
    });
  }, []);

  const reset = useCallback(() => {
    setGame({ board: createBoard(), moves: 0 });
  }, []);

  return { board: game.board, moves: game.moves, cleared: isCleared(game.board), press, reset };
}
