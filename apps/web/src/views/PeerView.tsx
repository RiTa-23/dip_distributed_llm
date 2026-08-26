import { useEffect, useState } from "react";
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
import { getClientId } from "../lib/clientId";
import { describeMemory, describeWebgpu } from "../lib/environment";
import { useEnvironment } from "../hooks/useEnvironment";
import { formatBytes, formatCount, formatDuration, NO_VALUE } from "../lib/format";
import { DEFAULT_DISPLAY_NAME, TOTAL_LAYERS } from "../config";
import type { AbortReason, Phase } from "../types/cluster";
import styles from "./PeerView.module.css";

/**
 * 直接接続の進み具合。実測できるのは「相手が決まった」「開いた」の2段だけなので、
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
};

const REORGANIZING_FALLBACK = {
  hint: HINTS.reorganizing,
  notice: "メンバーが変わったため再編成しています",
};

/**
 * きっかけが分からないまま再編成中になることがある(開発パネルからの直接遷移、
 * 世代の途中から画面を開いた場合など)。そのときは元の固定文言に戻す
 */
function reorganizingText(reason: AbortReason | null) {
  if (!reason) return REORGANIZING_FALLBACK;
  return REORGANIZING_TEXT[reason] ?? REORGANIZING_FALLBACK;
}

export function PeerView() {
  const [joined, setJoined] = useState(false);
  const [displayName, setDisplayName] = useState(DEFAULT_DISPLAY_NAME);
  const { state, dispatch, send, lastMessage, assignments, debug } = useCluster({
    enabled: joined,
  });
  const [myId] = useState(() => getClientId("peer"));
  const env = useEnvironment();

  const { phase } = state;
  const isActive = phase === "active";
  const reorganizing = reorganizingText(state.abortReason);

  // 発表者とのDataChannelの上でRPCを話す側。①のWASMが起動したら
  // `Module.PeerManager = rpc.manager` で載せる。releaseBuf はそのとき一緒に渡す
  const rpc = usePeerManager({
    onError: (message) => dispatch({ type: "failed", message }),
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
    onFailed: (message) => dispatch({ type: "failed", message }),
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
    // ①のWASM起動の代わり。完了したら準備完了を知らせる
    const t = window.setTimeout(() => {
      dispatch({ type: "local_ready" });
      send({ type: "peer_status", status: "ready" });
    }, 2200);
    return () => clearTimeout(t);
  }, [phase, send, dispatch, displayName, myId]);

  // 発表者とのDataChannelが開いたら受信中を抜ける。世代の古い接続がここへ来ることは
  // ない(useWebrtcSignaling が open になる前に閉じている)
  useEffect(() => {
    if (phase === "connecting" && rtc.status === "open") {
      dispatch({ type: "datachannel_open" });
    }
  }, [phase, rtc.status, dispatch]);

  const join = () => {
    // 前回参加したぶんを持ち越さない。世代をまたいでも0には戻さないので、
    // 0に戻すのはここだけ
    rpc.manager.stats.reset();
    setJoined(true);
  };

  const leave = () => {
    setJoined(false);
    dispatch({ type: "reset" });
  };

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

        {phase === "error" && state.errorMessage && (
          <p className={styles.errorDetail}>{state.errorMessage}</p>
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

        {phase === "connecting" && <ProgressBar value={progress} label="発表者との直接接続" />}

        {phase === "reorganizing" && <p className={styles.notice}>{reorganizing.notice}</p>}

        {(phase === "connecting" || phase === "active" || phase === "reorganizing") && (
          <LayerBar
            totalLayers={TOTAL_LAYERS}
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
