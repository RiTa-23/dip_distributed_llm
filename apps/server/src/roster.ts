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
};

/** wiring 層が解釈する送出指示。broadcast=全員へ / unicast=targetId のみへ。 */
export type Effect =
  | { kind: "broadcast"; msg: ServerMessage }
  | { kind: "unicast"; targetId: string; msg: ServerMessage };

export function createState(): ClusterState {
  return { clients: new Map(), generation: 0, phase: "idle" };
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

  state.generation += 1;
  state.phase = "active";
  const msg: GenerationStartMessage = {
    type: "generation_start",
    generation: state.generation,
    peerIds: currentRoster(state).map((p) => p.clientId),
  };
  return [{ kind: "broadcast", msg }];
}

/** hello: クライアントを登録(再接続も含め常に connecting で入れ直す)。 */
export function applyHello(
  state: ClusterState,
  clientId: string,
  role: Role,
  displayName: string,
): Effect[] {
  state.clients.set(clientId, { role, displayName, status: "connecting" });
  return [{ kind: "broadcast", msg: rosterUpdate(state) }, ...maybeStartGeneration(state)];
}

/** peer_status: ステータス更新 → ロスター再配信 → 条件を満たせば世代開始。 */
export function applyPeerStatus(
  state: ClusterState,
  clientId: string,
  status: PeerStatus,
): Effect[] {
  const c = state.clients.get(clientId);
  if (!c) return []; // hello 前 / 未知クライアントは無視
  c.status = status;
  return [{ kind: "broadcast", msg: rosterUpdate(state) }, ...maybeStartGeneration(state)];
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
  if (!state.clients.delete(clientId)) return [];

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
