import type {
  GenerationAbortedMessage,
  GenerationStartMessage,
  PeerInfo,
  PeerStatus,
  Role,
  RosterUpdateMessage,
  ServerMessage,
  WebrtcSignalMessage,
} from "@dip_distributed_llm/shared-types/messages";

// ロスター/世代管理のドメインロジック(ws非依存の純粋ロジック)。
// 副作用を持たず「状態を更新して、送出すべきメッセージ(Effect)を返す」形にすることで、
// WebSocket を張らずに bun test から直接検証できる(#20 / #22)。

/** 1クライアントの状態。ws 接続そのものは wiring 層(coordinator.ts)が別に保持する。 */
export type ClientRecord = {
  role: Role;
  displayName: string;
  status: PeerStatus;
  /**
   * 直近の世代開始より**後に**、やり直しの契機(`error` への遷移 / 入り直し)を通ったか。
   * 失敗した編成を組み直してよいかの判定に使う(#56 の補修)。
   *
   * 「失敗を記録した時点」ではなく「世代開始時点」を基準にするのが要点。
   * `generation_failed`(requesterのWS)と `peer_status: error`(peerのWS)は別の接続から
   * 来るため到着順が保証されない。基準を世代開始に置けば、どちらが先に届いても
   * 同じ結論になる。
   */
  resetSinceStart: boolean;
};

/** 世代の状態機械。生成中(active)は増減を反映せず、idle のときだけ次の世代を開始する。 */
export type GenerationPhase = "idle" | "active";

export type ClusterState = {
  clients: Map<string, ClientRecord>;
  generation: number;
  phase: GenerationPhase;
  /** 直近開始した世代に含まれるpeerIdの一覧。新規加入の判定(未加入かどうか)に使う。 */
  activeGenerationPeerIds: string[] | null;
  /**
   * 生成中に新規peerが ready になったとき、Honoが能動的に再編成してよいか。
   * requester が `requester_accepting` で操作する。既定 true(未操作なら従来通り即再編成)。
   */
  acceptingGrowth: boolean;
  /**
   * 直前に編成へ失敗した顔ぶれ(#56)。同じ組み合わせでの即時リトライを避けるために持つ。
   * 世代が始まったら null に戻す。
   *
   * 同じ顔ぶれでも、そのうち誰かがやり直しの契機を通っていれば組み直す。
   * その判定は `ClientRecord.resetSinceStart` を見る。
   */
  failedPeerIds: string[] | null;
  /** 起動してからの累計・最大値(#60)。プロセスが落ちればリセットされてよい。 */
  stats: ClusterStats;
  /**
   * これまでに見た peer の clientId(#60)。累計人数を数えるために持つ。
   * 同じ人がリロードしても clientId は localStorage で保たれるので二重に数えない。
   */
  seenPeerIds: Set<string>;
};

/**
 * デモの締めに出す数字(#60)。永続化はしない(AGENTS.md 前提6の範囲で完結させる)。
 * ロスターの現在値ではなく「これまで」を持つのがここの役目。
 */
export type ClusterStats = {
  /** これまでに hello を送ってきた peer のユニーク数 */
  totalPeers: number;
  /** 同時に接続していた peer の最大数 */
  peakPeers: number;
};

/** wiring 層が解釈する送出指示。broadcast=全員へ / unicast=targetId のみへ。 */
export type Effect =
  | { kind: "broadcast"; msg: ServerMessage }
  | { kind: "unicast"; targetId: string; msg: ServerMessage };

export function createState(): ClusterState {
  return {
    clients: new Map(),
    generation: 0,
    phase: "idle",
    activeGenerationPeerIds: null,
    acceptingGrowth: true,
    failedPeerIds: null,
    stats: { totalPeers: 0, peakPeers: 0 },
    seenPeerIds: new Set(),
  };
}

/** ロスターは peer のみを含める(requester は載せない)。 */
export function currentRoster(state: ClusterState): PeerInfo[] {
  const peers: PeerInfo[] = [];
  for (const [clientId, c] of state.clients) {
    if (c.role === "peer") {
      peers.push({ clientId, displayName: c.displayName, status: c.status });
    }
  }
  return peers;
}

function rosterUpdate(state: ClusterState): RosterUpdateMessage {
  return { type: "roster_update", peers: currentRoster(state) };
}

/** 統計を更新する(#60)。ロスターが動いたときに呼ぶ。 */
function trackPeer(state: ClusterState, clientId: string): void {
  if (!state.seenPeerIds.has(clientId)) {
    state.seenPeerIds.add(clientId);
    state.stats.totalPeers += 1;
  }
  const now = currentRoster(state).length;
  if (now > state.stats.peakPeers) state.stats.peakPeers = now;
}

/**
 * 次の世代に入れる peer の一覧。組めないときは null。
 *
 * `error` の peer は「今回は参加しない」として数から外す(#57)。以前は全員が ready で
 * なければ組めなかったため、1台でも error になると次の世代が永久に始まらず、
 * フロントは error を送るに送れずにいた(docs/frontend.md「まだ無いもの」)。
 * `connecting` はまだ準備中なので、これまで通り待つ。
 */
function eligiblePeerIds(state: ClusterState): string[] | null {
  const ready: string[] = [];
  for (const [clientId, c] of state.clients) {
    if (c.role !== "peer") continue;
    if (c.status === "connecting") return null; // 準備中の人がいる。待つ
    if (c.status === "ready") ready.push(clientId);
    // error は編成に入れない。復帰して ready を送り直せば次の再編成で入る
  }
  return ready.length > 0 ? ready : null;
}

/** 2つのpeerId一覧が同じ顔ぶれか(順序は問わない)。 */
function sameMembers(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** 推論をオーケストレートする requester が接続しているか。 */
function hasRequester(state: ClusterState): boolean {
  for (const c of state.clients.values()) {
    if (c.role === "requester") return true;
  }
  return false;
}

/**
 * clientId とは別の requester が既に接続しているか。
 * 同時1リクエスト固定(AGENTS.md 前提5)の判定に使う。同一clientId(リロード)は別物扱いしない。
 */
export function hasOtherRequester(state: ClusterState, clientId: string): boolean {
  for (const [id, c] of state.clients) {
    if (c.role === "requester" && id !== clientId) return true;
  }
  return false;
}

/**
 * idle かつ「組める peer がいる」かつ「requester 接続中」のときだけ次の世代を開始する。
 * active 中は発火しない(AGENTS.md 前提4: 増減は次の世代開始タイミングでのみ反映)。
 * requester 不在での開始を防ぐ(orchestrator が居ない生成を作らない)。
 *
 * 直前に同じ顔ぶれで編成に失敗している場合は開始しない(#56)。同じ組み合わせをすぐ
 * 組み直すと、失敗し続けるあいだ generation_start が延々と出てしまう。
 *
 * ただし**顔ぶれが同じでも、誰かがやり直しの契機を通っていれば組み直す**。これが無いと、
 * peer が1台だけの部屋では一度失敗すると永久に組み直せない(error → ready も入り直しも、
 * 結局は同じ顔ぶれに戻るため)。
 */
function maybeStartGeneration(state: ClusterState): Effect[] {
  if (state.phase !== "idle") return [];
  if (!hasRequester(state)) return [];

  const peerIds = eligiblePeerIds(state);
  if (peerIds === null) return [];
  if (state.failedPeerIds !== null && sameMembers(state.failedPeerIds, peerIds)) {
    // 同じ顔ぶれ。誰もやり直していなければ待つ
    const retried = peerIds.some((id) => state.clients.get(id)?.resetSinceStart === true);
    if (!retried) return [];
  }

  state.failedPeerIds = null;
  state.generation += 1;
  state.phase = "active";
  state.activeGenerationPeerIds = peerIds;
  // この世代を新しい基準にする。以降の `error` / 入り直しだけを「やり直し」と数える
  for (const id of peerIds) {
    const member = state.clients.get(id);
    if (member) member.resetSinceStart = false;
  }
  const msg: GenerationStartMessage = {
    type: "generation_start",
    generation: state.generation,
    peerIds,
  };
  return [{ kind: "broadcast", msg }];
}

/** 稼働中の世代に含まれていない、ready な peer が存在するか(=生成中に加入した新規peer)。 */
function hasUnjoinedReadyPeer(state: ClusterState): boolean {
  const joined = new Set(state.activeGenerationPeerIds ?? []);
  for (const [clientId, c] of state.clients) {
    if (c.role === "peer" && c.status === "ready" && !joined.has(clientId)) return true;
  }
  return false;
}

/**
 * 生成中(active)に新規peerが加入してreadyになった場合の再編成。
 * acceptingGrowthがfalseの間は保留し、trueに戻った時点でまとめて取り込む(#34)。
 * disconnect起因の中断とは異なり、こちらはrequesterの明示的な許可がある時だけ発火する。
 */
function maybeReformForGrowth(state: ClusterState): Effect[] {
  if (state.phase !== "active") return [];
  if (!state.acceptingGrowth) return [];
  if (!hasUnjoinedReadyPeer(state)) return [];

  const aborted: GenerationAbortedMessage = {
    type: "generation_aborted",
    generation: state.generation,
    reason: "peer_joined",
    message: "新しい参加者が増えたため再編成します",
  };
  state.phase = "idle";
  return [{ kind: "broadcast", msg: aborted }, ...maybeStartGeneration(state)];
}

/** hello: クライアントを登録(再接続も含め常に connecting で入れ直す)。 */
export function applyHello(
  state: ClusterState,
  clientId: string,
  role: Role,
  displayName: string,
): Effect[] {
  // 入り直しはそれ自体がやり直し。`connecting` から始まるので、ここで即座に
  // 同じ編成を組み直すことにはならない(`eligiblePeerIds` が準備中を待つ)。
  state.clients.set(clientId, { role, displayName, status: "connecting", resetSinceStart: true });
  if (role === "peer") trackPeer(state, clientId);
  // requesterの(再)接続でacceptingGrowthをtrueにリセットする。操作者不在のまま
  // falseに固定されて新規peerが永久に取り込まれなくなるのを防ぐ(#34)。
  if (role === "requester") state.acceptingGrowth = true;
  return [{ kind: "broadcast", msg: rosterUpdate(state) }, ...maybeStartGeneration(state)];
}

/**
 * peer_status: ステータス更新 → ロスター再配信 → 条件を満たせば世代開始/再編成。
 * idle中はmaybeStartGeneration、active中はmaybeReformForGrowthがそれぞれ担当し、
 * どちらも自身の対象外フェーズでは即座に空配列を返すため無条件に両方呼んでよい。
 */
export function applyPeerStatus(
  state: ClusterState,
  clientId: string,
  status: PeerStatus,
): Effect[] {
  const c = state.clients.get(clientId);
  if (!c) return []; // hello 前 / 未知クライアントは無視
  c.status = status;
  // `error` は「この編成では無理だった」という本人の申告。やり直しとして数える。
  // `ready` の再送だけでは数えない — 同じ状態のまま generation_start を繰り返さないのが
  // #56 の目的で、そこは保つ。同じ `error` が何度来ても結果は変わらない(冪等)。
  if (status === "error") c.resetSinceStart = true;
  return [
    { kind: "broadcast", msg: rosterUpdate(state) },
    ...maybeStartGeneration(state),
    ...maybeReformForGrowth(state),
  ];
}

/**
 * requester_accepting: 生成中に新規peerを取り込んでよいかをrequesterが操作する。
 * 送信者がrole==='requester'であることを検証し、それ以外は無視する(#34)。
 */
export function applyRequesterAccepting(
  state: ClusterState,
  clientId: string,
  accepting: boolean,
): Effect[] {
  const c = state.clients.get(clientId);
  if (!c || c.role !== "requester") return []; // requester以外からの送信は無視
  state.acceptingGrowth = accepting;
  return accepting ? maybeReformForGrowth(state) : [];
}

/**
 * generation_failed: requester が「この編成では繋がらなかった」と伝えてきたときの処理(#56)。
 *
 * 以前は active から idle へ戻る道が切断しかなく、requester が1人でも接続に失敗すると
 * 誰かが切れるまで固まっていた。ここで idle に戻し、他の参加者にも中断を知らせる。
 *
 * 送信者が requester であること、世代番号が現在のものと一致することを確かめる。
 * 古い世代の遅れた通知で、始まったばかりの編成を巻き込まないため。
 */
export function applyGenerationFailed(
  state: ClusterState,
  clientId: string,
  generation: number,
): Effect[] {
  const c = state.clients.get(clientId);
  if (!c || c.role !== "requester") return []; // requester以外からの送信は無視
  if (state.phase !== "active") return [];
  if (generation !== state.generation) return []; // 古い世代の通知

  // 同じ顔ぶれをすぐ組み直さないよう、失敗した編成を覚えておく
  state.failedPeerIds = state.activeGenerationPeerIds;

  const aborted: GenerationAbortedMessage = {
    type: "generation_aborted",
    generation: state.generation,
    reason: "connection_failed",
    message: "接続できなかったため編成をやり直します",
  };
  state.phase = "idle";
  return [{ kind: "broadcast", msg: aborted }, ...maybeStartGeneration(state)];
}

/**
 * model_changed: requesterがモデルを差し替えたので、**同じ顔ぶれのまま**組み直す。
 *
 * requester Runtimeは世代の開始時にモデルを掴んで離さない
 * (`hooks/useRequesterRuntime.ts` が generation をキーに起動する)ため、
 * 新しい世代を始めない限り差し替えが効かない。
 *
 * **`applyGenerationFailed` と決定的に違うのは `failedPeerIds` を触らないこと。**
 * あちらは「その顔ぶれでは失敗した」を記録して同じ編成を避けるが、こちらは
 * 同じ顔ぶれで組み直すのが目的なので、記録するとその場で編成が止まる。
 *
 * 推論中(active)でも受け付ける。走っている生成は中断されるが、それは
 * 「今すぐ別のモデルを見せたい」という操作の当然の結果で、requesterの意思。
 */
export function applyModelChanged(
  state: ClusterState,
  clientId: string,
  generation: number,
): Effect[] {
  const c = state.clients.get(clientId);
  if (!c || c.role !== "requester") return []; // requester以外からの送信は無視
  if (state.phase !== "active") return [];
  if (generation !== state.generation) return []; // 古い世代の通知

  const aborted: GenerationAbortedMessage = {
    type: "generation_aborted",
    generation: state.generation,
    reason: "model_changed",
    message: "モデルが変わったため編成をやり直します",
  };
  state.phase = "idle";
  return [{ kind: "broadcast", msg: aborted }, ...maybeStartGeneration(state)];
}

/**
 * webrtc_signal: 中身を解釈せず targetId 宛に転送するだけ。宛先不明なら破棄。
 *
 * `fromId` が送信者本人かを検証する(#54)。ここを見ないと、任意のクライアントが
 * 他人を騙ったSDP/ICEを送れてしまい、受け取った側の接続を壊せる。
 * 飛び入り参加を想定する以上、悪意がなくてもフロントの不具合1つで起きうる。
 */
export function applySignal(
  state: ClusterState,
  senderId: string,
  msg: WebrtcSignalMessage,
): Effect[] {
  if (msg.fromId !== senderId) return []; // なりすまし
  if (!state.clients.has(msg.targetId)) return [];
  return [{ kind: "unicast", targetId: msg.targetId, msg }];
}

/**
 * 切断: ロスターから削除 → 再配信 → active だった場合のみ中断通知(現世代番号を載せる)して idle へ。
 * その後、残ったメンバーで条件を満たせば次の世代を開始する。
 */
export function applyDisconnect(state: ClusterState, clientId: string): Effect[] {
  const wasRequester = state.clients.get(clientId)?.role === "requester";
  if (!state.clients.delete(clientId)) return [];
  // requesterの切断でacceptingGrowthをtrueにリセットする(理由はapplyHelloと同じ、#34)。
  if (wasRequester) state.acceptingGrowth = true;

  const effects: Effect[] = [{ kind: "broadcast", msg: rosterUpdate(state) }];

  if (state.phase === "active") {
    const aborted: GenerationAbortedMessage = {
      type: "generation_aborted",
      generation: state.generation, // 中断した「現」世代番号(フロントの遅延通知フィルタが依存)
      reason: "peer_disconnected",
      message: "メンバーが変わったため再編成します",
    };
    effects.push({ kind: "broadcast", msg: aborted });
    state.phase = "idle";
  }

  effects.push(...maybeStartGeneration(state));
  return effects;
}
