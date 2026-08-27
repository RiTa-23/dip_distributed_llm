import { useEffect, useRef, useState } from "react";
import { TopBar } from "../components/TopBar";
import { LayerBar } from "../components/LayerBar";
import { ProgressBar } from "../components/ProgressBar";
import { DevPanel } from "../components/DevPanel";
import { JoinQr } from "../components/JoinQr";
import { useCluster } from "../hooks/useCluster";
import { useWebrtcSignaling } from "../hooks/useWebrtcSignaling";
import { usePeerManager } from "../hooks/usePeerManager";
import type { GenerationEvent } from "../hooks/usePeerManager";
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

const PEER_STATUS_LABEL: Record<string, string> = {
  connecting: "接続中",
  ready: "準備完了",
  error: "エラー",
};

export function RequesterView() {
  const { state, dispatch, send, lastMessage, assignments, debug } = useCluster({ enabled: true });
  const [modelProgress, setModelProgress] = useState(0);
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [streaming, setStreaming] = useState("");
  const [generating, setGenerating] = useState(false);
  const [computingIndex, setComputingIndex] = useState<number | null>(null);
  const [input, setInput] = useState("分散推論のしくみを一言で教えて");
  const timer = useRef<number | null>(null);
  const streamingRef = useRef("");
  const toastTimer = useRef<number | null>(null);
  const previousRosterSize = useRef(state.roster.length);
  const previousGenerating = useRef(generating);
  const [toast, setToast] = useState<string | null>(null);
  const [myId] = useState(() => getClientId("requester"));

  const { phase } = state;

  const receiveGenerationEvent = (event: GenerationEvent) => {
    if (event.type === "token") {
      streamingRef.current += event.token;
      setStreaming(streamingRef.current);
      setGenerating(true);
      return;
    }

    setGenerating(false);
    setComputingIndex(null);
    if (streamingRef.current) {
      setChat((c) => [...c, { role: "assistant", text: streamingRef.current }]);
    }
    streamingRef.current = "";
    setStreaming("");
  };

  // 各peerとのDataChannelの上でRPCを話す側(RPCクライアント役)。
  // ①のWASMが起動したら `Module.PeerManager = rpc.manager` で載せる
  const rpc = usePeerManager({
    onError: (message) => dispatch({ type: "failed", message }),
    onGenerationEvent: receiveGenerationEvent,
  });

  // generation_start の顔ぶれ全員へofferを出す。フェーズの判断はしない
  const rtc = useWebrtcSignaling({
    role: "requester",
    myId,
    enabled: true,
    lastMessage,
    send,
    ...rpc.handlers,
    // 失敗を伝えないと、Hono は active のまま固まって誰かの切断待ちになる(#78)。
    // 世代番号は useWebrtcSignaling が古い世代の失敗を既に落としているので、
    // コールバックが届いた時点の state.generation が現在の世代と一致する
    onFailed: (message) => {
      dispatch({ type: "failed", message });
      send({ type: "generation_failed", generation: state.generation });
    },
  });
  const distribution =
    rtc.expectedIds.length === 0 ? 0 : rtc.openIds.length / rtc.expectedIds.length;

  const modelReady = modelProgress >= 1;
  const canSubmit = phase === "active" && modelReady && !generating;

  // トラックA: モデルのダウンロード。フェーズとは独立に、開いた瞬間から進む。
  useEffect(() => {
    let disposed = false;
    let fallbackTimer: number | null = null;
    const controller = new AbortController();

    const startFallback = () => {
      let value = 0;
      fallbackTimer = window.setInterval(() => {
        value = Math.min(1, value + 0.02);
        setModelProgress(value);
        if (value >= 1 && fallbackTimer !== null) {
          clearInterval(fallbackTimer);
          fallbackTimer = null;
        }
      }, 80);
    };

    const download = async () => {
      try {
        const response = await fetch(`/models/${MODEL_NAME}`, { signal: controller.signal });
        if (!response.ok || !response.body)
          throw new Error(`model download failed: ${response.status}`);

        const total = Number(response.headers.get("content-length"));
        if (!Number.isFinite(total) || total <= 0) {
          startFallback();
          return;
        }

        const reader = response.body.getReader();
        let received = 0;
        try {
          while (!disposed) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            setModelProgress(Math.min(1, received / total));
          }
          if (!disposed) setModelProgress(1);
        } finally {
          reader.releaseLock();
        }
      } catch {
        if (!disposed) startFallback();
      }
    };

    void download();
    return () => {
      disposed = true;
      controller.abort();
      if (fallbackTimer !== null) clearInterval(fallbackTimer);
    };
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

  // 全peerとのDataChannelが開いたら配布中を抜ける。1人でも開いていなければ待つ
  useEffect(() => {
    if (phase === "connecting" && rtc.status === "open") {
      dispatch({ type: "datachannel_open" });
    }
  }, [phase, rtc.status, dispatch]);

  // 推論中は新規peerの加入による再編成を保留させる(#50)。生成の開始・終了は
  // run() 側のタイマーとtoken/generation_end受信の両方から起きるので、
  // 発生源を1箇所に絞れる generating の変化を見て送る
  useEffect(() => {
    if (previousGenerating.current === generating) return;
    previousGenerating.current = generating;
    send({ type: "requester_accepting", accepting: !generating });
  }, [generating, send]);

  useEffect(() => {
    const currentSize = state.roster.length;
    const previousSize = previousRosterSize.current;
    previousRosterSize.current = currentSize;
    if (currentSize === previousSize) return;

    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(`${previousSize}台→${currentSize}台に更新`);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, [state.roster.length]);

  useEffect(() => {
    if (!lastMessage) return;
    const message =
      lastMessage.type === "generation_start"
        ? "編成が完了しました"
        : lastMessage.type === "generation_aborted"
          ? lastMessage.message
          : null;
    if (!message) return;

    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, [lastMessage]);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const run = () => {
    if (!canSubmit || !input.trim()) return;
    setChat((c) => [...c, { role: "user", text: input }]);
    setInput("");
    streamingRef.current = "";
    setStreaming("");
    setGenerating(true);
    let i = 0;
    timer.current = window.setInterval(() => {
      i += 1;
      receiveGenerationEvent({ type: "token", token: DUMMY_ANSWER[i - 1] ?? "" });
      // 1トークンぶんの計算が全ピアを一周する見え方にする
      setComputingIndex(Math.floor(i / 12) % Math.max(1, assignments.length));
      if (i >= DUMMY_ANSWER.length) {
        if (timer.current) clearInterval(timer.current);
        receiveGenerationEvent({ type: "generation_end" });
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
              {state.roster.map((peer) => {
                const assignment = assignments.find((a) => a.clientId === peer.clientId);
                const isComputing = peer.clientId === computingClientId;
                return (
                  <div
                    key={peer.clientId}
                    className={`${styles.peerRow} ${styles[peer.status]} ${isComputing ? styles.computing : ""}`}
                  >
                    <span className={styles.peerName}>
                      <span className={styles.statusDot} aria-hidden="true" />
                      {peer.displayName}
                    </span>
                    <span className={styles.peerRange}>
                      {PEER_STATUS_LABEL[peer.status]}
                      {assignment ? ` · 第${assignment.startLayer}〜${assignment.endLayer}層` : ""}
                      {isComputing ? " · 計算中" : ""}
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
              <div className={styles.dim}>
                接続 {rtc.openIds.length}/{rtc.expectedIds.length}人 ·{" "}
                {Math.round(distribution * 100)}%
              </div>
            )}
          </div>
        </aside>

        <section className={styles.chat}>
          {toast && (
            <div className={styles.toast} role="status">
              {toast}
            </div>
          )}
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
