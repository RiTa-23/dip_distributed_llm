import type {
  PeerStatus,
  Role,
  WebrtcSignalMessage,
} from "@dip_distributed_llm/shared-types/messages";
import * as roster from "./roster";

// wiring 層。ドメインロジック(roster.ts)と実際の送信を繋ぐ。
// WebSocket そのものではなく最小の Socket インターフェースに依存させることで、
// Hono/Bun の ws を張らずに bun test から検証できる。

export interface Socket {
  send(data: string): void;
}

/** `/status` が返す形(#58)。読み取り専用のスナップショット。 */
export type StatusSnapshot = {
  phase: roster.GenerationPhase;
  generation: number;
  acceptingGrowth: boolean;
  requesterConnected: boolean;
  peers: { clientId: string; displayName: string; status: string }[];
  activeGenerationPeerIds: string[] | null;
  stats: roster.ClusterStats;
};

/** 配信したメッセージを受け取る口(#58)。既定は何もしない。 */
export type EventLogger = (line: string) => void;

export class Coordinator {
  private readonly state = roster.createState();
  private readonly sockets = new Map<string, Socket>();
  private readonly log: EventLogger;

  /**
   * `log` を渡すと状態が動いたときに1行流す(#58)。
   * 既定を無音にしてあるのは、テストの出力を汚さないため。
   * サーバ本体(index.ts)からは console.log を渡す。
   */
  constructor(log: EventLogger = () => {}) {
    this.log = log;
  }

  /**
   * 今の状態を読み出す(#58)。デモ中に「何人つながっていて、どの世代で、誰が ready か」を
   * サーバ側から確認する手段が console.log の1行しか無かったため。
   * 状態は変更しない。
   */
  status(): StatusSnapshot {
    let requesterConnected = false;
    for (const c of this.state.clients.values()) {
      if (c.role === "requester") requesterConnected = true;
    }
    return {
      phase: this.state.phase,
      generation: this.state.generation,
      acceptingGrowth: this.state.acceptingGrowth,
      requesterConnected,
      peers: roster.currentRoster(this.state),
      activeGenerationPeerIds: this.state.activeGenerationPeerIds,
      stats: { ...this.state.stats },
    };
  }

  /**
   * hello を受け付けたら true、拒否したら false を返す。
   * 拒否した接続は socket を保持しない(以後のシグナリング中継にも使われない)。
   */
  hello(clientId: string, role: Role, displayName: string, socket: Socket): boolean {
    // 同時1リクエスト固定(AGENTS.md 前提5): 別clientIdのrequesterが既にいれば拒否する。
    if (role === "requester" && roster.hasOtherRequester(this.state, clientId)) {
      return false;
    }
    // 同一clientIdの張り替え(リロード等)。旧登録を切断扱いにして、生成中なら再編成を走らせてから入れ直す。
    const existing = this.sockets.get(clientId);
    if (existing && existing !== socket) {
      this.run(roster.applyDisconnect(this.state, clientId));
    }
    // 先に socket を登録してから配信することで、hello を送った本人にも roster_update が届く。
    this.sockets.set(clientId, socket);
    this.run(roster.applyHello(this.state, clientId, role, displayName));
    return true;
  }

  peerStatus(clientId: string, status: PeerStatus): void {
    this.run(roster.applyPeerStatus(this.state, clientId, status));
  }

  requesterAccepting(clientId: string, accepting: boolean): void {
    this.run(roster.applyRequesterAccepting(this.state, clientId, accepting));
  }

  signal(msg: WebrtcSignalMessage): void {
    this.run(roster.applySignal(this.state, msg));
  }

  disconnect(clientId: string, socket: Socket): void {
    // identity ガード: 保存中の socket がこの socket と同一のときだけ削除する。
    // clientId は localStorage で永続化されるため、リロード再接続時に
    // 旧接続の onClose が新接続のエントリを消す race を防ぐ(#18)。
    if (this.sockets.get(clientId) !== socket) return;
    this.sockets.delete(clientId);
    this.run(roster.applyDisconnect(this.state, clientId));
  }

  /**
   * 状態が動いたときだけ1行流す(#58)。
   * roster_update は人が増減するたびに飛んで量が多いので、人数だけに畳む。
   * webrtc_signal は転送のたびに出ると埋もれるので出さない。
   */
  private logEffect(e: roster.Effect): void {
    if (e.kind !== "broadcast") return;
    const m = e.msg;
    const at = new Date().toISOString();
    switch (m.type) {
      case "roster_update":
        this.log(`[${at}] roster peers=${m.peers.length} phase=${this.state.phase}`);
        break;
      case "generation_start":
        this.log(`[${at}] generation_start gen=${m.generation} peers=${m.peerIds.join(",")}`);
        break;
      case "generation_aborted":
        this.log(`[${at}] generation_aborted gen=${m.generation} reason=${m.reason}`);
        break;
      default:
        break;
    }
  }

  private run(effects: roster.Effect[]): void {
    for (const e of effects) {
      const data = JSON.stringify(e.msg);
      this.logEffect(e);
      if (e.kind === "broadcast") {
        for (const s of this.sockets.values()) s.send(data);
      } else {
        this.sockets.get(e.targetId)?.send(data);
      }
    }
  }
}
