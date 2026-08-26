// GGUF を配るためだけの静的配信。汎用の static server ではない。
//
// `hono/bun` の `serveStatic` は `/models/*` に対して
//
//   HEAD → 200 だが `content-length: 0`
//   GET  → 200 だが `Transfer-Encoding: chunked`(Content-Length 無し・Accept-Ranges 無し)
//   Range → 206 にならず全body を流す
//
// を返す(#B-1 で実測)。Runtime adapter はモデルURLに対してまず HEAD を投げ、
// `Content-Length` からファイルサイズを決めるので、`0` が返るとその時点で失敗する。
// さらに Range が無いと、起動のたびに GGUF 全体を IndexedDB へ先読みすることになる。
//
// ここが受け持つのは `/models/<name>` の1階層だけ。ディレクトリを掘らせないので、
// パスの正規化は「1セグメントであること」を確かめるだけで足りる。

const DEFAULT_PREFIX = "/models/";

/**
 * `/models/<name>` の `<name>` を取り出す。**掘らせない。**
 *
 * `..` や区切り文字を弾くのではなく、**1セグメントで、区切り文字を含まないこと**を
 * 通す条件にしている。弾く側を数えると、エンコードや別表記の抜けを見落とす。
 */
export function modelNameFromPath(
  pathname: string,
  prefix: string = DEFAULT_PREFIX,
): string | null {
  if (!pathname.startsWith(prefix)) return null;

  let name: string;
  try {
    name = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null; // 壊れたパーセントエンコード
  }

  if (name.length === 0) return null;
  if (name.includes("/") || name.includes("\\")) return null;
  if (name.includes("\0")) return null;
  // "." ".." と、隠しファイル。1セグメントに絞ってもここは別に弾く
  if (name.startsWith(".")) return null;
  return name;
}

export type ParsedRange =
  | { kind: "none" }
  /** 解釈できないものは「Range なし」と同じ扱い。断るより無視するほうが害が小さい */
  | { kind: "ignore" }
  | { kind: "unsatisfiable" }
  | { kind: "range"; start: number; end: number };

/**
 * `Range: bytes=...` を1本だけ解釈する。`end` は**含む**(HTTPの流儀)。
 *
 * 複数レンジ(カンマ区切り)は無視して全体を返す。仕様上サーバは無視してよく、
 * llmlet の adapter も単一レンジしか投げない。
 */
export function parseRange(header: string | null, size: number): ParsedRange {
  if (!header) return { kind: "none" };
  if (!header.startsWith("bytes=")) return { kind: "ignore" };

  const spec = header.slice("bytes=".length).trim();
  if (spec.includes(",")) return { kind: "ignore" };

  const [firstRaw, sepFound, lastRaw] = partition(spec, "-");
  if (!sepFound) return { kind: "ignore" };

  const first = firstRaw.trim();
  const last = lastRaw.trim();

  if (first.length === 0) {
    // 末尾から N バイト
    const suffix = Number(last);
    if (!Number.isInteger(suffix) || suffix <= 0) return { kind: "ignore" };
    if (size === 0) return { kind: "unsatisfiable" };
    const start = Math.max(0, size - suffix);
    return { kind: "range", start, end: size - 1 };
  }

  const start = Number(first);
  if (!Number.isInteger(start) || start < 0) return { kind: "ignore" };
  if (start >= size) return { kind: "unsatisfiable" };

  if (last.length === 0) return { kind: "range", start, end: size - 1 };

  const end = Number(last);
  if (!Number.isInteger(end) || end < start) return { kind: "ignore" };
  return { kind: "range", start, end: Math.min(end, size - 1) };
}

function partition(value: string, sep: string): [string, boolean, string] {
  const at = value.indexOf(sep);
  if (at < 0) return [value, false, ""];
  return [value.slice(0, at), true, value.slice(at + sep.length)];
}

export type ModelFile = {
  size: number;
  /** `[start, end]`(endは含む)を返す。全体なら引数なし */
  slice: (start?: number, endExclusive?: number) => Blob;
};

export type ModelFileLookup = (name: string) => Promise<ModelFile | null>;

/** 既定の探し方。`Bun.file` は遅延読みなので、491MB をメモリへ展開しない */
export function bunModelLookup(rootDir: string): ModelFileLookup {
  return async (name) => {
    const file = Bun.file(`${rootDir}/${name}`);
    if (!(await file.exists())) return null;
    return {
      size: file.size,
      slice: (start, endExclusive) =>
        start === undefined ? file : file.slice(start, endExclusive),
    };
  };
}

/**
 * `/models/<name>` を返す。担当外なら `null`(呼び出し側が404などへ落とす)。
 *
 * body は `BunFile` / `BunFile.slice()` をそのまま `Response` に渡す。Bunがstreamで
 * 流すので、大きなGGUFでもサーバのメモリには乗らない。
 */
export async function handleModelRequest(
  req: Request,
  lookup: ModelFileLookup,
  /**
   * 呼び出し側のポリシーヘッダ。**Responseを作るときに一緒に載せる。**
   * 返したあとにミドルウェアで足すと、Honoが組み直して body の範囲が失われる。
   */
  extraHeaders: Record<string, string> = {},
  prefix: string = DEFAULT_PREFIX,
): Promise<Response | null> {
  if (req.method !== "GET" && req.method !== "HEAD") return null;

  const name = modelNameFromPath(new URL(req.url).pathname, prefix);
  if (!name) return null;

  const file = await lookup(name);
  if (!file) return null;

  const size = file.size;
  const base = {
    ...extraHeaders,
    "Content-Type": "application/octet-stream",
    // これが無いと adapter がサイズを決められない
    "Accept-Ranges": "bytes",
  };

  const parsed = parseRange(req.headers.get("range"), size);

  if (parsed.kind === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...base, "Content-Range": `bytes */${String(size)}`, "Content-Length": "0" },
    });
  }

  if (parsed.kind === "range") {
    const length = parsed.end - parsed.start + 1;
    const headers = {
      ...base,
      "Content-Range": `bytes ${String(parsed.start)}-${String(parsed.end)}/${String(size)}`,
      "Content-Length": String(length),
    };
    // HEADでも 206 とヘッダは同じにして、bodyだけ落とす
    const body = req.method === "HEAD" ? null : file.slice(parsed.start, parsed.end + 1);
    return new Response(body, { status: 206, headers });
  }

  const headers = { ...base, "Content-Length": String(size) };
  const body = req.method === "HEAD" ? null : file.slice();
  return new Response(body, { status: 200, headers });
}
