import { useEffect, useRef, useState } from "react";
import { TopBar } from "../components/TopBar";
import { LayerBar } from "../components/LayerBar";
import { ProgressBar } from "../components/ProgressBar";
import { DevPanel } from "../components/DevPanel";
import { JoinQr } from "../components/JoinQr";
import { useCluster } from "../hooks/useCluster";
import { useWebrtcSignaling } from "../hooks/useWebrtcSignaling";
import { usePeerManager } from "../hooks/usePeerManager";
import { GenerationSupersededError, useRequesterRuntime } from "../hooks/useRequesterRuntime";
import { createGenerationOwner } from "../webrtc/generationOwner";
import type { GenerationToken } from "../webrtc/generationOwner";
import { createAcceptingSignal } from "../hooks/requesterAccepting";
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

/**
 * 1回の生成ぶんの受け皿。**開けた世代のトークンごと**持つ。
 *
 * Runtimeの `onText` には起動時のstdoutも同じ口で流れてくるので、generateを呼んだ
 * 前後で区切る必要がある。そのうえで世代のトークンも一緒に持たせておくと、世代が
 * 替わった時点でこの窓は自動的に無効になり、明示的に閉じて回る必要がなくなる。
 */
type GenerationWindow = { token: GenerationToken; text: string };

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
  const windowRef = useRef<GenerationWindow | null>(null);
  const previousRosterSize = useRef(state.roster.length);
  // `requester_accepting` の送り直しを決める edge 検出。**描画をまたいで1つ**でないと
  // 毎描画で初期値に戻り、edge として機能しない(`hooks/requesterAccepting.ts`)
  const [acceptingSignal] = useState(() => createAcceptingSignal());
  const [toast, setToast] = useState<string | null>(null);
  const [myId] = useState(() => getClientId("requester"));

  /**
   * 生成まわりを初期化する。呼ぶのは3か所:
   *   - 世代交代(描画中にそろえる)
   *   - **現行世代の致命的な失敗**(`onFailed` の drain)。世代番号が変わらないので、
   *     こちらを通さないと `generating` が立ったまま残る
   *   - 1回の生成が正常に終わったとき(`run()` の finally)
   *
   * 旧 run の `.finally` には任せない。旧 run は持ち主でなくなっているため画面に
   * 触れず(触れないのが正しい)、初期化は現行世代の側でやりきる必要がある。
   */
  const resetGenerationState = () => {
    setStreaming("");
    setGenerating(false);
    setComputingIndex(null);
  };

  const { phase } = state;

  // 各peerとのDataChannelの上でRPCを話す側(RPCクライアント役)。
  // ①のWASMが起動すると `Module.PeerManager = rpc.manager` が差し込まれる。
  // `onGenerationEvent`(UI用のスタブ)は繋がない。実生成の唯一の経路は
  // Runtime adapterの `onText` で、スタブが混ざると判定にならない
  // 世代の持ち主は**この画面に1つだけ**。Runtimeを立てる側(`useRequesterRuntime`)が
  // claim し、データプレーンを壊す側(`usePeerManager` の `retireCurrent`)が
  // close/detach の**前**に release する。片方だけが持つと、`close()` で起こされた
  // 旧Runtimeの失敗がまだ有効なトークンを素通りして、正常な再編成がエラーになる
  const [owner] = useState(createGenerationOwner);

  // **世代ごとに実体を作り直す**(`isolateGenerations`)。requesterのRuntimeは世代ごとに
  // 立て直すが、`stop()` は止まった証明にならない。同じ manager を渡していると、
  // まだ止まりきっていない旧Runtimeが新世代と同じfd空間を触れてしまう
  const rpc = usePeerManager({
    isolateGenerations: true,
    fence: () => owner.release(),
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
    // 失敗を伝えないと、Hono は active のまま固まって誰かの切断待ちになる(#78)。
    //
    // ここへ来るのは**その世代で最初の致命的な失敗1回だけ**で、close /
    // connectionState failed / SDP・ICE の失敗がすべて同じ道を通る
    // (`webrtc/requesterSession.ts` の `fatalFail`)。到達した時点で
    // `onClose` → fence → manager 退役 は済んでいるので、ここで画面に触るのは安全。
    //
    // **その場で畳む。** 進行中の run の後片付けには任せられない — 旧 run は
    // 持ち主ではなくなっているので、正しく何もしないから。世代番号は変わらないため
    // 描画中の初期化も走らない。ここが唯一の初期化の口になる。
    //
    // ⚠️ **既知の限界**: WebSocket が生きたまま DataChannel だけ死に、peer が `ready` の
    // ままの場合、server は編成を idle に戻すが**顔ぶれが同じなので次の世代を始めない**
    // (`roster.ts` の failedPeerIds / resetSinceStart、#56)。peer の切断・`error`・
    // 入り直しのいずれかが要る。peer 画面の「参加し直す」導線(#63)が回復路になる。
    // 自動復旧させるには `generation_failed` に peerId を載せる必要があり、
    // server / shared-types の変更を伴うので今回は行わない。
    onFailed: (generation, message) => {
      windowRef.current = null;
      resetGenerationState(); // generating:false → requester_accepting:true が送り直される
      dispatch({ type: "failed", message });
      send({ type: "generation_failed", generation });
    },
  });
  const distribution =
    rtc.expectedIds.length === 0 ? 0 : rtc.openIds.length / rtc.expectedIds.length;

  // その世代で繋ぐべき相手が全員openしたか。開ききる前にRuntimeを立てると、
  // まだ繋がっていない相手をRPC deviceとして登録してしまう
  const allOpen = rtc.expectedIds.length > 0 && rtc.openIds.length === rtc.expectedIds.length;

  // 世代が切り替わったら、**新しい世代の側で**生成まわりを初期化する。
  //
  // 旧 run の後片付けに任せない。旧 run はいつ解決するか(そもそも解決するか)分からず、
  // 解決しても持ち主ではないので画面に触れない(触れないのが正しい)。
  //
  // 効果ではなく描画中にそろえる(`useWebrtcSignaling` の enabled と同じ形)。効果へ回すと
  // 1描画ぶん「前の世代の生成中」が新しい世代の画面に残る
  const [renderedGeneration, setRenderedGeneration] = useState(rtc.generation);
  if (renderedGeneration !== rtc.generation) {
    setRenderedGeneration(rtc.generation);
    resetGenerationState();
  }

  // requester役のRuntime。**世代ごとに作り直す**(RPC deviceは起動時の引数で固定される)
  const requester = useRequesterRuntime({
    manager: rpc.manager,
    owner,
    generation: rtc.generation,
    allOpen,
    peerIds: rtc.expectedIds,
    model: { kind: "url", url: `/models/${MODEL_NAME}` },
    onText: (delta) => {
      const open = windowRef.current;
      // 窓が開いていない = 起動時のstdout。持ち主でない = 前の世代の窓が残っているだけ
      if (!open || !open.token.isCurrent()) return;
      open.text += delta;
      setStreaming(open.text);
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

  // 推論中は新規peerの加入による再編成を保留させる(#50)。生成の開始・終了は
  // run() 側のタイマーとtoken/generation_end受信の両方から起きるので、
  // 発生源を1箇所に絞れる generating の変化を見て送る。
  //
  // 世代交代の初期化と、**現行世代の失敗による drain** で generating が false へ戻った
  // ぶんも同じ口を通る。通さないと `accepting: false` を送ったきりになり、Hono が
  // 新規peerを永久に取り込めなくなる
  useEffect(() => {
    const accepting = acceptingSignal.next(generating);
    if (accepting === null) return;
    send({ type: "requester_accepting", accepting });
  }, [generating, send, acceptingSignal]);

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
    // **この生成を始めた世代を掴んでおく。** 解決したときにまだ持ち主かどうかで、
    // 画面に触ってよいかを決める。持ち主は `useRequesterRuntime` に1つだけあり、
    // ここでは自前に作らずそれを受け取る
    const mine = requester.currentToken();
    if (!mine) return;

    const prompt = input;
    setChat((c) => [...c, { role: "user", text: prompt }]);
    setInput("");

    // 窓を開ける。ここから `generate()` が解決するまでに来たぶんが回答。
    // **開けた世代ごと持つ**ので、世代が替われば明示的に閉じなくても無効になる
    const open: GenerationWindow = { token: mine, text: "" };
    windowRef.current = open;
    setStreaming("");
    setGenerating(true);

    void requester
      .generate(prompt)
      .then(() => {
        if (!mine.isCurrent()) return; // 世代が替わっている。この回答はもう宛先がない
        if (open.text) setChat((c) => [...c, { role: "assistant", text: open.text }]);
      })
      .catch((error: unknown) => {
        // 世代交代でRuntimeを畳んだことによる中断は**障害ではない**。エラー画面にすると
        // 正常な再編成が失敗に見える。中断の見せ方は再編成の表示(generation_aborted)に任せる
        if (!mine.isCurrent() || error instanceof GenerationSupersededError) return;
        dispatch({ type: "failed", message: describeError(error) });
      })
      .finally(() => {
        // 自分が開けた窓だけ畳む。持ち主でなくなっていれば画面には触らない —
        // 初期化は世代交代の描画中のそろえ、または現行世代の失敗の drain で済んでいる
        if (windowRef.current === open) windowRef.current = null;
        if (!mine.isCurrent()) return;
        resetGenerationState();
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
