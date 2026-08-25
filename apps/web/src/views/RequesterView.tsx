import { useEffect, useRef, useState } from "react";
import { TopBar } from "../components/TopBar";
import { LayerBar } from "../components/LayerBar";
import { ProgressBar } from "../components/ProgressBar";
import { DevPanel } from "../components/DevPanel";
import { JoinQr } from "../components/JoinQr";
import { useCluster } from "../hooks/useCluster";
import { getClientId } from "../lib/clientId";
import { MODEL_NAME, TOTAL_LAYERS } from "../config";
import type { Phase } from "../types/cluster";
import styles from "./RequesterView.module.css";

type ChatEntry = { role: "user" | "assistant"; text: string };

const NOTICE: Partial<Record<Phase, string>> = {
  idle: "サーバーに接続していません",
  preparing: "参加者がそろうのを待っています",
  waiting: "編成が組まれるのを待っています",
  connecting: "参加者へモデルを配っています",
  reorganizing: "メンバーが変わったため再編成しています",
  error: "接続に失敗しました",
};

const DUMMY_ANSWER =
  "1つのモデルを層ごとに分けて、複数のPCが順番に計算を受け持つしくみです。" +
  "参加するPCが増えるほど、1台では載りきらない大きなモデルが動かせます。";

export function RequesterView() {
  const { state, dispatch, send, assignments, debug } = useCluster({ enabled: true });
  const [modelProgress, setModelProgress] = useState(0);
  const [distribution, setDistribution] = useState(0);
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [streaming, setStreaming] = useState("");
  const [generating, setGenerating] = useState(false);
  const [computingIndex, setComputingIndex] = useState<number | null>(null);
  const [input, setInput] = useState("分散推論のしくみを一言で教えて");
  const timer = useRef<number | null>(null);
  const [myId] = useState(() => getClientId("requester"));

  const { phase } = state;
  const modelReady = modelProgress >= 1;
  const canSubmit = phase === "active" && modelReady && !generating;

  // トラックA: モデルのダウンロード。フェーズとは独立に、開いた瞬間から進む
  useEffect(() => {
    let v = 0;
    const id = window.setInterval(() => {
      v = Math.min(1, v + 0.02);
      setModelProgress(v);
      if (v >= 1) clearInterval(id);
    }, 80);
    return () => clearInterval(id);
  }, []);

  // トラックB: 編成。接続できたら名乗り、すぐ準備完了とする(発表者に起動待ちはない)
  useEffect(() => {
    if (phase !== "preparing") return;
    send({
      type: "hello",
      role: "requester",
      clientId: myId,
      displayName: "発表者PC",
    });
    const t = window.setTimeout(() => dispatch({ type: "local_ready" }), 500);
    return () => clearTimeout(t);
  }, [phase, send, dispatch, myId]);

  // 各peerへモデルを配り終えるまでの代わり
  useEffect(() => {
    if (phase !== "connecting") return;
    let v = 0;
    const id = window.setInterval(() => {
      v = Math.min(1, v + 0.05);
      setDistribution(v);
      if (v >= 1) dispatch({ type: "datachannel_open" });
    }, 70);
    return () => clearInterval(id);
  }, [phase, dispatch]);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  const run = () => {
    if (!canSubmit || !input.trim()) return;
    setChat((c) => [...c, { role: "user", text: input }]);
    setInput("");
    setStreaming("");
    setGenerating(true);
    let i = 0;
    timer.current = window.setInterval(() => {
      i += 1;
      setStreaming(DUMMY_ANSWER.slice(0, i));
      // 1トークンぶんの計算が全ピアを一周する見え方にする
      setComputingIndex(Math.floor(i / 12) % Math.max(1, assignments.length));
      if (i >= DUMMY_ANSWER.length) {
        if (timer.current) clearInterval(timer.current);
        setGenerating(false);
        setComputingIndex(null);
        setStreaming("");
        setChat((c) => [...c, { role: "assistant", text: DUMMY_ANSWER }]);
      }
    }, 45);
  };

  const computingClientId =
    computingIndex === null ? null : (assignments[computingIndex]?.clientId ?? null);
  const notice = NOTICE[phase];

  return (
    <div className={styles.page}>
      <TopBar
        left={
          <>
            第{state.generation}世代 · 接続 {state.roster.length}人 ·{" "}
            <span className={styles.mono}>{MODEL_NAME}</span>
          </>
        }
        right={
          <span style={{ color: phase === "active" ? "var(--c-active)" : undefined }}>
            {phase === "active" ? "接続済み" : phase}
          </span>
        }
      />

      <div className={styles.body}>
        <aside className={styles.sidebar}>
          {/* 参加者がそろうまでは大きく、埋まった後も途中参加の導線として残す */}
          <JoinQr emphasized={phase === "idle" || phase === "preparing" || phase === "waiting"} />

          <div>
            <div className={styles.sectionLabel}>PEERS</div>
            <div className={styles.peers}>
              {assignments.map((a) => {
                const peer = state.roster.find((p) => p.clientId === a.clientId);
                const isComputing = a.clientId === computingClientId;
                return (
                  <div
                    key={a.clientId}
                    className={`${styles.peerRow} ${isComputing ? styles.computing : ""}`}
                  >
                    <span className={styles.peerName}>{peer?.displayName ?? a.clientId}</span>
                    <span className={styles.peerRange}>
                      第{a.startLayer}〜{a.endLayer}層{isComputing ? " · 計算中" : ""}
                    </span>
                    <span className={styles.peerBar} />
                  </div>
                );
              })}
              {assignments.length === 0 && (
                <span className={styles.peerRange}>参加者を待っています</span>
              )}
            </div>
          </div>

          <div>
            <div className={styles.sectionLabel}>モデル</div>
            <ProgressBar value={modelProgress} label="モデルのダウンロード" />
            <div className={styles.dim}>
              {modelReady ? "読み込み済み" : `${Math.round(modelProgress * 100)}%`}
            </div>
          </div>

          <div>
            <div className={styles.sectionLabel}>全体</div>
            <LayerBar
              totalLayers={TOTAL_LAYERS}
              assignments={assignments}
              roster={state.roster}
              computingClientId={computingClientId}
              showLabels={false}
            />
            {phase === "connecting" && (
              <div className={styles.dim}>配布中 {Math.round(distribution * 100)}%</div>
            )}
          </div>
        </aside>

        <section className={styles.chat}>
          {notice && <div className={styles.notice}>{notice}</div>}
          <div className={styles.log}>
            {chat.map((m, i) => (
              <div key={i} className={m.role === "user" ? styles.user : styles.assistant}>
                {m.text}
              </div>
            ))}
            {generating && (
              <div className={styles.assistant}>
                {streaming}
                <span className={styles.caret}>▌</span>
              </div>
            )}
          </div>
          <div className={styles.composer}>
            <input
              type="text"
              value={input}
              placeholder="メッセージを入力"
              disabled={!canSubmit}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // 日本語入力の変換確定のEnterで送信してしまわないようにする。
                // Safariは compositionend の後に isComposing:false でEnterを投げるので、
                // IME処理中を表す keyCode 229 も併せて見る
                if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                if (e.key === "Enter") run();
              }}
            />
            <button type="button" className={styles.sendButton} disabled={!canSubmit} onClick={run}>
              送信
            </button>
          </div>
        </section>
      </div>

      <DevPanel
        phase={phase}
        onPhase={(p) => dispatch({ type: "dev_set_phase", phase: p })}
        debug={debug}
      />
    </div>
  );
}
