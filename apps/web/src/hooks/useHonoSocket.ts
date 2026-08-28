import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, ServerMessage } from "@dip_distributed_llm/shared-types/messages";
import type { HonoSocket, SocketOptions } from "../types/socket";
import { parseServerMessage } from "../lib/parseServerMessage";
import { buildWsUrl } from "../lib/wsUrl";
import { WS_PATH, WS_URL_OVERRIDE } from "../config";

/**
 * 再接続までの待ち時間。最後の値で頭打ちにする。
 * ②がサーバを再起動しても、画面を開き直さずに戻ってこられるようにするためで、
 * 会場で参加者に「リロードしてください」と言って回らずに済む。
 */
const RETRY_MS = [250, 500, 1000, 2000, 4000];

/**
 * 待ち時間に混ぜる散らばりの幅(±30%)。
 * 固定値のままだと、サーバの再起動で一斉に切れた全員が同じ時刻に叩き直し、
 * 起動直後のHonoに山が立つ。人数が増えるほど効く
 */
const JITTER = 0.3;

function nextWait(retry: number): number {
  const base = RETRY_MS[Math.min(retry, RETRY_MS.length - 1)];
  return base * (1 - JITTER + Math.random() * JITTER * 2);
}

// 受信は1件ずつ流す。`lastMessage` は1枠しかないので、描画される前に次を入れると
// 間の1件が誰にも観測されないまま消える(下の「次を流すのは commit のあと」を参照)。

/**
 * Honoの制御プレーン(`/ws`)への接続。
 * 返り値の形は useHonoSocket.mock.ts と完全に同じで、useCluster から見ると区別がつかない。
 *
 * このフックが持つのは接続と受け渡しだけで、フェーズの判断は一切しない。
 * 状態遷移のルールは clusterReducer.ts に閉じている。
 */
export function useHonoSocket({ enabled }: SocketOptions): HonoSocket {
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<ServerMessage | null>(null);
  const socket = useRef<WebSocket | null>(null);
  /** 受信の順番待ち。1件ずつ setLastMessage する */
  const queue = useRef<ServerMessage[]>([]);
  /** 流している最中かどうか。true のあいだ、次の1件は commit を待って出る */
  const flushing = useRef(false);
  /** まだ接続中(CONNECTING)のあいだに send された分。openで一度に流す */
  const outbox = useRef<string[]>([]);

  const clearQueue = useCallback(() => {
    queue.current = [];
    flushing.current = false;
  }, []);

  const emit = useCallback((msg: ServerMessage) => {
    queue.current.push(msg);
    if (flushing.current) return; // 流している最中。下の効果が続きを出す
    flushing.current = true;
    const next = queue.current.shift();
    if (next) setLastMessage(next);
  }, []);

  /**
   * 次の1件を流すのは、直前の1件が commit されたあと(#114)。
   *
   * 以前は `setTimeout(step, 0)` で刻んでいたが、**タスクを分けるだけでは足りない**。
   * Reactの描画自体もタスクなので、`setTimeout` が先に走ると commit の前に
   * `lastMessage` が上書きされ、間の1件は誰の効果からも観測されないまま消える。
   * 描画のたびに1件ずつ進めれば、この取りこぼしは原理的に起きない。
   *
   * 実害の例(#114の実機で判明): `peers_dismissed` の直後に `roster_update` が届くと、
   * 参加者画面が解除に気づかず「貢献中」のまま取り残された。
   * `generation_aborted` → `generation_start` にも同じ穴があった。
   */
  useEffect(() => {
    if (!flushing.current) return;
    const next = queue.current.shift();
    if (next) setLastMessage(next);
    else flushing.current = false;
  }, [lastMessage]);

  const send = useCallback((msg: ClientMessage) => {
    const text = JSON.stringify(msg);
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(text);
      return;
    }
    if (ws?.readyState === WebSocket.CONNECTING) {
      outbox.current.push(text);
      return;
    }
    // 切れているあいだの送信は捨てる。再接続すると connected が false→true と動き、
    // 各ビューが preparing から hello を送り直すので、古い1通を溜めても意味がない
  }, []);

  useEffect(() => {
    if (!enabled) return;

    // 後片付けが済んだ後にタイマーやイベントが走らないようにする目印。
    // 残すと、離脱したはずの画面が再接続して待機中に戻る
    let disposed = false;
    let retry = 0;
    let retryTimer: number | null = null;

    const open = () => {
      if (disposed) return;
      const ws = new WebSocket(buildWsUrl(window.location, WS_PATH, WS_URL_OVERRIDE));
      socket.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        retry = 0;
        for (const text of outbox.current) ws.send(text);
        outbox.current = [];
        setConnected(true);
      };

      ws.onmessage = (ev: MessageEvent) => {
        if (disposed) return;
        const msg = parseServerMessage(ev.data);
        // 契約に合わないフレームは捨てる。ここで例外を投げると、その接続で
        // 以降のメッセージを1件も受け取れなくなる
        if (msg) emit(msg);
      };

      ws.onclose = () => {
        if (disposed) return;
        socket.current = null;
        outbox.current = [];
        // 流し残しは捨てる。残すと socket_closed(=idle)のあとに古いソケットの
        // generation_start が届き、離脱したはずの画面が受信中へ戻る
        clearQueue();
        setConnected(false);
        const wait = nextWait(retry);
        retry += 1;
        retryTimer = window.setTimeout(open, wait);
      };

      // onerror の直後には必ず onclose が来る。再接続の予約が二重にならないよう
      // ここでは何もしない
      ws.onerror = () => {};
    };

    open();

    return () => {
      disposed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      clearQueue();
      outbox.current = [];
      const ws = socket.current;
      socket.current = null;
      if (ws) {
        // close() の後にも onclose が飛ぶ。外してから閉じないと再接続が始まる
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
      }
      setConnected(false);
      // lastMessage は消さない。useCluster は値が変わったときだけ dispatch するので、
      // 古い1件が残っていても再送はされない
    };
  }, [enabled, emit, clearQueue]);

  // debug は本物では持たない。DevPanelのROSTER側のボタンはこれを見て消える
  return { connected, lastMessage, send, debug: null };
}
