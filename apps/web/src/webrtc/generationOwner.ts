// 「今どの世代が持ち主か」を1か所で持ち、古い世代からの作用を落とすための箱。
//
// `session.ts` の `isStaleForCurrent()` と考え方は同じだが、あちらは呼ぶたびに現行世代を
// 引数で渡す形なので、**呼ぶ側が現行世代を知っている**ことが前提になる。Runtime の
// コールバックはそうではない。起動時に配ったクロージャが、世代が変わったずっと後に
// 呼ばれてくる。そこで「配った時点のトークン」を持たせ、後から失効させる形にする。
//
// なぜ要るか: requester の Runtime は世代ごとに作り直すが、`stop()` が本当に止まった
// 証明にはならない(Runtime側の契約。①のrepoはCLOSED)。止まった証明が取れない以上、
// **止まっていない前提で、古い世代の作用を受け取らない**しかない。
//
// Reactに依存しない。持ち主は1つだけ置くこと(二重に持つと「現行世代」の見え方がズレる)。

export type GenerationToken = {
  /** このトークンが配られた世代 */
  generation: number;
  /** まだ現行世代か。失効していれば false */
  isCurrent: () => boolean;
  /**
   * 現行世代のときだけ通す包み。Runtime へ渡すコールバックはこれで包む。
   * 失効後の呼び出しは**黙って捨てる**(呼び出し元は古いRuntimeで、伝える相手がいない)。
   */
  guard: <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => void;
};

export type GenerationOwner = {
  /** 最後に claim した世代。まだ無ければ 0 */
  current: () => number;
  /** 新しい世代へ移る。**それまでのトークンはすべて失効する** */
  claim: (generation: number) => GenerationToken;
  /** 誰も持ち主でなくなる(離脱・unmount)。以降どのトークンも通らない */
  release: () => void;
};

export function createGenerationOwner(): GenerationOwner {
  // 世代番号ではなく**発行ごとの実体**で比べる。中断を挟むと同じ世代番号が
  // 二度 claim されうるので、番号一致だと前のトークンが生き残ってしまう
  let active: object | null = null;
  let currentGeneration = 0;

  return {
    current: () => currentGeneration,

    claim: (generation) => {
      const mine = {};
      active = mine;
      currentGeneration = generation;

      const isCurrent = () => active === mine;
      return {
        generation,
        isCurrent,
        guard:
          <A extends unknown[]>(fn: (...args: A) => void) =>
          (...args: A) => {
            if (!isCurrent()) return;
            fn(...args);
          },
      };
    },

    release: () => {
      active = null;
      currentGeneration = 0;
    },
  };
}
