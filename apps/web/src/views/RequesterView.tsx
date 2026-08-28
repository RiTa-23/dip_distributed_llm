import { useEffect, useRef, useState } from "react";
import { TopBar } from "../components/TopBar";
import { LayerBar } from "../components/LayerBar";
import { ProgressBar } from "../components/ProgressBar";
import { DevPanel } from "../components/DevPanel";
import { JoinQr } from "../components/JoinQr";
import { useCluster } from "../hooks/useCluster";
import { useStalled } from "../hooks/useStalled";
import { useWebrtcSignaling } from "../hooks/useWebrtcSignaling";
import { usePeerManager } from "../hooks/usePeerManager";
import { GenerationSupersededError, useRequesterRuntime } from "../hooks/useRequesterRuntime";
import { createGenerationOwner } from "../webrtc/generationOwner";
import type { GenerationToken } from "../webrtc/generationOwner";
import { createAcceptingSignal } from "../hooks/requesterAccepting";
import { getClientId } from "../lib/clientId";
import { CONNECT_STALL_MS } from "../config";
import type { Phase } from "../types/cluster";
import styles from "./RequesterView.module.css";

type ChatEntry = { role: "user" | "assistant"; text: string };

/**
 * llama.cppへ渡す n_ctx(`-c`)。
 *
 * `main.cpp` は `n_batch` を `n_ctx` に縛っているため、この値はprefillの
 * compute bufferの大きさを直接決め、その buffer は peer に載る。モデルが宣言する
 * context長(Qwen3.6なら262144)は「対応上限」であって使う義務はないので、
 * メモリの変数を減らすために明示的に小さく固定する。
 *
 * ⚠️ promptのUTF-8バイト長はこの値より**厳密に小さい**必要がある(Runtime側が検証して投げる)。
 */
const CONTEXT_SIZE = 2048;

/**
 * トースト1件ぶんの中身とトーン(#68)。「人が増えた」は嬉しい出来事、
 * 「誰か落ちた」は残念な出来事なので、同じ扱いにしない。編成完了などの
 * 単なる進行の合図は info(装飾なし)にする
 */
type Toast = { text: string; tone: "info" | "joyful" | "calm" };

const NOTICE: Partial<Record<Phase, string>> = {
  idle: "サーバーに接続していません",
  preparing: "参加者がそろうのを待っています",
  waiting: "編成が組まれるのを待っています",
  connecting: "参加者へモデルを配っています",
  reorganizing: "メンバーが変わったため再編成しています",
  error: "接続に失敗しました",
};

/**
 * 配布中が長引いたときの案内(#78)。`NOTICE.connecting` を差し替える形で出す。
 * 起きていることは「繋がらない参加者を待つのをやめて組み直しを頼んだ」なので、
 * 配布中の文言のままでは何も起きていないように見える
 */
const CONNECT_STALL_NOTICE = "接続できない参加者がいます。編成を組み直しています";

/**
 * 全員解除の2段押しで、1回目の押下が有効なままでいる時間(#114)。
 *
 * 押したことを忘れるほど長くはせず、続けて押すには足りる長さにする。
 * armed のまま放置されると、あとの1クリックが解除になってしまう
 */
const DISMISS_ARM_MS = 4000;

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

/** 発表者側のチャットUIと、参加者の接続・再編成状態を表示する。 */
export function RequesterView() {
  // useCluster が初期状態に取り込むので、先に決めておく
  const [myId] = useState(() => getClientId("requester"));
  const { state, dispatch, send, lastMessage, assignments, debug, model, modelSettled } =
    useCluster({
      enabled: true,
      myId,
      role: "requester",
    });
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [streaming, setStreaming] = useState("");
  const [generating, setGenerating] = useState(false);
  const [computingIndex, setComputingIndex] = useState<number | null>(null);
  const [input, setInput] = useState("分散推論のしくみを一言で教えて");
  // ローカルのGGUF。選ばれていればHono配信のかわりにこれを使う。
  // 12.93GBのようなモデルをURL経路で読むと、chunkが順にIndexedDBへ溜まって
  // ディスクを二重に使う(Runtime側のF4/F26)。File経路ならそれが要らない
  //
  // **「選んだファイル」と「今Runtimeに載っているファイル」を分けて持つ。**
  // 1つにまとめると、選んだ瞬間に `modelFile` が変わり、別の理由(参加者の増減)で
  // 再編成が走ったときに意図せず新しいモデルが載ってしまう。載せ替えは
  // 「適用」を押したときだけに限る
  const [pickedModelFile, setPickedModelFile] = useState<File | null>(null);
  const [appliedModelFile, setAppliedModelFile] = useState<File | null>(null);
  const activeModelName = appliedModelFile?.name ?? model.name;
  /** 選んだが、まだ載せていない */
  const modelPending = pickedModelFile !== null && pickedModelFile !== appliedModelFile;
  const toastTimer = useRef<number | null>(null);

  // 会話が伸びても入力欄は固定になったので、ログ側を最新まで追従させる(#105)。
  // 送信時・ストリーミング中は自動で最下部へスクロールする。ただしユーザーが
  // 過去を読んでいるときに勝手に動かすと邪魔なので、下端付近にいるときだけ追従する
  const logRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);

  const handleLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  useEffect(() => {
    const el = logRef.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [chat, streaming, generating]);

  // 生成の窓。**Runtimeの `onText` には起動時のstdoutも流れてくる**ので、
  // generateを呼んだ前後で区切って、そのあいだに来たぶんだけを回答として扱う。
  // stateではなくrefなのは、onTextが再描画と無関係に高頻度で呼ばれるのと、
  // stateだとクロージャが古い値を掴むため
  const windowRef = useRef<GenerationWindow | null>(null);
  const previousRosterSize = useRef(state.roster.length);
  const previousConnectStalled = useRef(false);
  // `requester_accepting` の送り直しを決める edge 検出。**描画をまたいで1つ**でないと
  // 毎描画で初期値に戻り、edge として機能しない(`hooks/requesterAccepting.ts`)
  const [acceptingSignal] = useState(() => createAcceptingSignal());
  const [toast, setToast] = useState<Toast | null>(null);
  /** 全員解除の2段押し。1回目で立ち、DISMISS_ARM_MS 経つか実行すると倒れる(#114) */
  const [dismissArmed, setDismissArmed] = useState(false);
  /** 1回目を押した時点の顔ぶれ。確認はこの顔ぶれに対するもので、変われば効力を失う */
  const [dismissArmedFor, setDismissArmedFor] = useState("");
  const dismissTimer = useRef<number | null>(null);

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
  // Runtime adapterの `onText` で、スタブが混ざると判定にならない。
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
    // これとは別に、下の `connectStalled` からも `generation_failed` を送る。あちらは
    // 「相手が黙ったままでICEが諦めるのを待つと30秒以上かかる」ケースの保険で、重複では
    // ない(2通目はHono側が `phase !== "active"` / 世代不一致で捨てる)。
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
    // ローカルのGGUFが「適用」されていればそちらを使う。無ければ従来どおりHono配信。
    //
    // 読まれるのはRuntimeを立てる瞬間の値(世代が始まったとき)。選び直しただけでは
    // 走っている世代に効かないので、`model_changed` を送って新しい世代を始める
    // (下の `applyModel`)。ここが `picked` ではなく `applied` を見るのはそのため
    model: appliedModelFile
      ? { kind: "file", file: appliedModelFile }
      : { kind: "url", url: `/models/${model.name}` },
    // n_ctx。`main.cpp` は `n_batch` を `n_ctx` に縛っているので、この値は
    // prefillのcompute bufferの大きさを直接決め、それはpeerに載る。モデルが宣言する
    // 上限(Qwen3.6なら262144)は「使ってよい上限」であって使う義務はない
    args: ["-c", String(CONTEXT_SIZE)],
    // `/model-info` の確定を待ってからRuntimeを起動し、仮置きモデル名で立ち上がらないようにする(#65)
    modelSettled,
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

  // 送信できるのは**Runtimeのreadyが解決してから**。作り物の進捗では判断しない。
  //
  // develop 側には「モデル本体はまだ推論に使われていないので、取得に失敗しても送信を
  // ブロックしない」という判断があったが、**B-1 でその前提は失効した**。いまの
  // `requester.ready` は「Runtimeがモデルを載せ終えてgenerateできる」の意味で、ここを
  // 外すと `generate()` が「Runtimeがまだ起動していません」を投げる
  const modelReady = requester.ready;
  const modelProgress = modelReady ? 1 : 0;
  const canSubmit = phase === "active" && modelReady && !generating;

  /**
   * 選んだモデルを載せる。
   *
   * requester Runtimeは世代の開始時にモデルを掴んで離さないので、**新しい世代を
   * 始めない限り差し替えが効かない**。Honoに `model_changed` を送って同じ顔ぶれの
   * まま組み直させ、その新しい世代で `appliedModelFile` が読まれる。
   *
   * 状態を先に進めるのは、`generation_start` を受けてRuntimeが立つときには
   * もう新しい値が入っている必要があるため。組み直しに失敗しても、次に世代が
   * 始まったときに新しいモデルで立ち上がる(取り残されない)。
   *
   * 生成中でも押せる。走っている生成は中断されるが、それは「今すぐ別のモデルを
   * 見せたい」という操作の当然の結果。
   */
  const applyModel = () => {
    if (!modelPending) return;
    setAppliedModelFile(pickedModelFile);
    // 編成が組まれていなければ送っても捨てられる。次の世代で新しい値が読まれるので
    // これで足りる(サーバ側も phase !== "active" は無視する)
    if (phase === "active") send({ type: "model_changed", generation: rtc.generation });
  };

  /**
   * 2段押しの効力(#114)。**効果ではなく描画中に導く。** 参加者が入れ替わったり
   * 0人になったりしたら、押した時点の顔ぶれに対する確認ではなくなるので落とす
   * (ボタンは disabled になり、「もう一度押すと解除」の表示だけが残ってしまう)
   */
  const rosterKey = state.roster.map((p) => p.clientId).join(",");
  const dismissArmedNow = dismissArmed && dismissArmedFor === rosterKey && rosterKey !== "";

  /**
   * 参加ピアを全員降ろす(#114)。1回目の押下では実行せず、armed にして待つ。
   *
   * 元に戻すには参加者全員に参加し直してもらうしかないので、モデルの載せ替え
   * (上の `applyModel`、押す前に影響を文章で見せる形)より強い歯止めを置く。
   *
   * ここで画面は動かさない。ロスターを空にするのもフェーズを戻すのもHonoが返す
   * `peers_dismissed` で、サーバが唯一の出口という形は他の操作と揃える
   */
  const dismissPeers = () => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    if (!dismissArmedNow) {
      setDismissArmed(true);
      setDismissArmedFor(rosterKey);
      // 押しっぱなしで放置された armed が、あとの誤クリックで実行にならないよう
      // 時間で倒す
      dismissTimer.current = window.setTimeout(() => setDismissArmed(false), DISMISS_ARM_MS);
      return;
    }
    dismissTimer.current = null;
    setDismissArmed(false);
    send({ type: "dismiss_peers" });
  };

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

  // 配布中が続くのは、answerを返さないまま黙っている参加者が居るとき。ICEが
  // 諦めるのを待つと30秒以上かかるので、時間で見切ってHonoに編成のやり直しを頼む
  // (#78の実機確認)。`useStalled` は watching が false を通ると測り直すので、
  // 世代をまたいで経過を持ち越さない
  const connectStalled = useStalled(phase === "connecting", CONNECT_STALL_MS);

  // false→true に変わった1回だけ送る。
  //
  // ここでフェーズは動かさない(`dispatch({ type: "failed" })` はしない)。時間切れで
  // 画面が勝手に別のフェーズへ移ると、遅れて届いた generation_start と食い違う。
  // 動かすのはHonoが返す generation_aborted で、サーバが唯一の出口という形は変えない。
  // 古い世代の時間切れは applyGenerationFailed が世代番号を見て捨てる
  useEffect(() => {
    if (previousConnectStalled.current === connectStalled) return;
    previousConnectStalled.current = connectStalled;
    if (!connectStalled) return;
    send({ type: "generation_failed", generation: state.generation });
  }, [connectStalled, send, state.generation]);

  // 推論中は新規peerの加入による再編成を保留させる(#50)。生成の開始・終了は
  // 送信ボタン・generateの解決・世代交代の初期化・現行世代の失敗によるdrainと複数の
  // 経路から起きるので、発生源を1箇所に絞れる generating の変化を見て送る。
  //
  // **drain のぶんも同じ口を通す。** 通さないと `accepting: false` を送ったきりになり、
  // Hono が新規peerを永久に取り込めなくなる
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
    // 増えたか減ったかだけで見せ方を分ける(#68)。理由の詳細はabortMessage側の
    // トーストが別途出すので、ここは台数の増減という事実だけを見る
    setToast({
      text: `${previousSize}台→${currentSize}台に更新`,
      tone: currentSize > previousSize ? "joyful" : "calm",
    });
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, [state.roster.length]);

  useEffect(() => {
    const message = state.abortMessage;
    if (!message) return;

    if (toastTimer.current) clearTimeout(toastTimer.current);
    // 再編成のきっかけが「人が増えた」ことなら祝い、それ以外(誰かが抜けた・
    // 繋がらなかった)は落ち着いた見せ方に留める(#68)
    setToast({
      text: message,
      tone: state.abortReason === "peer_joined" ? "joyful" : "calm",
    });
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, [state.abortMessage, state.abortReason]);

  useEffect(() => {
    if (!lastMessage || lastMessage.type !== "generation_start") return;
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text: "編成が完了しました", tone: "info" });
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, [lastMessage]);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
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
  const notice = phase === "connecting" && connectStalled ? CONNECT_STALL_NOTICE : NOTICE[phase];
  // NOTICEは`active`を持たない(伝えることが無いので箱ごと消す)。読み上げ用は
  // 箱の有無に関わらず7フェーズすべてを伝えたいので、その1件だけ別に補う(#66)
  const phaseAnnouncement =
    phase === "active" ? "接続済みです。プロンプトを送れます" : (notice ?? "");

  return (
    <div className={styles.page}>
      {/*
        画面の状態(NOTICEと同じ文言)を読み上げるためだけの領域。`.notice` は
        `active` のとき箱ごと消えるため、見た目とは別に常時マウントしたここへ集約する。
        テキストが実際に変わったときしかDOMが動かないので、連呼にはならない(#66)
      */}
      <div className={styles.srOnly} aria-live="polite" aria-atomic="true">
        {phaseAnnouncement}
      </div>

      <TopBar
        left={
          <>
            第{state.generation}世代 · 接続 {state.roster.length}人 ·{" "}
            <span className={styles.mono}>{activeModelName}</span>
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
            <div className={styles.sectionHead}>
              <div className={styles.sectionLabel}>PEERS</div>
              {/*
                参加ピアの一括解除(#114)。**2段押しにする。** 参加者全員を巻き込む
                うえ、戻すには全員に参加し直してもらうしかないので、1クリックで
                起きてよい操作ではない。armed のあいだだけ実行に進む
              */}
              <button
                type="button"
                className={`${styles.dismiss} ${dismissArmedNow ? styles.dismissArmed : ""}`}
                disabled={state.roster.length === 0}
                onClick={dismissPeers}
              >
                {dismissArmedNow ? "もう一度押すと解除" : "全員解除"}
              </button>
            </div>
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
            {/*
              進捗の実測(#80 の `useModelDownload`)はここへ繋いでいない。**Runtimeが
              同じGGUFを自分で取りに行くので、繋ぐと491MBを二重に引く**(B-1以降)。
              いまはRuntimeのreadyだけを見せる。実測の進捗を出すなら、Runtime側が
              ダウンロードの進捗を報せられるようになってから繋ぐ
            */}
            <ProgressBar value={modelProgress} label="モデルのダウンロード" />
            <div className={styles.dim}>
              {modelReady ? "読み込み済み" : "Runtimeの準備を待っています"}
            </div>
            {/*
              ローカルのGGUFを直接渡す口。大きいモデルをHono配信で読むと、chunkが
              IndexedDBへ溜まってディスクを二重に使う(Runtime側のF4/F26)。
              選ばなければ従来どおり `/models/` から取る。

              **選ぶことと載せることを分けてある。** requester Runtimeは世代の開始時に
              モデルを掴んで離さないので、載せ替えには新しい世代が要る。選んだだけで
              組み直すと、参加者を巻き込む操作が誤クリックで起きてしまう
            */}
            <label className={styles.dim}>
              ローカルのGGUFを使う(任意)
              <input
                type="file"
                accept=".gguf"
                onChange={(e) => setPickedModelFile(e.currentTarget.files?.[0] ?? null)}
              />
            </label>
            <div className={styles.dim}>
              {appliedModelFile
                ? `ローカル: ${appliedModelFile.name}`
                : "配信されているモデルを使います"}
            </div>
            {modelPending && (
              <div className={styles.dim}>
                <button type="button" onClick={applyModel}>
                  {pickedModelFile?.name} を載せる
                </button>
                {/*
                  何が起きるかを押す前に見せる。参加者を巻き込むうえ、生成中なら
                  途中の回答が消えるので、黙って実行してよい操作ではない
                */}
                <div>
                  {state.roster.length > 0
                    ? `参加者${state.roster.length}台を巻き込んで編成を組み直します`
                    : "編成を組み直します"}
                  {generating && "。表示中の回答は中断されます"}
                </div>
              </div>
            )}
          </div>

          <div>
            <div className={styles.sectionLabel}>全体</div>
            <LayerBar
              totalLayers={model.totalLayers}
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
            <div
              className={`${styles.toast} ${toast.tone === "joyful" ? styles.toastJoyful : toast.tone === "calm" ? styles.toastCalm : ""}`}
              role="status"
            >
              {toast.text}
            </div>
          )}
          {notice && <div className={styles.notice}>{notice}</div>}
          {phase === "error" && state.errorMessage && (
            <p className={styles.errorDetail}>{state.errorMessage}</p>
          )}
          <div className={styles.log} ref={logRef} onScroll={handleLogScroll}>
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
