import { useCallback, useEffect, useState } from "react";
import { JOIN_INFO_PATH, JOIN_INFO_URL_OVERRIDE } from "../config";

export type JoinUrl = {
  /** QRに入れる参加URL。取得前・取得失敗時は今開いているオリジン */
  url: string;
  /** サーバが返した候補。1件以下なら画面に選択肢を出さない */
  candidates: string[];
  /** 候補の中から選び直す(発表者PCに仮想NICが複数あるとき用) */
  select: (url: string) => void;
};

/** `/join-info` の応答。サーバの `buildJoinUrls()` が作る */
type JoinInfo = { joinUrls: string[] };

function isJoinInfo(v: unknown): v is JoinInfo {
  if (typeof v !== "object" || v === null) return false;
  const urls = (v as { joinUrls?: unknown }).joinUrls;
  return Array.isArray(urls) && urls.every((u) => typeof u === "string");
}

/**
 * 参加者に配るURLをHonoから受け取る。
 *
 * `window.location.origin` をそのまま使えないのは、発表者が localhost で開いている場合に
 * QRの中身が参加者の端末から見て自分自身を指してしまうため。会場のLAN IPはブラウザからは
 * 分からないので、NICを列挙できるサーバ側に決めさせる(`/join-info`)。
 *
 * viteのdevサーバ単体で開いているときは `/join-info` が無い(index.htmlが返る)。
 * その場合はJSONの解釈に失敗するので、今開いているオリジンへ黙って落とす。
 */
export function useJoinUrl(): JoinUrl {
  const [candidates, setCandidates] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(JOIN_INFO_URL_OVERRIDE || JOIN_INFO_PATH, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: unknown) => {
        if (!isJoinInfo(body) || body.joinUrls.length === 0) return;
        setCandidates(body.joinUrls);
        setChosen((prev) => prev ?? body.joinUrls[0]);
      })
      .catch(() => {
        // 取得できなくても画面は成立する(同一オリジンのURLを出す)ので握りつぶす
      });
    return () => controller.abort();
  }, []);

  const select = useCallback((url: string) => setChosen(url), []);

  return {
    url: chosen ?? `${window.location.origin}/`,
    candidates,
    select,
  };
}
