// `requester_accepting` を「変わったときだけ1回」送るための edge 検出。
//
// 生成中は新規peerの加入による再編成を保留させる(#34 / #50)。その開始・終了の契機は
// 1つではない:
//   - 送信ボタン(generating: false → true)
//   - `generate()` の解決 / 失敗
//   - 世代交代の描画中リセット
//   - **現行世代の失敗による drain**(この経路が無いと `accepting: false` を送ったきりになる)
//
// どの経路から来ても送信の判断を1か所に閉じるために、状態の比較だけをここへ切り出す。
// 送信そのものは呼び出し側が持つ(Reactに依存させない)。

export type AcceptingSignal = {
  /**
   * `generating` が前回から変わっていれば送るべき `accepting`(= !generating)を返す。
   * 変わっていなければ null。
   */
  next: (generating: boolean) => boolean | null;
};

/**
 * ⚠️ **実体は component の寿命に1つ。** 描画のたびに作ると `previous` が毎回初期値へ
 * 戻り、edge 検出として機能しなくなる(常に変化ありと判定して毎描画送ってしまう)。
 * React からは `const [signal] = useState(() => createAcceptingSignal())` の形で固定する。
 */
export function createAcceptingSignal(initialGenerating = false): AcceptingSignal {
  let previous = initialGenerating;
  return {
    next: (generating) => {
      if (previous === generating) return null;
      previous = generating;
      return !generating;
    },
  };
}
