# WebRTC実装ガイド

`implementation-spec.md`のWebRTC部分の詳細。WebRTC担当(シグナリングからRPCの繋ぎ込みまで)向け。①はWASMのビルド時に「データプレーン」節を、②③④はシグナリング理解のため参照。

## シーケンス

```
requester                    Hono(/ws)                    peer
   |--- hello ------------------>|                           |
   |                             |<------------------- hello -|
   |<---- roster_update ---------|---- roster_update -------->|
   |<---- generation_start ------|---- generation_start ----->|  (peer揃ったら配信)
   |--- RTCPeerConnection作成    |                           |
   |--- createOffer()            |                           |
   |--- webrtc_signal(offer) --->|--- webrtc_signal(offer) -->|
   |                             |                           |--- setRemoteDescription(offer)
   |                             |                           |--- createAnswer()
   |                             |<-- webrtc_signal(answer) --|
   |<-- webrtc_signal(answer) ---|                           |
   |--- setRemoteDescription(answer)                          |
   |<==== ICE candidate交換(双方向、複数回) ====================>|
   |<========== DataChannel 'rpc' 開通(P2P) ====================>|
   |<========== 以降Honoを経由しない ============================>|
```

offer/answer/ICE candidateのやり取りのみHono経由。DataChannel開通後は完全P2P。

## 実装済みの構成(2026/8/25、#37)

③④(React)側は入りました。**以降のコード例は考え方の見本**で、実際のファイルは次のとおりです。

| 見本 | 実物 |
|---|---|
| `webrtc/requesterConnections.ts` | [`apps/web/src/webrtc/requesterSession.ts`](../apps/web/src/webrtc/requesterSession.ts) |
| `webrtc/peerConnection.ts` | [`apps/web/src/webrtc/peerSession.ts`](../apps/web/src/webrtc/peerSession.ts) |
| UI側での振り分け | [`apps/web/src/hooks/useWebrtcSignaling.ts`](../apps/web/src/hooks/useWebrtcSignaling.ts)(両画面共通) |

見本との違いが2つあります。

- **ICE candidateを溜める箱を挟んでいます。** 見本のように `setRemoteDescription` の解決を待たずに `addIceCandidate` を呼ぶと `InvalidStateError` で落ちます。offerよりcandidateが先に届くことはありませんが、`setRemoteDescription` が非同期なので順番待ちが要ります
- **モジュール直下の可変変数(`let pc`)を持たせていません。** 世代ごとにセッションを作り直して古い接続を確実に閉じるため、`createPeerSession` / `createRequesterSession` が状態を閉じ込めています

詳しくは `frontend.md` の「データプレーンの繋ぎ込み(ステップ4)」を参照してください。

## requester側

```ts
// apps/web/src/webrtc/requesterConnections.ts
import type { WebrtcSignalMessage } from '@dip_distributed_llm/shared-types/messages'

type SendFn = (msg: WebrtcSignalMessage) => void

const connections = new Map<string, RTCPeerConnection>()
const channels = new Map<string, RTCDataChannel>()

export function connectToPeer(peerId: string, myId: string, send: SendFn, onOpen: (peerId: string, channel: RTCDataChannel) => void) {
  const pc = new RTCPeerConnection({ iceServers: [] }) // 同一LAN内なのでSTUN/TURN不要
  connections.set(peerId, pc)

  const channel = pc.createDataChannel('rpc')
  channel.binaryType = 'arraybuffer'
  channel.onopen = () => onOpen(peerId, channel)
  channels.set(peerId, channel)

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      send({ type: 'webrtc_signal', targetId: peerId, fromId: myId, payload: { kind: 'ice-candidate', candidate: e.candidate.toJSON() } })
    }
  }

  pc.createOffer().then(async (offer) => {
    await pc.setLocalDescription(offer)
    send({ type: 'webrtc_signal', targetId: peerId, fromId: myId, payload: { kind: 'offer', sdp: offer.sdp } })
  })
}

export async function handleSignal(msg: WebrtcSignalMessage) {
  const pc = connections.get(msg.fromId)
  if (!pc) return
  if (msg.payload.kind === 'answer') {
    await pc.setRemoteDescription({ type: 'answer', sdp: msg.payload.sdp })
  } else if (msg.payload.kind === 'ice-candidate') {
    await pc.addIceCandidate(msg.payload.candidate as RTCIceCandidateInit)
  }
}
```

全peer分のDataChannelが`open`になってから①の`startWasmClient()`を呼ぶ。1人でも失敗したら`generation_aborted`相当扱いでリトライ。

```ts
const openChannels = new Map<string, RTCDataChannel>()
function checkAllReady(expectedPeerIds: string[]) {
  if (expectedPeerIds.every((id) => openChannels.has(id))) {
    // startWasmClient(openChannels)
  }
}
```

## peer側

peer側は「待ち受け」ではなく「offerが来たら応答する」役(WebRTCではどちらの端末も物理的listenポートを開かない)。

```ts
// apps/web/src/webrtc/peerConnection.ts
import type { WebrtcSignalMessage } from '@dip_distributed_llm/shared-types/messages'

type SendFn = (msg: WebrtcSignalMessage) => void
let pc: RTCPeerConnection | null = null

export async function handleOffer(msg: WebrtcSignalMessage, myId: string, send: SendFn, onDataChannel: (channel: RTCDataChannel) => void) {
  pc = new RTCPeerConnection({ iceServers: [] })
  pc.ondatachannel = (e) => {
    e.channel.binaryType = 'arraybuffer'
    onDataChannel(e.channel) // startWasmPeerServer()へ
  }
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      send({ type: 'webrtc_signal', targetId: msg.fromId, fromId: myId, payload: { kind: 'ice-candidate', candidate: e.candidate.toJSON() } })
    }
  }
  await pc.setRemoteDescription({ type: 'offer', sdp: msg.payload.sdp })
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  send({ type: 'webrtc_signal', targetId: msg.fromId, fromId: myId, payload: { kind: 'answer', sdp: answer.sdp } })
}

export async function handleIceCandidate(msg: WebrtcSignalMessage) {
  if (pc) await pc.addIceCandidate(msg.payload.candidate as RTCIceCandidateInit)
}
```

peer側`useHonoSocket`の`lastMessage`が`webrtc_signal`で`payload.kind`が`offer`なら`handleOffer`、`ice-candidate`なら`handleIceCandidate`をUI側で振り分け。

## LAN限定であることの影響

- 外部のSTUN/TURNサービスは使わない(AGENTS.md 前提6)
- ~~`iceServers: []`でよい(STUN/TURN不要)~~ → **host candidateだけでは足りないLANが実在した。**
  物理2PC・標準Chromeの実測で、SDPとhost candidateの交換まで通ったのに ICE が
  `checking → disconnected`、DTLS が `new` のまま止まった。**言えるのはここまでで、原因は未確定**
  (mDNSは類似の前例があるが、この件の原因としては確定していない)
- そのため**会場LAN内のTURN**へfallbackできるようにした。`iceTransportPolicy` は既定 `all` で、
  direct(host)とrelayの選択はICEに任せる。設定は `apps/web/.env.example` と
  `apps/web/src/webrtc/iceConfig.ts`。**3項目とも未設定なら従来どおり `iceServers: []`**
- 会場Wi-FiのAP isolation設定を事前確認(有効だと同一LAN内でも端末間通信不可)。
  TURNがあれば中継で通せる見込みだが、**未実測**

## 世代変更時の接続管理

```ts
function teardownAllConnections() {
  for (const pc of connections.values()) pc.close()
  connections.clear()
  channels.clear()
}
// generation_aborted / 新しいgeneration_start受信時に呼んでから張り直す
```

## デバッグ

- Chrome: `chrome://webrtc-internals`でICE状態・DataChannel状態を確認
- `pc.connectionState` / `pc.iceConnectionState`をログ出力
- offer/answer/ice-candidateの`targetId`到達確認はHono側ログで

### 2台の参加者で異常系を確かめる(2026/8/27、#78・#79)

「1台が接続に失敗しても、残りで世代が始まる」を1台のPCで確かめる手順です。#78・#79の受け入れ条件がこの確認を要求しています。

最初にこの手順を踏んだ時点(2026/8/27)では、最後まで進めても残りで世代が始まりませんでした。#79(参加者が `peer_status: "error"` を送る)までは通っていて、そこから先が止まっていました。原因はつまずき3に書いたとおりで、**発表者側に時間切れ(`CONNECT_STALL_MS`)を入れて解消しました**。手順そのものはそのまま受け入れ条件の確認に使えます。

**素直にやると3か所でつまずきます**(いずれも実際に踏みました)。順番に潰していきます。

#### 1. Honoを起動する

```bash
bun run --cwd apps/server dev
```

`apps/server/certs/` に `cert.pem` と `key.pem` があれば **https の 8443** で、無ければ http の 3000 で待ち受けます([`apps/server/src/index.ts`](../apps/server/src/index.ts) の `hasTls`)。起動ログの `Hono server listening on ...` で確かめてください。証明書が無ければ `bun run --cwd apps/server cert` で作れます。

#### 2. dev サーバの繋ぎ先は `VITE_HONO_WS_URL` にする

`apps/web/.env.local` を作ります(`*.local` は [`apps/web/.gitignore`](../apps/web/.gitignore) の対象なのでコミットされません)。

```dotenv
VITE_HONO_WS_URL=wss://localhost:8443/ws
```

- 中身は手順1で確かめた待ち受け先に合わせます。証明書を作らず http の 3000 で起動した場合は `ws://localhost:3000/ws` です。[`config.ts`](../apps/web/src/config.ts) の `WS_URL_OVERRIDE` はこの値をそのまま接続先にするので、スキームとポートが食い違うと繋がりません
- **つまずき1: `VITE_HONO_ORIGIN` 経由のviteプロキシは使えません。** 自己署名証明書へのWebSocketプロキシが `secure: false` を付けても完了せず、`new WebSocket('ws://localhost:5173/ws')` が `readyState = 0`(CONNECTING)のまま無応答になります
- 症状が分かりにくいのが厄介で、**画面は `idle` のまま何のエラーも出ません**。`参加する` を押しても無反応に見えます。`useHonoSocket` は接続が開くまでフェーズを動かさないためです
- WebSocketにCORSは無いので、別オリジンへ直接繋いで構いません。証明書が mkcert 由来でブラウザに信頼されていれば、これで通ります

そのうえで dev サーバを起動します。

```bash
bun run --cwd apps/web dev
```

#### 3. タブごとに別のclientIdを持たせる

- **つまずき2: 同じブラウザの2タブは同じclientIdを名乗ります。** `clientId` は [`lib/clientId.ts`](../apps/web/src/lib/clientId.ts) が `localStorage` に持ちますが、localStorage はオリジン単位なので `http://localhost:5173` を2枚開いても値は1つです
- 後から `hello` した方が Honoの `clients` Map を上書きし、**先に繋いだタブがロスターから消えます**。画面には `参加者 0人` と出るだけで、理由はどこにも出ません

各タブのコンソールで別々の値を入れてからリロードしてください。`getClientId` は保存済みの値をそのまま返すので、以後はその値で名乗ります。

```js
localStorage.setItem("dip.clientId.peer", "peer-A-test"); // もう一方は peer-B-test
location.reload();
```

発表者は `dip.clientId.requester` という別のキーなので、参加者とは衝突しません(この役割ごとの分離自体が2026/8/25の実機確認で入ったものです。経緯は `clientId.ts` の冒頭コメント)。

#### 4. 片方の参加者をわざと失敗させる

壊す側のタブで、`参加する` を押す**前に**コンソールで差し替えます。

```js
RTCPeerConnection.prototype.createAnswer = () => Promise.reject(new Error("意図的な失敗"));
```

[`peerSession.ts`](../apps/web/src/webrtc/peerSession.ts) の offer 処理が `createAnswer` の失敗を catch し、`fail()` → `onFailed` → `peer_status: "error"` の送信(#79)まで通ります。

- **つまずき3: この壊し方だと発表者側の失敗検知はすぐには起きません。** 壊した参加者は「answerを返さないまま黙る」ので、発表者の `RTCPeerConnection` は `connectionState` が `failed` になるまで(ICEが諦めるまで)何も言いません
- その間 Hono から見た `phase` は `active` のままで、`peer_status: "error"` を受けても編成を組み直せません(`applyPeerStatus` が呼ぶ `maybeStartGeneration` は idle 専用、`maybeReformForGrowth` は未参加のreadyなpeerを要求するため、どちらも空を返す)
- **つまり復帰の速さは #79 ではなく発表者側の失敗検知の速さで決まります。** これがあるので、発表者は配布中が `CONNECT_STALL_MS`(10秒)続いた時点でICEを待たずに `generation_failed` を送ります([`config.ts`](../apps/web/src/config.ts))

#### 5. 開く順番と見るべき結果

参加者2枚を先に `waiting` まで進めてから、発表者(`/requester`)を開きます。発表者が居ないと `maybeStartGeneration` が発火しないためです。

確認できること:

- 壊した側が `error` フェーズに落ち、**発表者のPEERS一覧がその参加者を `エラー` と表示する**(= `peer_status: "error"` がHonoに届いてロスターに載った)
- 発表者は一度 `connecting` / `接続 1/2人` で止まるが、**10秒(`CONNECT_STALL_MS`)で見切って `generation_failed` を送り、壊れていない側だけで第2世代が始まる**。止まっているあいだの案内は「接続できない参加者がいます。編成を組み直しています」
- 第2世代の `generation_start` を受け取った**壊した側は `connecting` へ飛ばず、`error` のまま**失敗の理由を出し続ける(編成の `peerIds` に自分が入っていないため)。`参加し直す` を押すと `waiting` まで戻り、次の再編成で編成に入る



## データプレーン: llama.cppのRPCをDataChannelに載せる

### 誰が何を持つか(2026/8/25更新)

以前は「③④はDataChannelが開くところまで、その先は①」と書いていましたが、WebRTCはシグナリングからRPCの繋ぎ込みまで一貫して1人が持つことになりました。①の担当は**WASMのビルド**(パッチ済みllama.cppをEmscriptenでコンパイルする)に絞られます。

| 範囲 | 担当 | 状態 |
|---|---|---|
| `webrtc_signal` の送受信・DataChannel確立 | WebRTC担当 | 完了(#37) |
| Hono側の `webrtc_signal` 素通し中継 | ② | 完了(#19) |
| DataChannel ↔ llama.cpp RPC の橋渡し(`PeerManager`) | WebRTC担当 | 実装済み(下記) |
| WASMのページへの読み込みと起動(`webrtc/wasmEngine.ts`) | WebRTC担当 | 実装済み(#71) |
| WASMのビルド(`llmlet-mod.js` / `.wasm`)と Runtime adapter(`llmlet-runtime.js`) | ① | 完了。Web が読むのは adapter 側 |

### llmletのどこを差し替えるか

先行事例のllmletは、WASM側(`main.cpp` とllama.cppのRPCパッチ)からJS側の `Module.PeerManager` というソケット相当のオブジェクトだけを呼びます。PeerJSはその `PeerManager` を組み立てる関数(`llmlet.js` の `newPeerManager`)の内側にしか出てきません。

**したがって、シグナリングを自前のHonoへ寄せるのにC++側の変更は要りません。** `newPeerManager` を我々のDataChannelで書き直せば済みます。それが [`apps/web/src/webrtc/peerManager.ts`](../apps/web/src/webrtc/peerManager.ts) です。

`connect()` に渡る `nodeId` は、llama.cppの `rpc_servers`(`-rpcserver` で渡すエンドポイント文字列)がそのまま来ます。ここに我々の `clientId` を入れれば繋がります。

### PeerManagerの契約

llmletの `libllmlet.js` が呼ぶ6つのメソッドです。名前・引数はそちらに合わせてあり、勝手に変えるとWASM側が動きません。

| メソッド | 意味 |
|---|---|
| `connect(nodeId, done)` | 相手へ論理接続を開き、fd(失敗は-1)を `done` で返す |
| `accept(done)` | 着信を待ち、fdを `done` で返す |
| `send(fd, data)` | 送れたバイト数を返す。fdが無ければ-1 |
| `recv(fd, len, writeCB, doneCB)` | 非同期受信。1バイトも無ければ届くまで `doneCB` を呼ばない |
| `close_connection(fd)` | 論理接続を閉じる(DataChannel自体は閉じない) |
| `register_buf(fd, ptr)` | WASM側の受信バッファの番地を控える。畳むときに `Module.release_conn` へ返す |

注意点が2つあります。

- **`accept` は-1を返してはいけません。** `accept_peer` は-1を「まだ来ていない」の番兵にして `Atomics.wait` するため、-1を書くとWASM側のスレッドが起きません(`connect` と `recv` の番兵は-2なので、そちらは-1で失敗を表せます)
- **WASM側はpthreadの上で `Atomics.wait` して待ちます。** PeerManagerのメソッドはメインスレッドへ寄せて呼ばれる(`__proxy: 'sync'`)ので、RTCDataChannelをメインスレッドに置いたままで噛み合います。これが動く前提として cross-origin isolation(COOP/COEP)が要ります(②がIssue #13で対応済み)

### DataChannel上のフレーム形式

llmlet本家はPeerJSのオブジェクト送信に頼っていますが、こちらは生のRTCDataChannelなので枠を自前で決めています。両端とも我々のコードなので本家と互換である必要はありません。

```text
[0]    コマンド1バイト   0x01 connect / 0x02 accepted / 0x03 data / 0x04 close
[1..]  本文(dataのときだけ)
```

DataChannelは既定で順序保証つきの信頼配送なので、1メッセージ=1フレームでよく、長さ接頭辞は要りません。本文は64KiBからヘッダ1バイトを引いた大きさで分割します(SCTPの相互運用で安全に通るのが64KiB)。

受信側は論理接続ごとに溜まったバイト数を数えていて、上限(既定256MiB)を超えたらその接続を畳みます。相手がrecvより速く送り続けたときに、タブがヒープを食い潰して落ちるのを避けるためです。落ちると何が起きたか分からなくなるので、その手前でエラーとして表に出します。通常の転送では踏まない大きさにしてあります。

llama.cppのC側はソケットの開閉を頻繁に繰り返しますが、1本のDataChannelの上を論理接続が**直列に**使い回す形になるため、同時に生きる論理接続は相手1人につき1本だけです。

### 送信の水位(バックプレッシャー)

**書き込む前に必ず `bufferedAmount` を見ます。** Chromeは `bufferedAmount` が16MiBに達すると `send()` が `OperationError: RTCDataChannel send queue is full` を投げます(Chrome 141で実測。チャンネル自体は開いたまま残り、投げられたフレームだけが落ちます)。llama.cppが `send_peer` 1回で渡してくる大きなテンソルをそのまま書き続けると、本番のモデル配布で真っ先にここを踏みます。

- 8MiB(`SEND_HIGH_WATER`)以上溜まっているあいだは書かず、回線ごとのキューへ積みます
- 再開は `bufferedamountlow`(閾値4MiB)で拾います。イベントを持たない相手のために50ms間隔の見直しも併走させ、止まっているあいだだけ回します
- キューは**回線ごとに1本**です。論理接続ごとに分けると、CLOSEがDATAを追い越して届く順番が起こりえます
- 積めるのは1回線あたり64MiB(`MAX_SEND_QUEUE_BYTES`)までです。超えたぶんは `send()` の戻り値を短くして返します(ソケットの部分送信と同じ扱い)。制御フレーム(1バイト)はこの上限の外です。CLOSEを落とすと相手の論理接続が残り、ACCEPTEDを落とすと相手が待ち続けるためです

`send()` は、水位で止まっているぶんもこちらのキューへ写したうえで**全量を受け取ったものとして返します**。llmletの `send_peer` は `Atomics.wait` を使わない同期呼び出しで、戻り値をそのままC側へ返すだけなので、部分送信を送り直すかどうかはC側の作り次第です。常用パスをその作りに依存させないための扱いで、短い値を返すのはキューまで埋まったときだけです。

畳むときの扱いは2通りに分かれます。`close_connection()` は積んであるDATAの後ろにCLOSEを並べ、送り残しを出し切ってから閉じます。相手が落ちた・世代が変わった(`detach` / `close`)ときは送り残しを捨てます。残したまま流すと、相手が開き直した次の論理接続に前の中身が混ざるためです。

### React側への繋ぎ込み

`PeerManager` は接続を張りません。既に開いたDataChannelを受け取って、その上に載るだけです。繋ぎ込みは [`hooks/usePeerManager.ts`](../apps/web/src/hooks/usePeerManager.ts) にまとめてあり、両画面から同じ2行で使います。

```ts
const rpc = usePeerManager({ onError: (message) => dispatch({ type: "failed", message }) })

const rtc = useWebrtcSignaling({
  // ...
  ...rpc.handlers,
})
```

`rpc.handlers` の中身と、それぞれが繋がる先:

| コールバック | 呼ばれるとき | PeerManager側 |
| --- | --- | --- |
| `onOpen(remoteId, channel)` | DataChannelが開いた | `attach` |
| `onData(remoteId, data)` | フレームが届いた | `handleMessage` |
| `onClose(remoteId)` | その相手のDataChannelが閉じた | `detach` |
| `onReset()` | 世代が変わった・離脱した | `close` |

`onClose` と `onReset` は、この繋ぎ込みのために `useWebrtcSignaling` へ足したものです。**どちらも省くとWASM側が止まります。** 相手が落ちたのに論理接続を畳まないと、`recv` で待っているpthreadを起こす者がいなくなり、`Atomics.wait` から戻れません。2つに分かれているのは、`teardown()` がDataChannelの受け口を外してから閉じるため、世代交代では `onclose` が飛んでこないからです。

世代が変わったときの破棄判定は `useWebrtcSignaling` 側で済んでいるので、古い世代のデータが `handleMessage` まで来ることはありません。`onClose` にも同じ判定を入れてあり、古い世代の接続が遅れて閉じても、同じ相手との現行の接続を巻き添えにしません。

`PeerManager` の実体はマウント中ずっと同じものです。一度 `Module.PeerManager` に載せた後で差し替える手段がないため、世代が変わっても作り直さず `close()` で畳んで使い回します。

そのため **`close()` は `accept` の待機だけ持ち越します。** peerはRPCサーバー役なので、繋がる前から `accept` で待っていることがあります。世代交代でその待機を消すと `done` を呼ぶ者がいなくなり、WASM側は `Atomics.wait` から戻れません。次の世代のCONNECTが来ても待機者がいないので `readyFds` に積まれるだけで、pthreadは `accept` の中に閉じ込められたままになります。llama.cpp側の `accept` に世代の区別はなく「次の相手を待つ」以上の意味を持たないので、持ち越して困ることはありません。

### WASMの代役スタブで確認したこと(2026/8/25、#44)

Runtime が来る前に、**C側と同じ呼び方をする代役**([`webrtc/rpcStub.ts`](../apps/web/src/webrtc/rpcStub.ts))を書いて、橋渡しの側だけ先に確定させてあります。真似ているのは手続き(`accept` → `recv`(ヘッダ) → `recv`(本体) → `send`(応答))であって中身の意味ではありません。C側と揃えてあるのは次の2点です。

- `recv` は要求したぶんが一度に来るとは限らないので、集まるまで繰り返す(llama.cppの `recv_data` と同じ)
- `send` の戻り値が短ければ残りを送り直す(同 `send_data`。送信キューが埋まったときにここが効く)

確認は2通りあります。

1. **`bun test`**(`rpcStub.test.ts`): 偽のDataChannelで往復・開き直し・詰まった回線での送り直しを見ます。CIで回ります
2. **実機**: 開発中だけ生えるコンソールの口([`webrtc/rpcConsole.ts`](../apps/web/src/webrtc/rpcConsole.ts))から、本物の `RTCDataChannel` の上で走らせます

```js
// 参加者のタブ(/)で
__rpc.serve()
// 発表者のタブ(/requester)で
await __rpc.check({ sizeMiB: 8 })
```

実物のDataChannelでの実測(2026/8/25、Chrome 141、ループバック): 16MiBの往復がバイト一致で通り、`bufferedAmount` のピークは7.93MiBで頭打ちになりました(水位8MiBの直下)。同じ条件で水位を見ずに書き続けると、16MiBちょうどで `send()` が `OperationError` を投げます。

**送ったものを加工して返す**作りにしてあるので、中身を読まずに返すだけの相手では通りません。分割・順序・詰まったときの送り直しが噛み合っていることの確認になります。

### Runtime は統合済み(B-1)

Web が読むのは **Runtime adapter の `/wasm/llmlet-runtime.js`**(名前付きexport `startPeer` /
`startRequester`)です。Emscripten の `llmlet-mod.js` / `.wasm` は adapter が自分の隣から
解決するので、Web 側が直接 import することはありません。

```ts
// 起動処理の中でWASMへ載せる
Module.PeerManager = rpc.manager
```

**`release_conn` は使いません。** 受信バッファはそれを malloc した pthread 側に残るため、
main thread から解放すると fd 再利用時に use-after-free になります。解放は adapter の
`close_peer()` 側が持ちます(Runtime 側の handoff 契約)。`usePeerManager` の `releaseBuf` も
渡しません。

**読み込みや起動に失敗してもダミー経路へは落ちません**([`webrtc/wasmEngine.ts`](../apps/web/src/webrtc/wasmEngine.ts))。
モデルもRPCも通っていないのに画面だけ準備完了になると、動いているかどうかの判定に
ならないためです。real GGUF / real RPC / real Runtime による実推論は B-1 で実測済みで、
**未証明なのは TURN の実機だけ**です。

ビルド側の前提(llmletのMakefileより): emsdk 4.0.16以上、`-sMEMORY64=2`(wasm64)、emdawnwebgpu(Dawn)、`-sEXPORTED_RUNTIME_METHODS` に `release_conn` を含めること。パッチ済みllama.cppは `ktock/llama.cpp` のフォークです。
