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
import { getClientId } from "../lib/clientId";
import { describeMemory, describeWebgpu } from "../lib/environment";
import { useEnvironment } from "../hooks/useEnvironment";
import { formatBytes, formatCount } from "../lib/format";
import { DEFAULT_DISPLAY_NAME, TOTAL_LAYERS } from "../config";
import type { Phase } from "../types/cluster";
import styles from "./PeerView.module.css";

/**
 * 直接接続の進み具合。実測できるのは「相手が決まった」「開いた」の2段だけなので、
 * 途中の値を作らずこの3つに丸める。モデルの受信量が出せるようになるのは①のRPC連携が入ってから。
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
  active: "1トークンごとにこの丸が脈打ちます",
  reorganizing: "メンバーが変わりました。まもなく再開します",
  error: "起動に失敗しました",
};

export function PeerView() {
  const [joined, setJoined] = useState(false);
  const [displayName, setDisplayName] = useState(DEFAULT_DISPLAY_NAME);
  const { state, dispatch, send, lastMessage, assignments, debug } = useCluster({
    enabled: joined,
  });
  const [calls, setCalls] = useState(0);
  const [bytes, setBytes] = useState(0);
  const [myId] = useState(() => getClientId("peer"));
  const env = useEnvironment();

  const { phase } = state;
  const isActive = phase === "active";

  // 発表者からのofferを受けてanswerを返す。フェーズの判断はしないので、
  // ここが返すのは接続の状況だけ
  const rtc = useWebrtcSignaling({
    role: "peer",
    myId,
    enabled: joined,
    lastMessage,
    send,
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

  // 稼働中の計測。本物は RTCPeerConnection.getStats() を250msごとに読む
  useEffect(() => {
    if (phase !== "active") return;
    const id = window.setInterval(() => {
      setCalls((v) => v + 1);
      setBytes((v) => v + 1_400_000 + Math.floor(Math.random() * 400_000));
    }, 420);
    return () => clearInterval(id);
  }, [phase]);

  const join = () => {
    setCalls(0);
    setBytes(0);
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
          hint={HINTS[phase]}
          active={isActive}
          showDot={phase !== "idle"}
        />

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

        {phase === "reorganizing" && (
          <p className={styles.notice}>メンバーが変わったため再編成しています</p>
        )}

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
            <Metric label="処理回数" value={formatCount(calls)} />
            <Metric label="受信データ" value={formatBytes(bytes)} />
            <Metric label="平均処理" value="84 ms" />
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
