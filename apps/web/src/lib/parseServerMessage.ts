import type {
  GenerationAbortedMessage,
  GenerationStartMessage,
  PeerInfo,
  PeerStatus,
  RosterUpdateMessage,
  ServerMessage,
  SignalKind,
  WebrtcSignalMessage,
} from "@dip_distributed_llm/shared-types/messages";

const PEER_STATUSES = ["connecting", "ready", "error"] as const satisfies readonly PeerStatus[];
const SIGNAL_KINDS = ["offer", "answer", "ice-candidate"] as const satisfies readonly SignalKind[];
const ABORT_REASONS = [
  "peer_disconnected",
  "peer_joined",
] as const satisfies readonly GenerationAbortedMessage["reason"][];

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isMember<T extends string>(list: readonly T[], v: unknown): v is T {
  return isString(v) && (list as readonly string[]).includes(v);
}

function toPeerInfo(v: unknown): PeerInfo | null {
  if (!isObject(v)) return null;
  if (!isString(v.clientId) || !isString(v.displayName)) return null;
  if (!isMember(PEER_STATUSES, v.status)) return null;
  return { clientId: v.clientId, displayName: v.displayName, status: v.status };
}

function toRosterUpdate(v: JsonObject): RosterUpdateMessage | null {
  if (!Array.isArray(v.peers)) return null;
  const peers: PeerInfo[] = [];
  for (const raw of v.peers) {
    const peer = toPeerInfo(raw);
    // 1人でも壊れていたらロスター全体を捨てる。欠けたまま表示すると、
    // 層バーに担当者のいない区間ができて原因が追えなくなる
    if (!peer) return null;
    peers.push(peer);
  }
  return { type: "roster_update", peers };
}

function toGenerationStart(v: JsonObject): GenerationStartMessage | null {
  if (!isNumber(v.generation)) return null;
  if (!Array.isArray(v.peerIds) || !v.peerIds.every(isString)) return null;
  return { type: "generation_start", generation: v.generation, peerIds: v.peerIds };
}

function toGenerationAborted(v: JsonObject): GenerationAbortedMessage | null {
  if (!isNumber(v.generation)) return null;
  if (!isMember(ABORT_REASONS, v.reason) || !isString(v.message)) return null;
  return {
    type: "generation_aborted",
    generation: v.generation,
    reason: v.reason,
    message: v.message,
  };
}

function toWebrtcSignal(v: JsonObject): WebrtcSignalMessage | null {
  if (!isString(v.targetId) || !isString(v.fromId)) return null;
  if (!isObject(v.payload) || !isMember(SIGNAL_KINDS, v.payload.kind)) return null;
  const { kind, sdp, candidate } = v.payload;
  if (sdp !== undefined && !isString(sdp)) return null;
  // candidate の中身はブラウザが作った値をそのまま運ぶ契約なので検証しない
  return {
    type: "webrtc_signal",
    targetId: v.targetId,
    fromId: v.fromId,
    payload: { kind, ...(sdp === undefined ? {} : { sdp }), candidate },
  };
}

/**
 * `/ws` から届いた1フレームを ServerMessage に直す。契約に合わなければ null。
 *
 * 捨てる側に倒しているのは、onmessage の中で例外を投げるとその接続で以降の
 * メッセージを1件も受け取れなくなるため。JSONの壊れ・未知の `type`・
 * フィールド不足のいずれも、画面を落とさず無視する。
 *
 * 型定義は共有しているが、送ってくるのは別プロセス(Hono)である。
 * 型が保証するのはコンパイル時だけで、実際に届く値は検証しないと分からない。
 */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  // 契約はJSONテキストのみ。Blob/ArrayBufferで来たら制御プレーンの想定外
  if (!isString(raw)) return null;

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(json) || !isString(json.type)) return null;

  switch (json.type) {
    case "roster_update":
      return toRosterUpdate(json);
    case "generation_start":
      return toGenerationStart(json);
    case "generation_aborted":
      return toGenerationAborted(json);
    case "webrtc_signal":
      return toWebrtcSignal(json);
    default:
      // 契約に無い種別。②が先行して新しいメッセージを足した場合もここに来る
      return null;
  }
}
