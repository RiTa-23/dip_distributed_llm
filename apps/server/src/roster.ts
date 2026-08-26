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
export type ClientRecord = { role: Role; displayName: string; status: PeerStatus };

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

/** peer が1人以上いて、その全員が ready か。 */
function allPeersReady(state: ClusterState): boolean {
  let peerCount = 0;
  for (const c of state.clients.values()) {
    if (c.role !== "peer") continue;
    if (c.status !== "ready") return false;
    peerCount += 1;
  }
  return peerCount > 0;
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
 * idle かつ「全peer ready」かつ「requester 接続中」のときだけ次の世代を開始する。
 * active 中は発火しない(AGENTS.md 前提4: 増減は次の世代開始タイミングでのみ反映)。
 * requester 不在での開始を防ぐ(orchestrator が居ない生成を作らない)。
 */
function maybeStartGeneration(state: ClusterState): Effect[] {
  if (state.phase !== "idle") return [];
  if (!allPeersReady(state)) return [];
  if (!hasRequester(state)) return [];

  const peerIds = currentRoster(state).map((p) => p.clientId);
  state.generation += 1;
  state.phase = "active";
  state.activeGenerationPeerIds = peerIds;
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
  state.clients.set(clientId, { role, displayName, status: "connecting" });
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

/** webrtc_signal: 中身を解釈せず targetId 宛に転送するだけ。宛先不明なら破棄。 */
export function applySignal(state: ClusterState, msg: WebrtcSignalMessage): Effect[] {
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
