import { describe, expect, test } from "bun:test";
import { CELLS, countLit, createBoard, isCleared, isLit, SIZE, toggleAt } from "./lightsOut";

/** 点灯させたいマスの番号からビットマスクを作る。期待値を目で読める形で書くため */
function bits(...indexes: number[]): number {
  return indexes.reduce((mask, i) => mask | (1 << i), 0);
}

/** 決まった順にマスを返す乱数。`createBoard` の手順をテストで固定する */
function fixedRng(indexes: number[]): () => number {
  let cursor = 0;
  return () => {
    const index = indexes[cursor % indexes.length] ?? 0;
    cursor++;
    return index / CELLS;
  };
}

/**
 * 盤面が解けるかを判定する(chase the lights)。1行目の押し方を全32通り試し、
 * 2行目以降は「1つ上が点いていたら押す」で機械的に決まる。最後に全消灯になれば解ける。
 *
 * `createBoard` が本当に解ける盤面しか作らないかを、生成の手順に頼らず外から確かめるために置く。
 */
function solvable(board: number): boolean {
  for (let firstRow = 0; firstRow < 1 << SIZE; firstRow++) {
    let work = board;
    for (let col = 0; col < SIZE; col++) {
      if (firstRow & (1 << col)) work = toggleAt(work, col);
    }
    for (let row = 1; row < SIZE; row++) {
      for (let col = 0; col < SIZE; col++) {
        if (isLit(work, (row - 1) * SIZE + col)) work = toggleAt(work, row * SIZE + col);
      }
    }
    if (work === 0) return true;
  }
  return false;
}

describe("toggleAt", () => {
  test("中央は自分と上下左右の5マスを反転する", () => {
    // 12 は中央(2行3列)
    expect(toggleAt(0, 12)).toBe(bits(7, 11, 12, 13, 17));
    expect(countLit(toggleAt(0, 12))).toBe(5);
  });

  test("辺は4マス、角は3マス", () => {
    expect(countLit(toggleAt(0, 2))).toBe(4); // 上辺の真ん中
    expect(countLit(toggleAt(0, 0))).toBe(3); // 左上の角
    expect(countLit(toggleAt(0, CELLS - 1))).toBe(3); // 右下の角
  });

  test("盤の端で回り込まない", () => {
    // 4 は右上の角。左隣は3、下は9で、次の行の左端(5)には触れない
    expect(toggleAt(0, 4)).toBe(bits(3, 4, 9));
    expect(isLit(toggleAt(0, 4), 5)).toBe(false);

    // 5 は2行目の左端。左は無く、右(6)・上(0)・下(10)だけ
    expect(toggleAt(0, 5)).toBe(bits(0, 5, 6, 10));
    expect(isLit(toggleAt(0, 5), 4)).toBe(false);
  });

  test("同じマスを2回押すと元に戻る(対合)", () => {
    const board = bits(0, 6, 13, 24);
    for (let i = 0; i < CELLS; i++) {
      expect(toggleAt(toggleAt(board, i), i)).toBe(board);
    }
  });

  test("押す順番を入れ替えても結果は同じ", () => {
    const board = bits(2, 9, 18);
    for (let i = 0; i < CELLS; i++) {
      for (let j = 0; j < CELLS; j++) {
        expect(toggleAt(toggleAt(board, i), j)).toBe(toggleAt(toggleAt(board, j), i));
      }
    }
  });

  test("25ビットからはみ出さない", () => {
    let board = 0;
    for (let i = 0; i < CELLS; i++) board = toggleAt(board, i);
    expect(board).toBeGreaterThanOrEqual(0);
    expect(board).toBeLessThanOrEqual((1 << CELLS) - 1);
  });
});

describe("isCleared / countLit", () => {
  test("全消灯だけがクリア", () => {
    expect(isCleared(0)).toBe(true);
    expect(isCleared(bits(24))).toBe(false);
  });

  test("countLit は点灯数を数える", () => {
    expect(countLit(0)).toBe(0);
    expect(countLit(bits(0, 24))).toBe(2);
    expect(countLit((1 << CELLS) - 1)).toBe(CELLS);
  });
});

describe("createBoard", () => {
  test("生成に使った手順をもう一度なぞると全消灯になる(= 必ず解ける)", () => {
    const scramble = [1, 7, 13, 20, 4, 16];
    const board = createBoard(fixedRng(scramble), scramble.length);
    expect(board).not.toBe(0);

    const solved = scramble.reduce((acc, index) => toggleAt(acc, index), board);
    expect(isCleared(solved)).toBe(true);
  });

  test("最初から消えている盤面は返さない", () => {
    // 同じマスを2回押す手順は必ず全消灯になる。引き直しが効いていれば0は返らない
    expect(createBoard(fixedRng([3]), 2)).not.toBe(0);
  });

  test("既定の乱数でも、解ける盤面しか出ない", () => {
    for (let trial = 0; trial < 300; trial++) {
      const board = createBoard();
      expect(board).not.toBe(0);
      expect(board).toBeLessThanOrEqual((1 << CELLS) - 1);
      expect(solvable(board)).toBe(true);
    }
  });

  test("解けない盤面を solvable が見抜ける(判定そのものの確かめ)", () => {
    // 5×5のライツアウトで解けるのは全2^25通りのうち1/4だけ。
    // 左上1マスだけが点いた盤面はその外にあり、どう押しても消せない
    expect(solvable(bits(0))).toBe(false);
  });
});

describe("盤の形", () => {
  test("SIZE と CELLS が食い違わない", () => {
    expect(CELLS).toBe(SIZE * SIZE);
  });
});
