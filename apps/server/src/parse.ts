import type {
  ClientMessage,
  PeerStatus,
  Role,
  SignalKind,
} from "@dip_distributed_llm/shared-types/messages";

// 受信 JSON の構造検証。JSON.parse の結果は unknown として扱い、
// 既知の型・必須フィールドを満たすものだけを ClientMessage として通す。
// 不正・不足があれば null を返す(呼び出し側は破棄する)。
// これがないと null や不完全なメッセージが switch(msg.type) に流れて例外・ゴミ登録の原因になる。

const ROLES: readonly Role[] = ["peer", "requester"];
const STATUSES: readonly PeerStatus[] = ["connecting", "ready", "error"];
const SIGNAL_KINDS: readonly SignalKind[] = ["offer", "answer", "ice-candidate"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!isObject(raw)) return null;

  switch (raw.type) {
    case "hello": {
      const { clientId, displayName, role } = raw;
      if (typeof clientId !== "string" || typeof displayName !== "string") return null;
      if (typeof role !== "string" || !ROLES.includes(role as Role)) return null;
      return { type: "hello", role: role as Role, clientId, displayName };
    }
    case "peer_status": {
      const { status, errorMessage } = raw;
      if (typeof status !== "string" || !STATUSES.includes(status as PeerStatus)) return null;
      return {
        type: "peer_status",
        status: status as PeerStatus,
        ...(typeof errorMessage === "string" ? { errorMessage } : {}),
      };
    }
    case "webrtc_signal": {
      const { targetId, fromId, payload } = raw;
      if (typeof targetId !== "string" || typeof fromId !== "string") return null;
      if (!isObject(payload)) return null;
      const { kind, sdp, candidate } = payload;
      if (typeof kind !== "string" || !SIGNAL_KINDS.includes(kind as SignalKind)) return null;
      return {
        type: "webrtc_signal",
        targetId,
        fromId,
        payload: {
          kind: kind as SignalKind,
          ...(typeof sdp === "string" ? { sdp } : {}),
          ...("candidate" in payload ? { candidate } : {}),
        },
      };
    }
    default:
      return null;
  }
}
