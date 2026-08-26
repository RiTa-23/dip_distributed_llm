import { useEffect, useRef, useState } from "react";
import { TopBar } from "../components/TopBar";
import { LayerBar } from "../components/LayerBar";
import { ProgressBar } from "../components/ProgressBar";
import { DevPanel } from "../components/DevPanel";
import { JoinQr } from "../components/JoinQr";
import { useCluster } from "../hooks/useCluster";
import { useWebrtcSignaling } from "../hooks/useWebrtcSignaling";
import { usePeerManager } from "../hooks/usePeerManager";
import { useRequesterRuntime } from "../hooks/useRequesterRuntime";
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

const PEER_STATUS_LABEL: Record<string, string> = {
  connecting: "接続中",
  ready: "準備完了",
  error: "エラー",
};

/** Runtimeから来る失敗を画面の文言に落とす */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function RequesterView() {
  const { state, dispatch, send, lastMessage, assignments, debug } = useCluster({ enabled: true });
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [streaming, setStreaming] = useState("");
  const [generating, setGenerating] = useState(false);
  const [computingIndex, setComputingIndex] = useState<number | null>(null);
  const [input, setInput] = useState("分散推論のしくみを一言で教えて");
  const toastTimer = useRef<number | null>(null);

  // 生成の窓。**Runtimeの `onText` には起動時のstdoutも流れてくる**ので、
  // generateを呼んだ前後で区切って、そのあいだに来たぶんだけを回答として扱う。
  // stateではなくrefなのは、onTextが再描画と無関係に高頻度で呼ばれるのと、
  // stateだとクロージャが古い値を掴むため
  const generationActiveRef = useRef(false);
  const generationTextRef = useRef("");
  const previousRosterSize = useRef(state.roster.length);
  const [toast, setToast] = useState<string | null>(null);
  const [myId] = useState(() => getClientId("requester"));

  const { phase } = state;

  // 各peerとのDataChannelの上でRPCを話す側(RPCクライアント役)。
  // ①のWASMが起動すると `Module.PeerManager = rpc.manager` が差し込まれる。
  // `onGenerationEvent`(UI用のスタブ)は繋がない。実生成の唯一の経路は
  // Runtime adapterの `onText` で、スタブが混ざると判定にならない
  const rpc = usePeerManager({
    onError: (message) => dispatch({ type: "failed", message }),
  });

  // generation_start の顔ぶれ全員へofferを出す。フェーズの判断はしない
  const rtc = useWebrtcSignaling({
    role: "requester",
    myId,
    enabled: true,
    lastMessage,
    send,
    ...rpc.handlers,
    onFailed: (message) => dispatch({ type: "failed", message }),
  });
  const distribution =
    rtc.expectedIds.length === 0 ? 0 : rtc.openIds.length / rtc.expectedIds.length;

  // その世代で繋ぐべき相手が全員openしたか。開ききる前にRuntimeを立てると、
  // まだ繋がっていない相手をRPC deviceとして登録してしまう
  const allOpen = rtc.expectedIds.length > 0 && rtc.openIds.length === rtc.expectedIds.length;

  // requester役のRuntime。**世代ごとに作り直す**(RPC deviceは起動時の引数で固定される)
  const requester = useRequesterRuntime({
    manager: rpc.manager,
    generation: rtc.generation,
    allOpen,
    peerIds: rtc.expectedIds,
    model: { kind: "url", url: `/models/${MODEL_NAME}` },
    onText: (delta) => {
      if (!generationActiveRef.current) return; // 起動時のstdoutは回答ではない
      generationTextRef.current += delta;
      setStreaming(generationTextRef.current);
    },
    // Runtimeのstderr。`load_tensors: layer N assigned to device RPC0` など、
    // 層がどのデバイスに載ったかはここにしか出ない
    onLog: (line) => console.info(`[runtime] ${line}`),
    onError: (error) => dispatch({ type: "failed", message: describeError(error) }),
  });

  // 送信できるのは**Runtimeのreadyが解決してから**。作り物の進捗では判断しない
  const modelReady = requester.ready;
  const modelProgress = modelReady ? 1 : 0;
  const canSubmit = phase === "active" && modelReady && !generating;

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
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const run = () => {
    if (!canSubmit || !input.trim()) return;
    const prompt = input;
    setChat((c) => [...c, { role: "user", text: prompt }]);
    setInput("");

    // 窓を開ける。ここから `generate()` が解決するまでに来たぶんが回答
    generationTextRef.current = "";
    generationActiveRef.current = true;
    setStreaming("");
    setGenerating(true);

    void requester
      .generate(prompt)
      .then(() => {
        const answer = generationTextRef.current;
        if (answer) setChat((c) => [...c, { role: "assistant", text: answer }]);
      })
      .catch((error: unknown) => {
        dispatch({ type: "failed", message: describeError(error) });
      })
      .finally(() => {
        generationActiveRef.current = false;
        generationTextRef.current = "";
        setStreaming("");
        setGenerating(false);
        setComputingIndex(null);
      });
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
