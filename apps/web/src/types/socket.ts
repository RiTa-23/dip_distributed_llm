import type { ClientMessage, ServerMessage } from "@dip_distributed_llm/shared-types/messages";

/**
 * 開発用パネルから呼ぶ操作。モックだけが持つ。
 * 本物の接続では null になり、DevPanelのROSTER側のボタンが消える。
 */
export type SocketDebug = {
  addPeer: (displayName: string) => void;
  removeLastPeer: () => void;
  startGeneration: () => void;
};

/**
 * 制御プレーン(Honoの /ws)への接続。
 * モックと本物はこの形をそろえてあり、useCluster から見ると区別がつかない。
 */
export type HonoSocket = {
  connected: boolean;
  lastMessage: ServerMessage | null;
  send: (msg: ClientMessage) => void;
  debug: SocketDebug | null;
};

export type SocketOptions = {
  /** false のあいだは接続しない。参加者は「参加する」を押すまで false */
  enabled: boolean;
};
