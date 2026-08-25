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

export class Coordinator {
  private readonly state = roster.createState();
  private readonly sockets = new Map<string, Socket>();

  hello(clientId: string, role: Role, displayName: string, socket: Socket): void {
    // 先に socket を登録してから配信することで、hello を送った本人にも roster_update が届く。
    this.sockets.set(clientId, socket);
    this.run(roster.applyHello(this.state, clientId, role, displayName));
  }

  peerStatus(clientId: string, status: PeerStatus): void {
    this.run(roster.applyPeerStatus(this.state, clientId, status));
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

  private run(effects: roster.Effect[]): void {
    for (const e of effects) {
      const data = JSON.stringify(e.msg);
      if (e.kind === "broadcast") {
        for (const s of this.sockets.values()) s.send(data);
      } else {
        this.sockets.get(e.targetId)?.send(data);
      }
    }
  }
}
