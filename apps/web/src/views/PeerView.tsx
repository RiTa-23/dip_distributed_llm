import { useCallback, useEffect, useRef, useState } from "react";
import { TopBar } from "../components/TopBar";
import { StatusBlock } from "../components/StatusBlock";
import { LayerBar } from "../components/LayerBar";
import { ProgressBar } from "../components/ProgressBar";
import { Metric, MetricGrid } from "../components/Metric";
import { DevPanel } from "../components/DevPanel";
import { useCluster } from "../hooks/useCluster";
import { useWebrtcSignaling } from "../hooks/useWebrtcSignaling";
import type { WebrtcStatus } from "../hooks/useWebrtcSignaling";
import { usePeerManager } from "../hooks/usePeerManager";
import { usePeerStats } from "../hooks/usePeerStats";
import { useStalled } from "../hooks/useStalled";
import { useWasmEngine } from "../hooks/useWasmEngine";
import { getClientId } from "../lib/clientId";
import { describeMemory, describeWebgpu } from "../lib/environment";
import { useEnvironment } from "../hooks/useEnvironment";
import { formatBytes, formatCount, formatDuration, NO_VALUE } from "../lib/format";
import { DEFAULT_DISPLAY_NAME, REORGANIZING_STALL_MS } from "../config";
import type { AbortReason, Phase } from "../types/cluster";
import styles from "./PeerView.module.css";

/**
 * 接続の進み具合。実測できるのは「相手が決まった」「開いた」の2段だけなので、
 * 途中の値を作らずこの3つに丸める。受信したバイト数自体は数えているが
 * (`webrtc/peerStats.ts`)、総量が分からないので進捗率にはできない。
 */
const CONNECT_PROGRESS: Record<WebrtcStatus, number> = {
  idle: 0.08,
  connecting: 0.5,
  open: 1,
  failed: 0,
};

const TITLES: Record<Phase, string> = {
  idle: "計算に参加する",
  preparing: "準備しています",
  waiting: "待機中",
  connecting: "受け取っています",
  active: "貢献中",
  reorganizing: "再編成中",
  error: "エラー",
};

const HINTS: Record<Phase, string> = {
  idle: "このPCの空き時間を計算に貸します",
  preparing: "エンジンを起動しています",
  waiting: "他の参加者がそろうのを待っています",
  connecting: "発表者からモデルを受け取っています",
  active: "計算を受け持っているあいだ、この丸が脈打ちます",
  reorganizing: "メンバーが変わりました。まもなく再開します",
  error: "起動に失敗しました",
};

/**
 * 再編成中の文言。増えたときと減ったときで受け取り方が違うので分ける
 * (人が増えていく様子を見せるのが狙いで、減ったときと同じ顔では出せない)。
 * hint は何が起きたか、notice はこれからどうなるかを担う。
 */
const REORGANIZING_TEXT: Record<AbortReason, { hint: string; notice: string }> = {
  peer_joined: {
    hint: "新しい参加者が増えました",
    notice: "新しい参加者を加えて組み直しています",
  },
  peer_disconnected: {
    hint: "参加者が減りました",
    notice: "抜けたぶんを埋めて組み直しています",
  },
  connection_failed: {
    hint: "接続がうまくいきませんでした",
    notice: "つながる相手だけで組み直しています",
  },
};

const REORGANIZING_FALLBACK = {
  hint: HINTS.reorganizing,
  notice: "メンバーが変わったため再編成しています",
};

/**
 * 再編成中の見た目のトーン(#68)。「人が増えた」は嬉しい出来事、
 * 「誰か落ちた」は残念な出来事なので、同じ扱いにしない。
 */
const REORGANIZING_TONE: Record<AbortReason, "joyful" | "calm"> = {
  peer_joined: "joyful",
  peer_disconnected: "calm",
  connection_failed: "calm",
};

function reorganizingTone(reason: AbortReason | null): "joyful" | "calm" {
  if (!reason) return "calm";
  return REORGANIZING_TONE[reason] ?? "calm";
}

/**
 * 再編成が長引いたときの案内(#63)。文字列をJSXの中に直接置くと、行を折り返した
 * ぶんが半角スペースとして描画されて日本語の途中に隙間ができるため、ここで組む。
 */
const STALL_TITLE = "編成に時間がかかっています";
const STALL_HINT =
  "発表者の準備が終わっていないか、他の参加者を待っている可能性があります。" +
  "このまま戻らないときは参加し直してください。";

/**
 * きっかけが分からないまま再編成中になることがある(開発パネルからの直接遷移、
 * 世代の途中から画面を開いた場合など)。そのときは元の固定文言に戻す
 */
function reorganizingText(reason: AbortReason | null) {
  if (!reason) return REORGANIZING_FALLBACK;
  return REORGANIZING_TEXT[reason] ?? REORGANIZING_FALLBACK;
}

/** Runtimeから来る失敗を画面の文言に落とす */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 参加者(peer)画面。参加 → エンジン起動 → 発表者との接続 → 貢献中、という
 * 1本の流れを出す。フェーズを決めるのは clusterReducer で、ここは表示と、
 * 参加・離脱・繋ぎ直しの操作だけを持つ。
 */
export function PeerView() {
  const [joined, setJoined] = useState(false);
  const [displayName, setDisplayName] = useState(DEFAULT_DISPLAY_NAME);
  // useCluster が初期状態に取り込むので、先に決めておく
  const [myId] = useState(() => getClientId("peer"));
  const { state, dispatch, send, lastMessage, assignments, debug, model } = useCluster({
    enabled: joined,
    myId,
    role: "peer",
  });
  const env = useEnvironment();

  const { phase } = state;
  const isActive = phase === "active";
  const reorganizing = reorganizingText(state.abortReason);
  const reorganizingNoticeTone = reorganizingTone(state.abortReason);

  // 再編成中から出る道はサーバの generation_start しかない。requesterが居ない、
  // 誰かが ready にならない、といった理由で次の世代が組めないと、画面は無言のまま
  // 止まる。時間で気づけるようにして、繋ぎ直しの導線を出す(#63)
  const reorganizingStalled = useStalled(phase === "reorganizing", REORGANIZING_STALL_MS);

  /**
   * この端末が計算に参加できなくなったことを伝える。**画面をerrorにするだけでは足りない**(#79)。
   *
   * Honoは `status: "error"` のpeerを次の編成から外す(#57)。送らないとこのpeerは
   * `connecting` のままロスターに残り、サーバの `eligiblePeerIds` は「準備中の人がいる」
   * として待ち続けるため、**部屋全体が次の世代へ進めなくなる**。
   *
   * 失敗の出どころは3つあり、どれも「計算に参加できない」点では同じなので1本にまとめる。
   *   - PeerManager (DataChannel上のRPC)
   *   - WebRTC 接続そのもの
   *   - Runtime の起動・実行 (B-1で入った実 WASM 経路)
   *
   * 同じ失敗で複数回送られてもよい。サーバ側は同じ `error` を重ねて受けても
   * 状態が変わらず、世代開始のループにもならない(`roster.test.ts` で固定)。
   */
  const reportPeerError = useCallback(
    (message: string) => {
      dispatch({ type: "failed", message });
      send({ type: "peer_status", status: "error", errorMessage: message });
    },
    [dispatch, send],
  );

  // 発表者とのDataChannelの上でRPCを話す側。①のWASMが起動すると
  // `Module.PeerManager = rpc.manager` が差し込まれる(`useWasmEngine`)。
  // `releaseBuf` は渡さない(受信バッファの所有権はWASMのglue側。handoff契約)
  const rpc = usePeerManager({
    onError: reportPeerError,
  });

  // 稼働中の計測。数えているのは PeerManager 側で、ここは250msごとに読むだけ
  const stats = usePeerStats(rpc.manager.stats, joined);

  // 発表者からのofferを受けてanswerを返す。フェーズの判断はしないので、
  // ここが返すのは接続の状況だけ
  const rtc = useWebrtcSignaling({
    role: "peer",
    myId,
    enabled: joined,
    lastMessage,
    send,
    ...rpc.handlers,
    // peer は世代を持ち回らない。`peer_status: "error"` に世代の概念がなく、
    // サーバ側も同じ error を重ねて受けて構わない契約のため(roster.test.ts で固定)
    onFailed: (_generation, message) => reportPeerError(message),
  });
  const progress = CONNECT_PROGRESS[rtc.status];

  // 空白だけの名前で参加させない。層バーに名前のない区間ができる。
  // secure contextでないときも止める。SharedArrayBuffer・WebGPU・WebRTCが
  // どれも使えず、参加しても計算できないため
  const canJoin = env.secureContext && displayName.trim().length > 0;

  // 接続できたら名乗る。本物のHonoでも同じ
  useEffect(() => {
    if (phase !== "preparing") return;
    send({
      type: "hello",
      role: "peer",
      clientId: myId,
      displayName: displayName.trim(),
    });
  }, [phase, send, displayName, myId]);

  // ①のWASMを読み込んでrpc-server役を起動する。
  //
  // **寿命は join → leave/unmount**。フェーズでは止めない。世代交代のたびに落とすと
  // 次の世代のためにRPCサーバを立て直すことになり、そのぶん再編成が長引く。
  // 世代の切り替えはPeerManager側の張り替えで吸収する。
  //
  // 読めない・起動できないはダミーへ落とさずに失敗させる(`webrtc/wasmEngine.ts`)。
  const runtime = useWasmEngine({
    manager: rpc.manager,
    enabled: joined,
    // Runtimeのstdout/stderr。画面には出さないが、層の割り当てやRPCの様子は
    // ここにしか出ないので、コンソールでは追えるようにしておく
    onLog: (line) => console.info(`[runtime] ${line}`),
    onError: (error) => reportPeerError(describeError(error)),
  });

  // 自分がロスターに載ったか。`socket_closed` でロスターは空になるので、
  // この false → true が「制御プレーンに繋がり直して名乗り終えた」1回に対応する
  const selfRegistered = state.roster.some((peer) => peer.clientId === myId);

  // 準備完了の通知。**Runtimeのreadyと、制御プレーンへの登録の両方**が要る。
  // `runtime.ready` の直後に送ると、helloより先に出てしまうことがある
  // (`useHonoSocket.send` はソケットが無い状態では捨てる)。
  //
  // ⚠️ 接続ごとのguardが要る。サーバは `peer_status` を受けるたびに `roster_update` を
  // broadcastするので、guardが無いと peer_status → roster_update → 再送 のループになる。
  const readySentRef = useRef(false);
  useEffect(() => {
    if (!selfRegistered) {
      // 切れた。次に名乗り直したらもう一度送る
      readySentRef.current = false;
      return;
    }
    if (!runtime.ready || readySentRef.current) return;
    readySentRef.current = true;
    dispatch({ type: "local_ready" });
    send({ type: "peer_status", status: "ready" });
  }, [selfRegistered, runtime.ready, dispatch, send]);

  // 発表者とのDataChannelが開いたら受信中を抜ける。世代の古い接続がここへ来ることは
  // ない(useWebrtcSignaling が open になる前に閉じている)
  useEffect(() => {
    if (phase === "connecting" && rtc.status === "open") {
      dispatch({ type: "datachannel_open" });
    }
  }, [phase, rtc.status, dispatch]);

  /** 参加する。ここから `enabled` が立ち、`/ws` への接続が始まる */
  const join = useCallback(() => {
    // 前回参加したぶんを持ち越さない。世代をまたいでも0には戻さないので、
    // 0に戻すのはここだけ
    rpc.manager.stats.reset();
    setJoined(true);
  }, [rpc.manager]);

  /** 離脱する。接続を畳んで画面を最初に戻す */
  const leave = () => {
    setJoined(false);
    dispatch({ type: "reset" });
  };

  /** 繋ぎ直しの予約。この値で描画は変わらないので state ではなく ref に持つ */
  const wantsRejoin = useRef(false);

  /**
   * 参加し直す。leave() と join() を続けて呼んでも、同じ描画のあいだは `enabled` が
   * false を通らず useHonoSocket の後片付けが走らない(WebSocketが閉じないので
   * 繋ぎ直しにならない)。離脱が反映された次の描画で join() を通す。
   */
  const rejoin = () => {
    wantsRejoin.current = true;
    leave();
  };

  useEffect(() => {
    if (joined || !wantsRejoin.current) return;
    wantsRejoin.current = false;
    join();
  }, [joined, join]);

  return (
    <div className={styles.page}>
      <TopBar
        left={
          <>
            参加者 {state.roster.length}人
            {state.generation > 0 ? ` · 第${state.generation}世代` : ""}
          </>
        }
        right={
          phase !== "idle" ? (
            <button type="button" onClick={leave}>
              離脱する
            </button>
          ) : undefined
        }
      />

      <div className={styles.body}>
        <StatusBlock
          title={TITLES[phase]}
          hint={phase === "reorganizing" ? reorganizing.hint : HINTS[phase]}
          active={isActive}
          pulsing={isActive && stats.busy}
          showDot={phase !== "idle"}
        />

        {/*
          error から戻る道は、以前は TopBar の「離脱する」を押して表示名を入れ直し
          「参加する」を押す2手しかなかった。編成から外れた参加者が error に留まる
          ようになった(#79 の実機確認)ので、1手で戻れるようにする。
          rejoin は離脱が反映された次の描画で join() を通す既存の経路
        */}
        {phase === "error" && (
          <>
            {state.errorMessage && <p className={styles.errorDetail}>{state.errorMessage}</p>}
            <div className={styles.retry}>
              <button type="button" onClick={rejoin}>
                参加し直す
              </button>
            </div>
          </>
        )}

        {phase === "idle" && (
          <div className={styles.form}>
            <input
              type="text"
              value={displayName}
              placeholder="表示名"
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <button type="button" className={styles.join} disabled={!canJoin} onClick={join}>
              参加する
            </button>
            <div className={styles.env}>
              <span className={env.webgpu === "no" ? styles.envBad : undefined}>
                {describeWebgpu(env.webgpu)}
              </span>
              <span>{describeMemory(env.memoryGb)}</span>
              <span className={env.secureContext ? undefined : styles.envBad}>
                {env.secureContext ? "secure context 有効" : "secure context 無効"}
              </span>
            </div>

            {!env.secureContext && (
              <p className={styles.notice}>
                このページはHTTPSで開かれていないため、計算に参加できません。 主催のPCが配っている{" "}
                <span className={styles.mono}>https://</span> のURLで開き直してください。
              </p>
            )}
          </div>
        )}

        {phase === "connecting" && <ProgressBar value={progress} label="発表者との接続" />}

        {phase === "reorganizing" &&
          (reorganizingStalled ? (
            <div className={styles.stall} role="status">
              <p className={styles.stallTitle}>{STALL_TITLE}</p>
              <p className={styles.stallHint}>{STALL_HINT}</p>
              <button type="button" onClick={rejoin}>
                参加し直す
              </button>
            </div>
          ) : (
            <p
              className={`${styles.notice} ${reorganizingNoticeTone === "joyful" ? styles.noticeJoyful : styles.noticeCalm}`}
            >
              {reorganizing.notice}
            </p>
          ))}

        {(phase === "connecting" || phase === "active" || phase === "reorganizing") && (
          <LayerBar
            totalLayers={model.totalLayers}
            assignments={assignments}
            roster={state.roster}
            highlightClientId={myId}
          />
        )}

        {(isActive || phase === "reorganizing") && (
          <MetricGrid>
            <Metric label="処理回数" value={stats.started ? formatCount(stats.turns) : NO_VALUE} />
            <Metric
              label="受信データ"
              value={stats.started ? formatBytes(stats.bytesReceived) : NO_VALUE}
            />
            <Metric
              label="応答時間"
              value={stats.responseMs === null ? NO_VALUE : formatDuration(stats.responseMs)}
            />
          </MetricGrid>
        )}
      </div>

      <DevPanel
        phase={phase}
        onPhase={(p) => dispatch({ type: "dev_set_phase", phase: p })}
        debug={debug}
      />
    </div>
  );
}
