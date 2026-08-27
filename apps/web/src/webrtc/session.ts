import type { WebrtcSignalMessage } from "@dip_distributed_llm/shared-types/messages";
import { TURN_ENV } from "../config";
import { buildIceConfig, describeIceConfig, selectIceRoute } from "./iceConfig";
import type { IceRoute } from "./iceConfig";

// requester⇔peer のWebRTC接続を組み立てる部分の共通部品。
// Reactに依存させていないのは、世代の判定とcandidateの順番待ちを
// RTCPeerConnectionなしで(bun testから直接)検証できるようにするため。

/** `/ws` への送信。フックが useHonoSocket の send をそのまま渡す */
export type SignalSender = (msg: WebrtcSignalMessage) => void;

/** RTCPeerConnectionの生成。テストで偽物に差し替えるために外から渡せるようにしている */
export type PeerConnectionFactory = () => RTCPeerConnection;

/** コンストラクタ本体。配線のテストで偽物を挿すために型として開けてある */
export type PeerConnectionCtor = new (config?: RTCConfiguration) => RTCPeerConnection;

/**
 * 組み上がった `RTCConfiguration` を実際にコンストラクタへ渡す部分。
 *
 * envの読み取り(`config.ts`)と設定の解釈(`iceConfig.ts`)から**配線だけを切り離す**。
 * bun testではenvが空なので、実物の `defaultPeerConnectionFactory` を見ても
 * 「TURNの設定がコンストラクタまで届くか」は確かめられない。ここを関数にしておくと、
 * TURN入りのconfigと偽コンストラクタを渡して**配線そのもの**を固定できる。
 */
export function createPeerConnectionFactory(
  config: RTCConfiguration,
  Ctor?: PeerConnectionCtor,
): PeerConnectionFactory {
  // 既定のコンストラクタは**呼ばれたときに**引く。既定引数で受けると、この
  // モジュールを読み込んだ時点で `RTCPeerConnection` を触ることになり、
  // WebRTCの無いbun testでは読み込みそのものが落ちる
  return () => new (Ctor ?? RTCPeerConnection)(config);
}

/**
 * 既定の生成器。
 *
 * TURNが未設定なら `iceServers: []` で、これまでどおり会場LAN内のdirectだけを使う。
 * 設定されていれば**会場LAN内のTURN**を足す。外部のSTUN/TURNサービスは使わない
 * (AGENTS.md 前提6)。directを優先するかrelayへ回すかはICEに選ばせる(前提2)。
 *
 * **設定が中途半端ならこのモジュールの評価時に落ちる。** `VITE_*` はビルド時に
 * 埋め込まれるので、設定ミスはデプロイ不良であって実行時の障害ではない。黙って
 * TURN無効へ倒すと「効いているつもりで効いていない」まま実機検証してしまう。
 */
const ICE_CONFIG: RTCConfiguration = buildIceConfig(TURN_ENV);

export const defaultPeerConnectionFactory: PeerConnectionFactory =
  createPeerConnectionFactory(ICE_CONFIG);

/**
 * `connected` 直後はまだ selected pair が stats に現れていないことがある。読めるまでの間合い。
 * 即時1回 + ここに並べた遅延で最大3回 = 合計4回まで読みにいく。
 */
const ROUTE_RETRY_MS: readonly number[] = [100, 300, 1000];

/**
 * 経路の診断を付ける。**参加者の操作は増やさない** — 開発者がコンソールで追えるだけ。
 * 後始末の関数を返すので、接続を畳むときに呼ぶこと。
 *
 * `addEventListener` を使うのは、両セッションが既に持っている `onicecandidate` /
 * `onconnectionstatechange` のプロパティハンドラを奪わないため。
 *
 * **不変条件**: 古い run は `await` の後に共有状態(`running` / `timer` / `reported`)を
 * **一切書かない**。`clearTimeout` は既に飛んでいる `getStats()` を止められないので、
 * 「timerを消したから安全」は成り立たない。書き込みはすべて `isMine()` の後ろに置く。
 * これが崩れると、**畳んだはずのPeerConnectionの経路が次の世代の最中にログへ出る**。
 * このログを実験のPASS証拠に使うので、そこが濁ると証拠にならない。
 */
export function attachIceDiagnostics(
  pc: RTCPeerConnection,
  // テストから短い値を挿せるようにしておく(unitを遅くしない)
  retryDelaysMs: readonly number[] = ROUTE_RETRY_MS,
): () => void {
  // 偽のPeerConnectionを挿しているテストでは何もしない
  if (typeof pc.addEventListener !== "function") return () => {};

  const onCandidateError = (event: Event) => {
    const e = event as RTCPeerConnectionIceErrorEvent;
    // **credentialは出さない。** URL(会場LANのIPを含む)は、どのTURNがどう断ったかを
    // 追うのに要るので出す
    console.warn("[webrtc] ICE server error", {
      url: e.url,
      errorCode: e.errorCode,
      errorText: e.errorText,
    });
  };

  let disposed = false;
  let reported = false;
  let running = false;
  let runId = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** この run がまだ現行か。**共有状態へ書く前に必ず通す** */
  const isMine = (mine: number) => !disposed && mine === runId;

  /** 走っているrunを失効させる。connectedを離れたときと後始末で使う */
  const cancelRun = () => {
    runId += 1;
    running = false;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const attempt = async (index: number, mine: number): Promise<void> => {
    if (!isMine(mine)) return;
    if (reported || pc.connectionState !== "connected") {
      running = false;
      return;
    }

    let route: IceRoute | null = null;
    try {
      route = selectIceRoute(await pc.getStats());
    } catch {
      // 畳んでいる最中は普通に失敗する。「今回は読めなかった」として同じretryに乗せる
    }

    // **awaitをまたいだ。** ここから先の書き込みは自分のrunのものだけ
    if (!isMine(mine)) return;
    if (pc.connectionState !== "connected") {
      running = false;
      return;
    }

    if (route) {
      reported = true;
      running = false;
      console.info("[webrtc] selected ICE route", route);
      return;
    }

    if (index >= retryDelaysMs.length) {
      running = false;
      // 黙らない。ただし言えるのは「retryのあいだconnectedを保ったのに読めなかった」まで。
      // teardown / disconnect で中断した場合はここへ来ない(infoもwarnも出ない)
      console.warn("[webrtc] ICE route unavailable", { attempts: index + 1 });
      return;
    }

    timer = setTimeout(() => {
      // 古いrunが timer を null にすると、新しいrunが張ったtimerを消してしまう
      if (!isMine(mine)) return;
      timer = null;
      void attempt(index + 1, mine);
    }, retryDelaysMs[index] ?? 0);
  };

  const onStateChange = () => {
    if (pc.connectionState !== "connected") {
      // connectedを離れた。走っているrunを失効させる。戻ってくれば新しいrunを始める
      cancelRun();
      return;
    }
    if (disposed || reported || running) return;
    // 直列。前の getStats() が未解決のうちは次を始めない
    running = true;
    void attempt(0, ++runId);
  };

  pc.addEventListener("icecandidateerror", onCandidateError);
  pc.addEventListener("connectionstatechange", onStateChange);

  return () => {
    disposed = true;
    cancelRun();
    pc.removeEventListener("icecandidateerror", onCandidateError);
    pc.removeEventListener("connectionstatechange", onStateChange);
  };
}

/** 起動時に1回、どのICE設定で繋ごうとしているかを残す。credentialは含まない */
console.info(`[webrtc] ICE: ${describeIceConfig(ICE_CONFIG)}`);

/**
 * セッションから上がってくる通知。第1引数はどれも「接続を張り始めた世代」で、
 * 受け取る側が現行の世代と突き合わせて古いものを捨てられるようにしてある。
 */
export type SessionCallbacks = {
  /** DataChannelが開いた。①の startWasmClient / startWasmPeerServer へ渡す口 */
  onOpen: (generation: number, remoteId: string, channel: RTCDataChannel) => void;
  /** DataChannel上でデータが届いた。PeerManager の handleMessage へ渡す口 */
  onData: (generation: number, remoteId: string, data: unknown) => void;
  /**
   * DataChannelが閉じた。PeerManager の detach / retire へ渡す口。
   * 載っている論理接続を畳ませないと、待たせているrecvが起きないままになる。
   * teardown() は受け口を外してから閉じるので、こちらは飛ばない。
   *
   * requester はここを**世代の致命傷の入口**としても使う。RPC deviceは起動時の
   * `-rpc` 引数で固定されるので、close以外の失敗(connectionState failed、SDP/ICEの
   * 失敗)も同じ道を通り、`onFailed` の直前に1回だけ上がる(`requesterSession.ts`)。
   * peer は long-lived なので従来どおり相手ごとのclose通知のまま。
   */
  onClose: (generation: number, remoteId: string) => void;
  /**
   * 接続が張れなかった、または落ちた。
   * **requester では1セッションにつき最大1回**で、必ず `onClose` の後に来る
   * (畳んで世代を失効させてから画面と制御プレーンへ伝えるため)。
   */
  onFailed: (generation: number, remoteId: string, message: string) => void;
  /** 開通数などが変わった。画面の進捗表示を更新させるためだけに呼ぶ */
  onChange: () => void;
};

export type SessionOptions = {
  /** このセッションが属する世代。作った後は変わらない */
  generation: number;
  myId: string;
  send: SignalSender;
  callbacks: SessionCallbacks;
  createConnection?: PeerConnectionFactory;
};

/**
 * 1世代ぶんの接続のまとまり。
 * requester は全peerとの複数本、peer は requester との1本を持つが、外からは同じ形に見える。
 */
export type WebrtcSession = {
  readonly generation: number;
  /** requester: この顔ぶれへofferを出す。peer: 何もしない(offerが来るのを待つ) */
  start: (peerIds: string[]) => void;
  /** `/ws` から届いた自分宛の webrtc_signal を渡す */
  accept: (msg: WebrtcSignalMessage) => void;
  /** 今つながっている相手 */
  openIds: () => string[];
  /** つながるはずの相手。peer は offer が来るまで空 */
  expectedIds: () => string[];
  /** 全接続を閉じる。世代が変わるたびに呼ぶ */
  teardown: () => void;
};

/**
 * `generation_aborted` を反映するかどうか。
 * 古い世代の中断通知が遅れて届くことがあり、捨てないと始まったばかりの編成を巻き込む。
 * clusterReducer 側の同じ判定と揃えてある。
 */
export function isStaleAbort(msgGeneration: number, current: number): boolean {
  return msgGeneration < current;
}

/**
 * 世代の違う通知を捨てるかどうか。DataChannelの開通時とデータ受信時の2か所で使う。
 * 中断が挟まると現行の世代は前後どちらにも動きうるので、大小ではなく一致で見る。
 */
export function isStaleForCurrent(generation: number, current: number): boolean {
  return generation !== current;
}

/**
 * remoteDescriptionが入るまでICE candidateを溜めておく箱。
 *
 * offerより先にcandidateが届くことはないが、setRemoteDescriptionは非同期なので、
 * その解決を待たずに addIceCandidate を呼ぶと InvalidStateError で落ちる。
 */
export type CandidateQueue = {
  /** まだremoteDescriptionが入っていなければ溜める。入っていればそのまま流す */
  push: (candidate: RTCIceCandidateInit) => void;
  /** remoteDescriptionが入った。溜めた分を届いた順に流す */
  open: () => void;
  /** 溜まっている数。テスト用 */
  size: () => number;
};

export function createCandidateQueue(
  apply: (candidate: RTCIceCandidateInit) => void,
): CandidateQueue {
  let ready = false;
  const pending: RTCIceCandidateInit[] = [];
  return {
    push: (candidate) => {
      if (ready) {
        apply(candidate);
        return;
      }
      pending.push(candidate);
    },
    open: () => {
      ready = true;
      while (pending.length > 0) {
        const next = pending.shift();
        if (next) apply(next);
      }
    },
    size: () => pending.length,
  };
}

/**
 * `payload.candidate` を RTCIceCandidateInit に直す。契約上ここは `unknown` で、
 * ブラウザが作った値をHonoが解釈せず運んでくるだけなので、受け側で最低限だけ確かめる。
 * 終端を表す空文字のcandidateも通す。
 */
export function toCandidateInit(value: unknown): RTCIceCandidateInit | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.candidate !== "string") return null;
  return v as RTCIceCandidateInit;
}

/** 例外を画面に出せる文字列にする */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ChannelHandlers = {
  onOpen: () => void;
  onClose: () => void;
  onData: (data: unknown) => void;
};

/** DataChannelに受け口を付ける。binaryTypeはRPCのバイナリをそのまま扱うため arraybuffer */
export function bindChannel(channel: RTCDataChannel, handlers: ChannelHandlers): void {
  channel.binaryType = "arraybuffer";
  channel.onopen = () => handlers.onOpen();
  channel.onclose = () => handlers.onClose();
  channel.onmessage = (e: MessageEvent) => handlers.onData(e.data);
}

/**
 * 受け口を外す。close()の後にもイベントは飛ぶので、閉じる前に必ず外す。
 * useHonoSocket が ws.onclose を外してから close しているのと同じ理由。
 */
export function unbindChannel(channel: RTCDataChannel): void {
  channel.onopen = null;
  channel.onclose = null;
  channel.onmessage = null;
  channel.onerror = null;
}

export function unbindConnection(pc: RTCPeerConnection): void {
  pc.onicecandidate = null;
  pc.ondatachannel = null;
  pc.onconnectionstatechange = null;
}
