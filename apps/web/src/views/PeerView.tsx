import { useEffect, useState } from "react";
import { TopBar } from "../components/TopBar";
import { StatusBlock } from "../components/StatusBlock";
import { LayerBar } from "../components/LayerBar";
import { ProgressBar } from "../components/ProgressBar";
import { Metric, MetricGrid } from "../components/Metric";
import { DevPanel } from "../components/DevPanel";
import { useCluster } from "../hooks/useCluster";
import { getClientId } from "../lib/clientId";
import { formatBytes, formatCount } from "../lib/format";
import { DEFAULT_DISPLAY_NAME, TOTAL_LAYERS } from "../config";
import type { Phase } from "../types/cluster";
import styles from "./PeerView.module.css";

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
  const { state, dispatch, send, assignments, debug } = useCluster({ enabled: joined });
  const [progress, setProgress] = useState(0);
  const [calls, setCalls] = useState(0);
  const [bytes, setBytes] = useState(0);
  const [myId] = useState(getClientId);

  const { phase } = state;
  const isActive = phase === "active";

  // 接続できたら名乗る。本物のHonoでも同じ
  useEffect(() => {
    if (phase !== "preparing") return;
    send({
      type: "hello",
      role: "peer",
      clientId: myId,
      displayName,
    });
    // ①のWASM起動の代わり。完了したら準備完了を知らせる
    const t = window.setTimeout(() => {
      dispatch({ type: "local_ready" });
      send({ type: "peer_status", status: "ready" });
    }, 2200);
    return () => clearTimeout(t);
  }, [phase, send, dispatch, displayName, myId]);

  // WebRTCが繋がるまでの代わり
  useEffect(() => {
    if (phase !== "connecting") return;
    let v = 0;
    const id = window.setInterval(() => {
      v = Math.min(1, v + 0.04);
      setProgress(v);
      if (v >= 1) dispatch({ type: "datachannel_open" });
    }, 70);
    return () => clearInterval(id);
  }, [phase, dispatch]);

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
    setProgress(0);
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
            <button type="button" className={styles.join} onClick={join}>
              参加する
            </button>
            <div className={styles.env}>
              <span>WebGPU 利用可</span>
              <span>空きメモリ 8 GB</span>
              <span>secure context 有効</span>
            </div>
          </div>
        )}

        {phase === "connecting" && <ProgressBar value={progress} label="モデルの受信" />}

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
