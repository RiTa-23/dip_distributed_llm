import type { WebrtcSignalMessage } from "@dip_distributed_llm/shared-types/messages";
import {
  bindChannel,
  createCandidateQueue,
  attachIceDiagnostics,
  defaultPeerConnectionFactory,
  describeError,
  toCandidateInit,
  unbindChannel,
  unbindConnection,
} from "./session";
import type { CandidateQueue, SessionOptions, WebrtcSession } from "./session";

type Connection = {
  pc: RTCPeerConnection;
  channel: RTCDataChannel;
  candidates: CandidateQueue;
  open: boolean;
  /** 経路ログの後始末。畳むときに呼ぶ */
  detachDiagnostics: () => void;
};

/**
 * requester側のセッション。`generation_start` の顔ぶれ全員へofferを出す。
 * peer同士は繋がないので、ここが星型の中心になる(AGENTS.md 前提1)。
 */
export function createRequesterSession({
  generation,
  myId,
  send,
  callbacks,
  createConnection = defaultPeerConnectionFactory,
}: SessionOptions): WebrtcSession {
  const connections = new Map<string, Connection>();
  let disposed = false; // teardown か first-fatal で true。以降このセッションからは何も出ない

  const signal = (targetId: string, payload: WebrtcSignalMessage["payload"]) => {
    send({ type: "webrtc_signal", targetId, fromId: myId, payload });
  };
  /**
   * 受け口を外して全接続を**物理的に**閉じる。**冪等**。
   * close()の後にもイベントは飛ぶので、閉じる前に必ず外す。
   *
   * 論理的な terminal 化(`disposed = true`)はここに含めない。回線を壊す前に
   * 世代を失効させる必要があり、両者を1つにすると順序を選べなくなるため
   * (`fatalFail` を参照)。
   */
  const shutdownConnections = () => {
    for (const entry of connections.values()) {
      entry.detachDiagnostics();
      unbindChannel(entry.channel);
      entry.channel.close();
      unbindConnection(entry.pc);
      entry.pc.close();
    }
    connections.clear();
  };

  /**
   * この世代を致命傷として畳む。**requesterでは失敗の種類を問わずここ1回だけ通る。**
   *
   * RPC deviceは起動時の `-rpc` 引数で固定されるので、1本でも失われた時点でこの世代は
   * 続行不能。close / connectionState failed / SDP・ICEの失敗を区別する意味がない。
   *
   * **順序が契約**。B-2 の ownership の原則(所有権を手放してから壊す)を最後まで崩さない:
   *
   *   1. `disposed = true`      … Sessionを**論理**terminalにする。以降 late な
   *                               onOpen / onData / signaling / ICE は即遮断される。
   *                               ここが「1回だけ」も同時に成り立たせている門
   *   2. `onClose`              … `usePeerManager` の fence(世代トークンの失効)→
   *                               旧 manager の通知停止 → 論理接続の破棄
   *   3. `shutdownConnections`  … **そのあとで** DataChannel / RTCPeerConnection を閉じる
   *   4. `onFailed`             … 画面の初期化(drain)と `generation_failed`
   *
   * 2を3より先に置くのが要点。物理回線を先に閉じると、**まだ owner token が current で
   * Manager も現行のまま**の瞬間に相手側の回線が消える。`stop()` は termination proof に
   * ならず旧Runtimeは pthread 側で並行に動きうるので、その瞬間に send/recv が失敗を
   * 観測して現行世代へ流れ込む余地が残る。1で論理的に閉じてあれば、この窓は開かない。
   *
   * 2を4より先に置くのは、畳む前の旧Runtimeが現行の持ち主のまま画面に触れないため。
   *
   * 別に `fatal` フラグを持たないのは、`disposed` と二重の門になり、片方がテストで
   * 固定できない飾りになるため。守るものは1つにしてある(`session.test.ts`)。
   *
   * 1が要る理由: 呼び出し側の世代番号(`useWebrtcSignaling` の `generationRef`)は
   * 次の `generation_start` まで動かないので `isStaleForCurrent` は素通しする。
   * 受け口を残すと、**2でmintされたばかりの新しいPeerManagerへ、死んだ世代の回線が
   * attachされてしまう**(遅れて開くDataChannel、遅れて届くRPC応答、遅れて成立するsignaling)。
   */
  const fatalFail = (peerId: string, message: string) => {
    if (disposed) return;
    disposed = true;
    callbacks.onClose(generation, peerId);
    shutdownConnections();
    callbacks.onFailed(generation, peerId, message);
  };

  const connect = (peerId: string) => {
    const pc = createConnection();
    // DataChannelはofferを出す側が作る。peer側は ondatachannel で受け取る
    const channel = pc.createDataChannel("rpc");
    const entry: Connection = {
      pc,
      channel,
      candidates: createCandidateQueue((candidate) => {
        // 相手の候補が**届いているか**を見る(`[webrtc]` で絞れる)。
        // 1件も出なければシグナリング側の問題で、届いているのに繋がらないなら経路側。
        // TURNを足すかどうかの判断がここで割れるので、成功時だけ報告する
        // `attachIceDiagnostics` とは別に、候補そのものを残しておく
        console.log(`[webrtc] remote candidate peer=${peerId} ${candidate.candidate ?? ""}`);
        void pc
          .addIceCandidate(candidate)
          .catch((e: unknown) => fatalFail(peerId, describeError(e)));
      }),
      open: false,
      detachDiagnostics: attachIceDiagnostics(pc),
    };
    connections.set(peerId, entry);

    bindChannel(channel, {
      onOpen: () => {
        if (disposed) return;
        entry.open = true;
        callbacks.onOpen(generation, peerId, channel);
        callbacks.onChange();
      },
      // **予期しないcloseはその世代の失敗**。RPC deviceは固定なので1本失えば続行不能。
      // `teardown()` も `fatalFail()` も受け口を外してから閉じるので、ここへは来ない
      onClose: () => {
        if (disposed) return;
        fatalFail(peerId, `${peerId} との回線が切れました`);
        callbacks.onChange();
      },
      // 世代の判定は呼び出し側(useWebrtcSignaling)。ここは通り道だけ用意する
      onData: (data) => {
        if (disposed) return;
        callbacks.onData(generation, peerId, data);
      },
    });

    pc.onicecandidate = (e: RTCPeerConnectionIceEvent) => {
      if (disposed || !e.candidate) return;
      // 自分側に集まった候補の種類を見る。**host しか出なければ direct 専用**で、
      // 端末間が直接通れないLANでは繋がらない(= TURNが要る)。TURNを設定していれば
      // `type=relay` が出るはずで、出なければTURNへ到達できていない
      console.log(
        `[webrtc] local candidate peer=${peerId} type=${e.candidate.type} protocol=${e.candidate.protocol} address=${e.candidate.address ?? "?"}`,
      );
      signal(peerId, { kind: "ice-candidate", candidate: e.candidate.toJSON() });
    };

    // checking のまま止まるのか failed まで行くのかで、経路が無いのか遅いだけなのかが割れる。
    // `CONNECT_STALL_MS`(10秒)はICEが諦めるより先に切るので、サーバのログだけでは
    // 「時間切れ」としか分からない。ICE自身の判定はここにしか残らない
    pc.oniceconnectionstatechange = () => {
      if (disposed) return;
      console.log(`[webrtc] iceConnectionState peer=${peerId} → ${pc.iceConnectionState}`);
    };

    pc.onconnectionstatechange = () => {
      if (disposed) return;
      if (pc.connectionState === "failed") {
        // TURNを設定していればrelayもICE候補になり得るので、direct限定の文言にしない。
        // (「directもrelayも全部試した」とは限らない — TURNへ到達できず relay candidate
        //  そのものを取れなかった場合も、最終的にはここへ来る)
        fatalFail(peerId, `${peerId} との接続に失敗しました`);
      }
      callbacks.onChange();
    };

    void (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (disposed) return;
        const sdp = pc.localDescription?.sdp ?? offer.sdp;
        if (typeof sdp !== "string") {
          fatalFail(peerId, "offerのSDPを作れませんでした");
          return;
        }
        signal(peerId, { kind: "offer", sdp });
      } catch (e: unknown) {
        if (disposed) return;
        fatalFail(peerId, describeError(e));
      }
    })();
  };

  const handleAnswer = (msg: WebrtcSignalMessage) => {
    const entry = connections.get(msg.fromId);
    if (!entry) return;
    const sdp = msg.payload.sdp;
    if (typeof sdp !== "string") return;
    void (async () => {
      try {
        await entry.pc.setRemoteDescription({ type: "answer", sdp });
        if (disposed) return;
        // remoteDescriptionが入るまで溜めていた分をここで流す
        entry.candidates.open();
        callbacks.onChange();
      } catch (e: unknown) {
        if (disposed) return;
        fatalFail(msg.fromId, describeError(e));
      }
    })();
  };

  return {
    generation,

    start: (peerIds) => {
      if (disposed) return;
      for (const peerId of peerIds) {
        // 自分自身と、既に張ってある相手は飛ばす
        if (peerId === myId || connections.has(peerId)) continue;
        connect(peerId);
      }
      callbacks.onChange();
    },

    accept: (msg) => {
      if (disposed) return;
      switch (msg.payload.kind) {
        case "answer":
          handleAnswer(msg);
          return;
        case "ice-candidate": {
          const entry = connections.get(msg.fromId);
          if (!entry) return;
          const candidate = toCandidateInit(msg.payload.candidate);
          if (candidate) entry.candidates.push(candidate);
          return;
        }
        case "offer":
          // requesterは常にofferを出す側。星型なので受け取ることはない
          return;
      }
    },

    openIds: () => {
      const ids: string[] = [];
      for (const [peerId, entry] of connections) {
        if (entry.open) ids.push(peerId);
      }
      return ids;
    },

    expectedIds: () => [...connections.keys()],

    teardown: () => {
      disposed = true;
      shutdownConnections();
    },
  };
}
