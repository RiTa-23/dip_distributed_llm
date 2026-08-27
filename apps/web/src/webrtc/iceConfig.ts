// ICEの設定と、成立した経路の読み取り。
//
// **会場LAN内のTURNを許可する**(AGENTS.md 前提2 / 前提6)。物理2PCの実測で、
// host candidate による direct path が成立しないLANがあることが分かったため
// (ICE: checking → disconnected、DTLS: new のまま)。原因は未確定で、ここが直すのは
// 「direct が張れなかったときに relay で迂回できる」ことだけ。
//
// **手書きのfallback state machineは作らない。** direct → timeout → 張り直し → TURN、
// のような制御を持つと、ICE自身が持っている候補選択と二重になって遅くなるだけ。
// `iceTransportPolicy: "all"` を既定にして、host / relay の組み合わせはICEに選ばせる。
//
// Reactにも `import.meta.env` にも依存しない。envの読み取りは `config.ts` の役目で、
// ここは受け取った文字列を解釈するだけ。そのぶんbun testからそのまま検証できる。

/** `config.ts` が集めた生env。未設定は undefined か空文字 */
export type IceEnv = {
  /** VITE_TURN_URLS。カンマ区切り */
  urls?: string;
  /** VITE_TURN_USERNAME */
  username?: string;
  /** VITE_TURN_CREDENTIAL */
  credential?: string;
  /** VITE_FORCE_RELAY。検証用。`"1"` のときだけ relay を強制する */
  forceRelay?: string;
};

/** 設定が中途半端なときに投げる。**silent disable はしない** */
export class IceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IceConfigError";
  }
}

/** 実際に選ばれたICEの経路。**この経路情報には** IP も credential も含めない(種別とプロトコルだけ) */
export type IceRoute = {
  localType: string;
  remoteType: string;
  protocol: string;
  /** relayのとき、TURNサーバとの間で使っているプロトコル */
  relayProtocol?: string;
};

const trimmed = (value: string | undefined): string =>
  typeof value === "string" ? value.trim() : "";

/** カンマ区切り → trim → 空要素の除去 */
function splitUrls(raw: string | undefined): string[] {
  return trimmed(raw)
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

/**
 * `turn:` / `turns:` 以外を弾く。`stun:` を混ぜても relay candidate は増えないし、
 * 素のホスト名は RTCPeerConnection のコンストラクタが例外にする。
 * URLはcredentialではないので、どれが悪いかはメッセージに出してよい。
 */
function assertTurnUrl(url: string): void {
  if (!url.startsWith("turn:") && !url.startsWith("turns:")) {
    throw new IceConfigError(`TURNのURLは turn: か turns: で始まる必要があります: ${url}`);
  }
}

/**
 * envからRTCConfigurationを組む。
 *
 * - TURN3項目とも未設定 … `iceServers: []`(従来どおりのLAN direct only)
 * - 3項目とも揃っている … TURNを1つ登録する
 * - **一部だけ設定 … `IceConfigError`**
 *
 * 中途半端な設定を黙ってTURN無効へ倒さないのが要点。倒すと「TURNを設定したつもりで
 * 効いていない」状態のまま実機検証してしまい、結果を誤読する。
 *
 * **既定のpolicyは必ず `"all"`。** `"relay"` は `VITE_FORCE_RELAY=1` の検証時だけで、
 * production で relay を強制するとdirectで足りる環境まで中継を通ることになる。
 */
export function buildIceConfig(env: IceEnv): RTCConfiguration {
  const urls = splitUrls(env.urls);
  const username = trimmed(env.username);
  const credential = trimmed(env.credential);
  const forceRelay = trimmed(env.forceRelay) === "1";

  const missing: string[] = [];
  if (urls.length === 0) missing.push("VITE_TURN_URLS");
  if (username.length === 0) missing.push("VITE_TURN_USERNAME");
  if (credential.length === 0) missing.push("VITE_TURN_CREDENTIAL");

  if (missing.length === 3) {
    if (forceRelay) {
      throw new IceConfigError(
        "VITE_FORCE_RELAY=1 ですが TURN が設定されていません。" +
          "relayを強制しても中継先が無いため、接続は必ず失敗します。" +
          "VITE_TURN_URLS / VITE_TURN_USERNAME / VITE_TURN_CREDENTIAL を設定するか、" +
          "VITE_FORCE_RELAY を外してください。",
      );
    }
    return { iceServers: [], iceTransportPolicy: "all" };
  }

  if (missing.length > 0) {
    // **値は出さない。** 揃っていない項目の名前だけを伝える
    throw new IceConfigError(
      `TURNの設定が揃っていません。未設定: ${missing.join(", ")}。` +
        "3つとも設定するか、3つとも空にしてTURNを無効にしてください。",
    );
  }

  for (const url of urls) assertTurnUrl(url);

  return {
    iceServers: [{ urls, username, credential }],
    iceTransportPolicy: forceRelay ? "relay" : "all",
  };
}

/**
 * 起動時のログ用。**credentialもusernameも含めない。**
 * どのTURNへ、どのpolicyで繋ごうとしているかだけが分かればよい。
 */
export function describeIceConfig(config: RTCConfiguration): string {
  const policy = config.iceTransportPolicy ?? "all";
  const urls = (config.iceServers ?? []).flatMap((server) =>
    Array.isArray(server.urls) ? server.urls : [server.urls],
  );
  if (urls.length === 0) return `TURNなし policy=${policy}`;
  return `TURN ${urls.length}件 (${urls.join(", ")}) policy=${policy}`;
}

type StatsEntry = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * 実際に選ばれたcandidate pairを探す。ブラウザによって印の付け方が違うので3段で見る。
 *   1. `transport.selectedCandidatePairId`(仕様どおり)
 *   2. `candidate-pair.selected`(Chrome)
 *   3. `nominated` かつ `succeeded`
 */
function findSelectedPair(byId: Map<string, StatsEntry>): StatsEntry | null {
  for (const entry of byId.values()) {
    if (entry.type !== "transport") continue;
    const pair = byId.get(str(entry.selectedCandidatePairId));
    if (pair && pair.type === "candidate-pair") return pair;
  }
  for (const entry of byId.values()) {
    if (entry.type === "candidate-pair" && entry.selected === true) return entry;
  }
  for (const entry of byId.values()) {
    if (
      entry.type === "candidate-pair" &&
      entry.nominated === true &&
      entry.state === "succeeded"
    ) {
      return entry;
    }
  }
  return null;
}

/**
 * `getStats()` の結果から、成立した経路を読む。読めなければ null。
 *
 * `RTCStatsReport` は `Map` と同じ形で回せるので、引数は `[id, stats]` のiterableで受ける
 * (偽のMapを渡してそのままテストできる)。
 *
 * **片側だけ relay の組み合わせ(mixed)も正常。** ICEは両端に同じ種類を要求しないので、
 * relay/host や host/relay をここで弾かない。
 */
export function selectIceRoute(stats: Iterable<[string, unknown]>): IceRoute | null {
  const byId = new Map<string, StatsEntry>();
  for (const [id, value] of stats) {
    if (typeof value === "object" && value !== null) byId.set(id, value as StatsEntry);
  }

  const pair = findSelectedPair(byId);
  if (!pair) return null;

  const local = byId.get(str(pair.localCandidateId));
  const remote = byId.get(str(pair.remoteCandidateId));
  const localType = str(local?.candidateType);
  const remoteType = str(remote?.candidateType);
  // 候補そのものが取れないことがある(閉じかけ・実装差)。読めない経路は報告しない
  if (localType.length === 0 || remoteType.length === 0) return null;

  const protocol = str(local?.protocol) || str(remote?.protocol) || "unknown";
  const relayProtocol = str(local?.relayProtocol) || str(remote?.relayProtocol);

  return relayProtocol.length > 0
    ? { localType, remoteType, protocol, relayProtocol }
    : { localType, remoteType, protocol };
}
