# フロントエンドの現状と進め方

`apps/web` の中身についての説明。2026/8/25時点。

## 3行でいうと

- **画面は2つ。URLのパスだけで役割が決まる**(入口で選ばせる画面は作らない)
- **制御プレーンは本物のHonoに繋がっている**(2026/8/25に既定を切り替えた)。Honoを起動せずに見た目だけ試したいときはモックへ戻せる
- **データプレーン(WebRTC)は実Runtimeまで繋がった**(B-1)。DataChannelの上を real llama.cpp RPC が流れ、real GGUF で実推論まで通っている。未証明なのは TURN の実機だけ

## 動かし方

```bash
bun install          # リポジトリのルートで
cd apps/web
bun run dev
```

| URL | 画面 | 役割 |
|---|---|---|
| `/` | 参加者画面 | 計算資源を貸す側。QRの飛び先 |
| `/requester` | 発表者画面 | 推論をリクエストする側。URLを直打ちする |

既定で本物のHono(`/ws`)へ繋ぎます。接続先は**画面を開いているオリジン**です。Honoがフロントごと配っている(`bun run --cwd apps/server dev` で `:3000` / `:8443` を開く)場合はこれだけで繋がります。

viteのdevサーバ(`:5173`)とHonoを別々に動かすときは、Honoのオリジンを渡してください。`/ws` と `/join-info` と `/models` の3つがプロキシされます。

```bash
VITE_HONO_ORIGIN=http://localhost:3000 bun run dev
```

Honoを起動せずに見た目だけ触りたいときは、モックへ戻します。

```bash
VITE_MOCK_SOCKET=1 bun run dev
```

画面の下端に **開発用パネル** が出ます(本番ビルドでは出ません)。

- `PHASE` の7つのボタン … 任意の状態へ飛ぶ。エラーや再編成中の見た目はここから確認する
- `ROSTER` の3つのボタン … ピアを足す/抜く、生成を開始する

**「ピアを抜く」を押すと再編成が起きます。** ここがフロントで一番作り込みが要る箇所なので、何度でも試せるようにしてあります。

`ROSTER` のボタンはモックのときだけ出ます。本物の接続では出す相手がいないので消えます。**既定が本物になったので、再編成の見た目をボタンで試したいときは `VITE_MOCK_SOCKET=1` を付けてください。**

本物で再編成を起こすには、参加者のタブを2つ開いて片方で「離脱する」を押します。同じブラウザで `/` と `/requester` を並べて開くのは問題ありません(clientIdは役割ごとに別のキーで保存しています。下記)。

## 画面が通る7つの状態

参加者と発表者は**同じ順で同じ状態を通ります**。違うのは各状態で何をしているかだけです。

```text
idle ─→ preparing ─→ waiting ─→ connecting ─→ active
                        ↑                        │
                        └──── reorganizing ←─────┘
```

| 状態 | 参加者 | 発表者 |
|---|---|---|
| `idle` | 未参加 | 未接続 |
| `preparing` | エンジンを起動中 | 参加者を待っている |
| `waiting` | 準備完了。編成待ち | 編成待ち |
| `connecting` | モデルを受信中 | 参加者へモデルを配布中 |
| `active` | 貢献中 | プロンプトを打てる |
| `reorganizing` | 再編成中(次の `generation_start` を待つ) | 同左 |
| `error` | 起動失敗 | 接続失敗 |

状態は `boolean` の組み合わせではなく、**常にこの7つのうち1つ**を持ちます。「繋がっていないのに貢献中」のようなありえない状態を型のレベルで作れなくするためです。

遷移のルールは [`src/hooks/clusterReducer.ts`](../apps/web/src/hooks/clusterReducer.ts) の30行に全部入っています。**画面の挙動を知りたいときはこのファイルだけ読めば足ります。**

### 再編成中から戻れないとき(#63)

`reorganizing` から出る道はサーバの `generation_start` **1本だけ**です。requesterが居ない、誰かが `ready` にならない、といった理由で次の世代が組めないと、画面は無言のまま止まります。タイムアウトも案内もありませんでした。

そこで参加者画面は、再編成中が `REORGANIZING_STALL_MS`(12秒、[`config.ts`](../apps/web/src/config.ts))続いたときだけ、案内と「参加し直す」を出します。時間を測るのは [`hooks/useStalled.ts`](../apps/web/src/hooks/useStalled.ts) です。

- **時間で状態は動かしません。** フェーズを進める判断は `clusterReducer` に閉じたままです。時間切れで画面が勝手に別のフェーズへ移ると、遅れて届いた `generation_start` と食い違います
- 「参加し直す」は離脱して入り直す操作です。`leave()` と `join()` を同じ描画で続けて呼ぶと `enabled` が false を通らず `useHonoSocket` の後片付けが走らない(WebSocketが閉じない)ので、離脱が反映された次の描画で `join()` を通しています
- 正常な再編成でこの案内が出てはいけないので、しきい値は「増えた側のエンジン起動が終わるまで既存の参加者が待たされる時間」より十分長くとっています
- **発表者画面はまだ未対応です。** `RequesterView` は③の持ち場なので、こちらでは触りません。同じ穴は発表者画面にも空いているため、PR #49(発表者画面のチャットUI)のマージ後に③へ申し送ります

発表者側は `generation_failed` を送るようになりました(#78)。WebRTC接続に失敗すると `RequesterView` の `onFailed` から送信し、Honoが `generation_aborted`(`connection_failed`)で編成を組み直します。参加者側の「時間で気づく」しくみ(上記)は、requesterが失敗以外の理由で無言のまま止まった場合の保険として残っています。

**ただし `onFailed` が発火するまでが速いとは限りません**(2026/8/27の実機確認で判明)。参加者が「answerを返さないまま黙る」形で落ちると、発表者の `RTCPeerConnection` は `connectionState` が `failed` になるまで、つまりICEが諦めるまで何も言いません。その間 Honoから見た `phase` は `active` のままなので、落ちた参加者が `peer_status: "error"` を送っていても(#79)編成は組み直されず、発表者画面は `connecting` で止まり続けます。**復帰の速さは #79 ではなく発表者側の失敗検知の速さで決まります。** 再現手順は [`webrtc-implementation.md`](webrtc-implementation.md) の「2台の参加者で異常系を確かめる」にあります。

そこで発表者側にも時間切れを入れました。配布中(`connecting`)が `CONNECT_STALL_MS`(10秒、[`config.ts`](../apps/web/src/config.ts))続いたら、ICEを待たずに `generation_failed` を送ります。測るのは参加者画面と同じ [`useStalled`](../apps/web/src/hooks/useStalled.ts) です。

- **ここでもフェーズは動かしません。** 時間切れで送るのは `generation_failed` だけで、`dispatch({ type: "failed" })` はしません。画面を動かすのはHonoが返す `generation_aborted` で、サーバが唯一の出口という形は変えていません
- `onFailed` からの送信(#78)は残してあります。相手が明示的に閉じた場合はそちらの方が速く、時間切れは**取りこぼしの保険**です。二重に送っても2通目はHono側の `applyGenerationFailed` が `phase !== "active"` で捨てます
- 除外された側も止まりません。`generation_start` の `peerIds` に自分が居ない参加者は `connecting` へ進まず、`waiting`(`error` だったなら `error` のまま)に留まります。判定に使う `myId` / `role` は `useCluster` が初期状態に入れています

#### 発表者の「世代の致命傷」は1本道にまとめてあります

以前は `pc.connectionState === "failed"` のときだけ `generation_failed` を送っていました。DataChannel が閉じただけのとき(peer の WebSocket は生きたまま回線だけ落ちた等)は送られず、Hono は `phase: active` のまま固まって発表者は永久に `connecting` のままでした。

現在は `webrtc/requesterSession.ts` の `fatalFail()` が唯一の入口です。RPC device は Runtime 起動時の `-rpc` 引数で固定されるため、**理由を問わず1本失った時点でその世代は続行不能**です。したがって次のすべてが同じ道を通ります。

- 予期しない DataChannel の close
- `pc.connectionState === "failed"`
- offer / answer の SDP 生成・適用の失敗
- `addIceCandidate` の失敗

通る順序が契約で、B-2 の ownership の原則(**所有権を手放してから壊す**)を物理回線まで含めて守ります。

1. `disposed = true` … セッションを**論理** terminal にする
2. `onClose` … `usePeerManager` の fence(世代トークンの失効)→ 旧 manager の退役
3. `shutdownConnections()` … **そのあとで** DataChannel / RTCPeerConnection を閉じる
4. `onFailed` … 画面の初期化(drain)と `generation_failed` の送信

**2 を 3 より先に置くのが要点です。** 物理回線を先に閉じると、まだ owner token が current で manager も現行のままの瞬間に相手側の回線が消えます。`stop()` は termination proof にならず旧 Runtime は pthread 側で並行に動きうるので、その瞬間の send / recv 失敗が現行世代へ流れ込む余地が残ります。1 で論理的に閉じてあれば、この窓は開きません。

**2 を 4 より先に置く**のは、畳む前の旧 Runtime が現行の持ち主のまま画面に触れないようにするためです。

1 が通知より先にあることで、「1セッションにつき1回だけ」も同時に成立します。別途フラグを持たないのは、`disposed` と二重の門になって片方がテストで固定できない飾りになるためです。

論理 terminal 化が要るのは、単に「もう失敗した」と印を付けるだけではセッションの受け口が生きたまま残るからです。呼び出し側の世代番号(`useWebrtcSignaling` の `generationRef`)は次の `generation_start` まで動かないので `isStaleForCurrent` は素通しし、**2 で作り直したばかりの新しい PeerManager へ、死んだ世代の回線が attach されてしまいます**(遅れて開く DataChannel、遅れて届く RPC 応答、遅れて成立する signaling)。

4の drain は進行中の生成の後始末には任せられません。2でトークンが失効しているため、旧 run の `.finally` は正しく「何もしない」からです。世代番号は変わらないので描画中の初期化も走らず、ここが唯一の初期化の口になります。ここを通さないと `generating` が立ったままになり、`requester_accepting: false` を送ったきりで Hono が新規peerを永久に取り込めなくなります。

**参加者側では同じ昇格をしません。** 正常な世代交代では「WSの `generation_aborted`」と「発表者の teardown 由来の remote close」が競合します。close が先着した参加者が自分を `peer_status: "error"` にすると、Hono は `error` の peer を編成から外すため**次の世代が組めなくなります**。参加者の close は従来どおり相手ごとの detach 通知のままです。

⚠️ **既知の限界(今回のスコープ外)**: WebSocket が生きたまま DataChannel だけ死に、peer が `ready` のままの場合、Hono は編成を `idle` に戻しますが**顔ぶれが同じなので次の世代を始めません**(`failedPeerIds` / `resetSinceStart`、#56)。peer の切断・`error`・入り直しのいずれかが要ります。参加者画面の「参加し直す」導線(#63)が回復路です。自動復旧させるには `generation_failed` に peerId を載せて失敗した相手だけ次の編成から外す必要があり、Hono と `shared-types` の変更を伴います。


### 発表者だけ、もう1本のトラックが並行する

モデル(GGUF)のダウンロードは数GBあるので、編成の進行とは**独立して**画面を開いた瞬間から走ります(`hooks/useModelDownload.ts`)。`fetch` + `ReadableStream` で実測しますが、**取得したバイトは数えたら捨てています**。①のWASMへ渡す経路は #71 の範囲で、このトラックは進捗表示までが対象です。

```text
トラックA  ダウンロード ─────────────────→ 完了
トラックB  preparing → waiting → connecting → active
```

**取得に失敗しても送信は止めません**(本人判断、2026/8/27)。モデル本体はまだ推論に使われていないため、GGUFが置いてあるかどうかだけでデモが死ぬのを避けています。入力欄が使えるかどうかは `phase === "active" && !generating` だけで決まり、モデルDLの状態とは独立です。

## ディレクトリ

```text
apps/web/src/
├── App.tsx                    パスで役割を分ける(分岐はここ1か所だけ)
├── index.css                  配色トークンと素の要素のリセットだけ
├── config.ts                  総層数・モデル名・WSのパスと接続先の切り替え
├── types/cluster.ts           Phase・ClusterState・LayerAssignment
├── types/socket.ts            モックと本物が共有する接続の型
├── hooks/
│   ├── clusterReducer.ts      状態遷移のルール
│   ├── useCluster.ts          両画面が状態に触る唯一の入口。どちらの接続を使うかもここ
│   ├── useHonoSocket.ts       本物の /ws への接続(再接続・受信の検証つき)
│   ├── useJoinUrl.ts          QRに入れる参加URLを /join-info から受け取る
│   │                          (応答の検証は lib/joinInfo.ts)
│   ├── useWebrtcSignaling.ts  webrtc_signalの送受信とDataChannelの生き死に
│   ├── usePeerManager.ts      開いたDataChannelとllama.cppのRPCを繋ぐ
│   │                          (useWebrtcSignaling へ広げて渡す形で返す)
│   ├── usePeerStats.ts        計測値を250msごとに読んで画面へ渡す
│   ├── useWasmEngine.ts       ①のWASMの起動をいつ始めるかだけを持つ
│   ├── useLightsOut.ts        待ち時間のパズルの盤面(フェーズには関与しない)
│   └── useHonoSocket.mock.ts  Honoの代わり。本物と同じ形を返す
├── lib/
│   ├── clientId.ts            localStorageに保存するclientId(役割ごとに別キー)
│   ├── assignments.ts         層の割り当ての仮置き(表示専用)
│   ├── parseServerMessage.ts  受信JSONの検証。契約に合わないフレームは捨てる
│   ├── wsUrl.ts               接続先URLの組み立て
│   ├── lightsOut.ts           ライツアウトの盤面(25ビットの純関数だけ)
│   └── format.ts              バイト数・件数・時間の表示
├── webrtc/                    Reactに依存しない接続の組み立て
│   ├── session.ts             共通の型・世代の判定・candidateの順番待ち
│   ├── peerSession.ts         参加者側。offerを受けてanswerを返す
│   ├── requesterSession.ts    発表者側。全参加者へofferを出す
│   ├── peerManager.ts         開いたDataChannelにllama.cppのRPCを載せる
│   │                          (WASM側が呼ぶ Module.PeerManager の実装)
│   ├── wasmEngine.ts          ①のWASMを読み込んで上のPeerManagerを差し込む
│   │                          (読めなければ失敗。ダミーへは落ちない)
│   └── peerStats.ts           流れたバイト数とRPCの往復の数え上げ(計測の実体)
├── components/                両画面で使う部品。1部品1フォルダ相当
│   ├── TopBar / StatusBlock / LayerBar / ProgressBar / Metric / DevPanel
│   ├── JoinQr                 参加者を集めるQR(発表者画面のサイドバー)
│   ├── LightsOut              待ち時間のパズルの盤面(参加者画面の下端)
└── views/
    ├── PeerView.tsx
    └── RequesterView.tsx
```

## 参加者を集めるQR

発表者画面のサイドバーに出しています([`components/JoinQr.tsx`](../apps/web/src/components/JoinQr.tsx))。QRを押すと投影用の全画面表示に切り替わり、クリックかEscで戻ります。

`preparing` / `waiting` の間は大きく、`active` になったら小さく畳みます。**埋まった後も消しません**(途中参加の導線を残すため)。

### QRに入れるURLはサーバが決める

`window.location.origin` は使えません。発表者が `https://localhost:8443/requester` で開いていると、QRの中身が `https://localhost:8443/` になり、参加者の端末では自分自身を指してしまいます。会場のLAN IPはブラウザからは分からないので、NICを列挙できるHono側に決めさせています。

```text
GET /join-info  →  { "joinUrls": ["https://192.168.11.5:8443/"] }
```

割り出しは [`apps/server/src/lanAddress.ts`](../apps/server/src/lanAddress.ts) です。ループバック・非IPv4・リンクローカル(169.254.x)を除き、`192.168.x` → `10.x` → その他の順に並べます(172.16-31 はDocker・WSL2・Hyper-Vの仮想NICが使うため後ろ)。候補が2つ以上返ったときは画面にプルダウンが出るので、発表者が選び直せます。

WebSocketメッセージにしていないのは、QRが接続確立より前に必要で、`packages/shared-types` の契約を増やすと `docs/api-contract.md` の更新義務が付いてくるからです。単発のGETで足ります。

問い合わせ先は**常に同一オリジン**です。別オリジンのHonoを直接fetchするとCORSで弾かれ、黙ってフォールバックしてしまうため、dev中に本物のLAN IPで試すときは vite のプロキシ経由にします。

```bash
VITE_HONO_ORIGIN=https://localhost:8443 bun run dev
```

指定しなければプロキシは張られず、今開いているオリジン(`http://localhost:5173/`)がQRに入ります。応答の検証は [`lib/joinInfo.ts`](../apps/web/src/lib/joinInfo.ts) で、http(s)の絶対URL以外は捨てます(devサーバがindex.htmlを返しても、空のQRにはなりません)。

### 証明書の警告は消せない

mkcertのローカルCAは飛び入り参加者の端末に入っていないため、QRを読んだ端末には必ず警告が出ます。SharedArrayBufferにHTTPSが要る以上、HTTPへ逃げる手もありません。通過手順(「詳細設定」→「アクセスする」)をQRの近くに出して、警告ごと受け入れる方針にしています。警告ゼロ化は#23の宿題です。

**`apps/server/scripts/gen-cert.sh` のLAN IP取得はmacOS前提**(`route -n get default` / `ipconfig getifaddr`)で、Windowsでは空になります。この状態だとQRで配るIPが証明書のSANに入りません。発表者PCがWindowsになる場合は、そのIPを明示して証明書を再発行してください。

## 待ち時間のパズル(参加者画面、#106)

参加者は `connecting`(モデルを受信中)と `active`(貢献中)のあいだ、画面を見ているだけになります。とくに `active` は世代が続くかぎり終わらないので、参加者から見た待ち時間としては最長です。そこに5×5のライツアウトを置いています([`components/LightsOut.tsx`](../apps/web/src/components/LightsOut.tsx))。

出すのはこの2つのフェーズだけで、置き場所は画面のいちばん下です。進捗バー・層バー・計測値という「今どうなっているか」を先に読ませ、パズルはその下に置きます。**上の要素の描画条件は1つも変えていません**(`connecting` で止まったときの案内(#63)を潰さないため)。発表者画面には出しません。

### ゲームループを持たない作りにしてある

裏では数GBのGGUFが流れ、`active` ではRPCも走っています。ここで `requestAnimationFrame` や `setInterval` を回すと、ゲーム側のGCがRPCの応答遅延として出るうえ、逆にメインスレッドが詰まればゲームがカクついて「アプリが壊れている」ように見えます。

そこで**押されたときだけ計算・再描画する**形にしています。canvasを使わないのも同じ理由で、canvasは描画そのものがメインスレッドで走り、backing storeがDPR2で数MBのGPUメモリを取ります。DOMなら見た目の変化はCSSのtransition(コンポジタ側)が受け持つので、メインスレッドが詰まっていても滑らかに見えます。

実測(`connecting` へ切り替えた前後、Chrome):

| 見たもの | 結果 |
|---|---|
| 盤面のDOMノード数 | 32 |
| `performance.memory.usedJSHeapSize` の増分 | 計測できず(この値の分解能より小さい) |

盤面の状態は **25ビットのビットマスク(number 1個)** です。ロジックは [`lib/lightsOut.ts`](../apps/web/src/lib/lightsOut.ts) に純関数だけで置いてあり、Reactにも `window` にも依存しません(テストは [`lib/lightsOut.test.ts`](../apps/web/src/lib/lightsOut.test.ts))。

初期盤面は**全消灯からランダムに数手 `toggleAt` を掛けて**作ります。`toggleAt` は同じマスに2回掛けると元へ戻るので、こうして作った盤面は必ず解けます。ランダムに点灯させる作り方だと解けない盤面が混ざります(5×5では全体の1/4しか解けない)。

### 状態を持つのは `PeerView` 側

盤面の状態は [`hooks/useLightsOut.ts`](../apps/web/src/hooks/useLightsOut.ts) が持ち、**呼ぶのは `PeerView`** です。`LightsOut` の中に置くと、`active → reorganizing → connecting → active` と往復するたびにアンマウントされて**遊びかけの盤面が消えます**。フェーズの外側に置いておけば、参加しているあいだは1問が続きます。

`PeerView` に状態が1つ増えると1手ごとに再描画されますが、`usePeerStats` が参加中は250msごとに再描画を起こしているので実質的な増分はありません。

パズルからは `dispatch` も `send` も呼びません。フェーズを動かすのは従来どおり `clusterReducer` とサーバだけです。

### 点灯に `--c-active` を使わない

点灯は `--c-line`(青)、消灯は `--c-surface-2` です。「この色が見えている場所＝稼働中」という規則があり、`active` では同じ画面で脈打つドットと `LayerBar` が黄を使っています。盤面25マスを黄にすると稼働表示が埋もれます。`--c-active` を使うのはクリア表示の枠と文字だけで、これは#68の「嬉しい出来事には active 色を使う」と同じ扱いです。

## 書くときの決まりごと

### CSSは CSS Modules

**`index.css` に見た目を書かないでください。** ここに置くのは配色トークンと `button` `input` などの素の要素のリセットだけです。

コンポーネントの見た目は隣に `Foo.module.css` を置きます。

```tsx
import styles from "./Foo.module.css";
<div className={styles.card} />
```

理由は単純で、**1つのCSSファイルを2人で編集すると毎回のPRで衝突するから**です。ファイルが分かれていれば衝突しません。

### 色は4色とその派生だけ

Canvaの配色100選の54番を使っています。

| 変数 | 値 | 用途 |
|---|---|---|
| `--c-bg` | `#2E3131` | 画面の地 |
| `--c-line` | `#416E86` | 罫線・非活性 |
| `--c-active` | `#F9B931` | 稼働中・主要ボタン |
| `--c-text` | `#F7F1E4` | 文字 |
| `--c-warn` | `#E0913E` | ピア状態ドットの connecting |
| `--c-danger` | `#D25447` | ピア状態ドットの error |

面の色(`--c-surface`)と副次テキスト(`--c-text-dim`)は、この4色を混ぜて作っています。**新しい色を足さないでください。** 足したくなったら `color-mix` で既存の色から作れないかを先に考えてください。

例外はピア状態ドット用の `--c-warn` / `--c-danger` の2色だけです(`#96`)。`ready` は `--c-active`(黄)を使う都合上、`connecting` / `error` をひと目で分けるには黄・青と見分けがつく独自色が必要だったため、この2つに限って追加しました。状態ドット以外に使う場合は先に相談してください。

`--c-active` は「今そこが動いている」ことを示す色です。**この色が見えている場所＝稼働中**という規則にしてあるので、装飾には使わないでください。

### 状態は `useCluster` を通す

各ビューで `useState` を使ってフェーズを持たないでください。

```tsx
const { state, dispatch, send, assignments, debug } = useCluster({ enabled: true });
```

ここを通しておくと、モックから本物への差し替えが `useCluster.ts` の中だけで完結します。

## 本物のHonoへの繋ぎ込み(ステップ3)

`src/hooks/useHonoSocket.ts` が本物です。返り値の形はモックと同じなので、**ビューは1行も変わりません。**

切り替えは `config.ts` の `USE_MOCK_SOCKET`(環境変数 `VITE_MOCK_SOCKET`)1か所です。②の `/ws`(#16〜#19)がマージされたので、**2026/8/25に既定を本物側へ倒しました**。モックはまだ消していません(Honoを起動せずに再編成の見た目を確認する用途と、DevPanelのROSTERボタンがモック側にしかないため)。

このフックが持つのは接続と受け渡しだけで、フェーズの判断はしません。判断は今までどおり `clusterReducer.ts` に閉じています。作り込んであるのは次の3点です。

| | なぜ |
|---|---|
| 受信JSONの検証([`lib/parseServerMessage.ts`](../apps/web/src/lib/parseServerMessage.ts)) | 型は共有していても、送ってくるのは別プロセス。`onmessage` の中で例外を投げると、その接続で以降のメッセージを1件も受け取れなくなる |
| 自動再接続(指数バックオフ、上限4秒) | ②がサーバを再起動しても、会場で参加者に「リロードしてください」と言って回らずに済む。切れているあいだは `idle` に戻り、戻ってきたら `hello` から名乗り直す |
| 受信を1件ずつ流す | 同じtickで2件届くと後の1件しか観測されない。モックが `FRAME_MS` を挟んでいるのと同じ理由 |

### 実機で確認したこと(2026/8/25)

本物のHono(`:3000`、フロントごと同一オリジンで配信)に対して、参加者と発表者を並べて開き、次の流れを通しました。

1. 発表者が `hello` → 参加者が `hello` → 両方に `roster_update` が届く
2. 参加者の準備完了(`peer_status: ready`)で `generation_start` が飛び、両画面が受信中→稼働中へ進む
3. 参加者が「離脱する」→ 発表者に `generation_aborted` が届き再編成中へ
4. 参加者が再参加 → 次の世代が始まり、両画面が稼働中へ戻る
5. Honoを再起動 → 両画面が自動で繋ぎ直し、`hello` から名乗り直して編成が復帰する

**このとき見つけて直した不具合**: `clientId` を両画面で1つのキーに保存していたため、同じブラウザで `/` と `/requester` を開くと両者が同じIDを名乗っていました。Honoはこれを「同一clientIdの張り替え(リロード)」と解釈して先に繋いだ側のソケットを捨てるので、発表者がロスターを受け取れず、`generation_start` も発火しません(requesterが居ない扱いになるため)。保存キーを役割ごとに分けて解決しています([`lib/clientId.ts`](../apps/web/src/lib/clientId.ts))。

会場では発表者と参加者が別の端末なので本番のデモは踏みませんが、**1台で両方を開いて検証する経路は必ず踏みます**。

## データプレーンの繋ぎ込み(ステップ4)

`webrtc_signal`(offer / answer / ice-candidate)を `/ws` に載せて `RTCPeerConnection` を張り、DataChannel `rpc` が開くまでを実装しました。

**その先(RPCのバイナリ通信)も同じ担当が持つことになりました(2026/8/25)。** [`webrtc/peerManager.ts`](../apps/web/src/webrtc/peerManager.ts) が、開いたDataChannelの上にllama.cppのRPCを載せます。①に残るのはWASMのビルドだけです。契約と枠の形は `docs/webrtc-implementation.md` の「データプレーン」節が正です。

入口は [`hooks/useWebrtcSignaling.ts`](../apps/web/src/hooks/useWebrtcSignaling.ts) と [`hooks/usePeerManager.ts`](../apps/web/src/hooks/usePeerManager.ts) の2つで、両画面が同じ形で呼びます。

```tsx
const rpc = usePeerManager({ onError: (message) => dispatch({ type: "failed", message }) });
const rtc = useWebrtcSignaling({
  role: "peer", myId, enabled: joined, lastMessage, send,
  ...rpc.handlers, // onOpen / onData / onClose / onReset
});
// rtc: { generation, expectedIds, openIds, status }
// rpc.manager: WASMが来たら Module.PeerManager に載せる本体
```

このフックが持つのも**接続と受け渡しだけ**で、フェーズの判断はしません(`useHonoSocket.ts` と同じ)。ビュー側は `rtc.status === "open"` を見て `datachannel_open` を出すだけです。役割ごとの違いはフックの中の分岐ではなく [`webrtc/`](../apps/web/src/webrtc) の2実装(`createPeerSession` / `createRequesterSession`)にあり、どちらも `start` / `accept` / `teardown` の同じ形を返します。

発表者が offer を出す相手は `generation_start` の `peerIds` から直接読んでいます。`ClusterState` に持たせていないのは、[`clusterReducer.ts`](../apps/web/src/hooks/clusterReducer.ts) を触らずに済ませるためです。参加者は相手を事前に知る必要がなく、offer の `fromId` で分かります。

### 世代(generation)で古いものを捨てる

セッションは作られた世代の番号を持ち、そこから上がる通知はすべて番号つきです。現行と食い違うものを捨てる、という1つの仕組みで3か所を賄っています。

| 場所 | 捨てないと何が起きるか |
|---|---|
| `generation_aborted` の受信時 | 遅れて届いた古い中断通知が、始まったばかりの編成を巻き込む |
| DataChannelの開通時 | 古い世代の接続が遅れて開き、再編成中の画面が `datachannel_open` で稼働中へ戻る |
| データの受信時 | 前の編成で計算されたぶんが、今の生成の結果に混ざる |
| DataChannelが閉じたとき | 遅れて閉じた古い接続が、同じ相手との現行のRPCを巻き添えに切る |

判定そのものは [`webrtc/session.ts`](../apps/web/src/webrtc/session.ts) の `isStaleAbort` / `isStaleForCurrent` で、テストは [`webrtc/session.test.ts`](../apps/web/src/webrtc/session.test.ts) にあります。

### ICE candidate は remoteDescription が入るまで溜める

offer より先に candidate が届くことはありませんが、`setRemoteDescription` は非同期です。その解決を待たずに `addIceCandidate` を呼ぶと `InvalidStateError` で落ちるので、両側で順番待ちの箱(`createCandidateQueue`)を挟んでいます。`docs/webrtc-implementation.md` の見本にはこの処理がありません。

### 実機で確認したこと(WebRTC、2026/8/25)

同一オリジン(`:3000`)で `/requester` と `/` を並べて開き、次を通しました。**参加者が「貢献中」に変わるのは DataChannel が実際に開いたときだけ**なので、70msタイマーの偽物は完全に外れています。

1. 参加者が準備完了 → `generation_start`(第10世代)→ 発表者が offer → 参加者が answer → 両画面が稼働中へ
2. 参加者が「離脱する」→ 発表者に `generation_aborted` が届き、接続を閉じて再編成中へ
3. 参加者が再参加 → 第11世代で張り直し、両画面が稼働中へ戻る

コンソールにエラーは出ていません。ICEの詳細は `chrome://webrtc-internals` で見られます。

### ①のWASMを起動する(#71)

参加者画面のエンジン起動は、2.2秒の `setTimeout` から本物の読み込みに替わりました([`webrtc/wasmEngine.ts`](../apps/web/src/webrtc/wasmEngine.ts))。やっているのは4つです。

1. **`/wasm/llmlet-runtime.js`**(Runtime adapter)を動的importして初期化する(配信は Hono の `public/wasm`)。Web が直接読むのはこの adapter で、Emscripten の `llmlet-mod.js` / `.wasm` は adapter が自分の隣から解決します
2. `Module.PeerManager = rpc.manager` を差し込む
3. `ChunkCache` / model の受け渡しなど、adapter が要求する glue を繋ぐ
4. `startPeer` / `startRequester` を呼ぶ。返ったら `local_ready` と `peer_status: ready`

**Runtime は統合済みです(B-1)。** real GGUF / real RPC / real Runtime で実推論まで通っています。**読み込みや起動に失敗してもダミー経路へは落ちません** — そのまま失敗として返します。モデルもRPCも通っていないのに画面だけ準備完了になると、動いているかどうかの判定にならないためです。どの経路を通ったかはコンソールの `[wasm]` 行で追えます。

画面から呼ぶ入口は [`hooks/useWasmEngine.ts`](../apps/web/src/hooks/useWasmEngine.ts) で、`role` を替えれば発表者側(rpc-client役)からも同じものを使えます。`PeerView` に残っているのは呼び出しの5行だけです。

決めごとが3つあります。

| | なぜ |
|---|---|
| `nodeId` は自分の `clientId` をそのまま渡す | llama.cppの `rpc_servers` の文字列がそのまま `connect(nodeId, done)` に来るため([`lib/clientId.ts`](../apps/web/src/lib/clientId.ts)) |
| 起動関数の名前は adapter の契約に合わせる | Web が読むのは `llmlet-runtime.js` で、名前付きexport `startPeer` / `startRequester` がある。無ければ失敗として返す |
| 起動関数が返らなくても先へ進む | rpc-server役は待ち受けたまま戻らない作りがありうる。待ち続けると準備中で止まる |
| 1つのPeerManagerにエンジンは1つ | 参加 → 離脱 → 再参加で起動処理は何度でも呼ばれる。起動中の再参加は走っているものに相乗りし、載ったあとは覚えたものを返す(`createEngineStarter`)。素通しすると同じ回線の上にrpc-serverが2つ立つ |

`releaseBuf` を `setOptions` で直接入れずに `PeerView` のstateに持たせているのは、`usePeerManager` が描画のたびに渡されたオプションで上書きするからです。外から入れた値は次の描画で消えます。

### まだ無いもの

- **会場LAN内のTURNへfallbackできます(既定は無効)。** 物理2PC・標準Chrome・`iceServers: []` の実測で、secure context / SDP / host candidate 交換まで通ったのに ICE が `checking → disconnected`、DTLS が `new` のままで止まりました。**証明できているのは「host candidate による direct path が成立しないLANがある」ところまで**で、原因は未確定です。そのため原因究明ではなく迂回路を用意しました
  - 設定は `VITE_TURN_URLS` / `VITE_TURN_USERNAME` / `VITE_TURN_CREDENTIAL` の3点セット(`apps/web/.env.example`)。**3つとも空なら従来どおりTURN無効**で、参加者の操作は何も増えません(URLを開く → 参加する、のまま)
  - 一部だけ設定すると**起動時に設定エラーで落ちます**。黙ってTURN無効へ倒すと「入れたつもりで効いていない」まま実機検証して結果を誤読するためです
  - 既定の `iceTransportPolicy` は `all`。**direct を優先するか relay へ回すかはICEに選ばせます** — 「direct → timeout → 張り直し → TURN」のような手書きのfallback state machineは持ちません
  - `VITE_FORCE_RELAY=1` は**検証専用**で、relay経路だけを試すためのものです。本番では使いません
  - 実装は [`webrtc/iceConfig.ts`](../apps/web/src/webrtc/iceConfig.ts)(純粋)と `webrtc/session.ts` の `createPeerConnectionFactory`。requester/peer のどちらにもTURN固有の分岐はありません
  - 開発者向けに `icecandidateerror` と、繋がった後の selected candidate pair をコンソールへ出します(`attachIceDiagnostics`)。**credential は絶対に出しません。**ただし **TURN の URL(会場LANのIPを含む)と ICE server のエラーは診断情報として出ます** — どのTURNがどう断ったかが追えないと、実験で原因を切り分けられないためです
  - selected pair は `connected` 直後だとまだ stats に現れないことがあるので、100 / 300 / 1000ms で最大3回だけ読み直します(直列)。読めたら `[webrtc] selected ICE route` を1回、retry のあいだ `connected` を保ったのに読めなければ `[webrtc] ICE route unavailable` を1回出します。**teardown や disconnect で中断した場合はどちらも出ません**(「ログが無い = connected 未到達」とは読めません。DataChannel の `open` 自体が connected の証拠になります)
  - **まだ実機で通していません。** 同一PCの forced relay も物理2PCも未実施です
- 会場のAPアイソレーションが有効な場合、TURNがあれば中継で通せる見込みですが、これも未実測です(`docs/webrtc-implementation.md`)
- **WebRTCの失敗で `peer_status: "error"` を送るようになりました(#79)。** 以前はサーバの「全員ready」が崩れて次の世代が始まらず、1人の失敗で全体が止まるため送っていませんでしたが、#57でHonoが `status: "error"` のpeerを編成から外すようになったため解消しました。復帰時の `ready` 送り直しは、離脱→再参加で `useWasmEngine` の `onReady` が通る既存の経路に乗っています
- **Runtime は統合済みです(B-1)。** `peerManager.ts` は両画面に繋ぎ込み済みで、DataChannelが開けば `attach` まで走ります。Web が読むのは Runtime adapter の `/wasm/llmlet-runtime.js` で、real GGUF / real RPC / real Runtime による実推論まで通っています(`webrtc/wasmEngine.ts`)。**読み込みに失敗してもダミー経路へは落ちません。** 未証明なのは TURN の実機だけです
  - **RPCのバイト列そのものは、WASMの代役スタブで流して確認済みです**(2026/8/25、#44)。実物のDataChannelで16MiBの往復がバイト一致で通っています。開発中は参加者のタブで `__rpc.serve()`、発表者のタブで `await __rpc.check()` で試せます(`docs/webrtc-implementation.md` の「WASMの代役スタブで確認したこと」)

## 計測(処理回数・受信データ・応答時間)

参加者画面の下に出ている3つの数字です(#47)。乱数だったものを実測に替えてあります。

**数えている場所は `RTCPeerConnection.getStats()` ではなく PeerManager です。** データプレーンのバイトは [`webrtc/peerManager.ts`](../apps/web/src/webrtc/peerManager.ts) の `writeFrame` と `handleData` を必ず通るので、ここで数えると本文のバイト数が厳密に出ます。`getStats()` はSCTP/DTLSの分が混ざるうえ、処理回数は原理的に取れません。数え上げの実体は [`webrtc/peerStats.ts`](../apps/web/src/webrtc/peerStats.ts) に独立させてあり、PeerManager からの呼び出しは `onReceived` / `onSent` の2箇所だけです。

| 表示 | 実体 |
|---|---|
| 処理回数 | 受信→送信の**流れの反転回数**。1つの要求に1つ応答を返すので、反転の数 = 処理したRPCコマンド数 |
| 受信データ | `CMD_DATA` の本文バイト数の累計。フレームのヘッダと制御フレームは含めない |
| 応答時間 | 要求の1バイト目を受けてから応答の1バイト目を出すまで。直近32回の**中央値** |

数える瞬間は「回線を実際に渡ったとき」に揃えてあります。送信は `channel.send()` が通った時点(水位で積んだだけのものは書き出せるまで数えません。積んだまま捨てられることがあるため)、受信は届いた時点(受信キューの上限でこちらが捨てるかどうかは、受け取った量と関係がないため)です。

反転を数えるのは、peerがRPCサーバー役だからです。DataChannel上のバイトは必ず「受信が続く → 送信が続く → また受信」の往復になるので([`webrtc/rpcStub.ts`](../apps/web/src/webrtc/rpcStub.ts) が真似ているのがこの形)、受信から送信へ切り替わった回数がそのまま応答を返した回数になります。要求や応答が複数フレームに分かれても、連続する同じ向きはまとめて1回と数えます。

**「平均処理」ではなく「応答時間」というラベルにしてあります。** 測っているのは受信開始から応答開始までで、純粋な計算時間ではありません(要求が回線を渡り切るのを待つ時間が入ります)。平均ではなく中央値なのは、モデル配布中の大きな転送が1回混ざるだけで平均が跳ねるためです。

そのほかの決めごと:

- 累計は**参加してから離脱するまで**。再編成をまたいでも0に戻しません(「自分がどれだけ働いたか」を出したいため)。0に戻すのは `PeerView` の「参加する」だけです
- モデルの重みも受信データに含めます。実態として受け取っているデータです
- 読むのは250msに1回([`hooks/usePeerStats.ts`](../apps/web/src/hooks/usePeerStats.ts))。転送中は `send`/`recv` が秒間数百回呼ばれるので、そのたびに再描画すると画面の更新が主な負荷になります。値が変わっていなければ `setState` もしません
- 脈動は `turns` 1回ごとではなく「直近400msに動きがあったか」で出します。往復ごとに光らせると点滅がつぶれます
- **①のWASMが載るまでは3つとも動きません。**数字ではなく `—` が出ます。0と書くと「計測して0だった」に見えるためです。デモで動いて見せる必要があるときは `VITE_FAKE_METRICS=1` で乱数へ戻せます(`config.ts`)
- 相手ごとの内訳(`snapshotOf`)も持たせてあるので、発表者画面へ広げるときは設計をやり直さずに済みます

## 分担

`components/` と `hooks/` を先に固めてあるので、あとはビュー単位で分かれれば衝突しません。

| 範囲 | 内容 |
|---|---|
| `views/PeerView.*` | 参加フォーム、貢献中の演出、離脱 |
| `views/RequesterView.*` | チャット、ピア一覧、モデルの進捗 |
| `components/` `hooks/` | 共通。触るときは一声かける |

## 他の担当への依頼

### ②(Honoサーバ)へ

1. ~~**`generation_start` を発火させる条件(#17)。**~~ 入りました(`roster.ts` の `maybeStartGeneration`)。実機で確認済みです
2. **新しい参加者が来たときも再編成してください。** フロントは「増えても減っても全員で組み直す」前提で作ってあります(異常系を1パターンに保つため)。今の `roster.ts` は生成中(`phase === "active"`)に `hello` が来ても `generation_aborted` を出さず、`maybeStartGeneration` も空を返すので、**あとから来た参加者は誰かが切断するまで待機中で取り残されます**。会場で人が増えていく見せ方をするなら、ここが要ります

配信基盤(COOP/COEP・HTTPS・SPAフォールバック、#12〜#15)は PR #24 で入りました。開発サーバー側のCOOP/COEPヘッダは `vite.config.ts` に同じものを入れてあります。

### ①(コア分散基盤)へ

1つ目は必須です。2つ目以降は余裕があれば、という前提の依頼で、無くても画面は成立します。

1. ~~**WASMのビルドを出してください。**~~ 届きました。Web が読むのは Runtime adapter の `llmlet-runtime.js` で、その隣の `llmlet-mod.js` / `.wasm` は adapter が解決します。RPCの橋渡し([`webrtc/peerManager.ts`](../apps/web/src/webrtc/peerManager.ts))と繋ぎ込み済み。**`release_conn` は使いません**(受信バッファの所有権は adapter 側。二重解放になる)
2. `getLayerAssignment()` … 各ピアの担当層。無い場合は層番号の表示を諦めます
3. `onComputeStart` / `onComputeEnd` … 参加者側で「自分の番」が来た/終わったの通知。**無くても計測は動きます**(#47。DataChannel上の往復を PeerManager 側で数えているので、`getStats()` のポーリングは要りませんでした)。もらえると「自分の番」の境目がRPCの往復ではなく計算そのものになるので、処理回数と処理時間の意味が一段はっきりします

**今の層の割り当ては均等割りの仮置きです**([`lib/assignments.ts`](../apps/web/src/lib/assignments.ts))。表示専用で、割り当ての決定には使っていません。本物の配分はllama.cppが空きメモリから比例配分します(`AGENTS.md` のアーキテクチャ前提3)。

## ダミーで動いている部分の一覧

繋ぎ込みのときに差し替える箇所です。

| 場所 | 今 | 本物 |
|---|---|---|
| ~~`useHonoSocket.mock.ts`~~ | — | `useHonoSocket.ts` へ切り替え済み(2026/8/25)。モックは `VITE_MOCK_SOCKET=1` で呼び戻せる |
| `lib/assignments.ts` | 均等割り | ①の `getLayerAssignment()` |
| ~~`PeerView` のWebRTC接続~~ | — | 本物になりました(2026/8/25)。`useWebrtcSignaling` の `status` が `open` になったら受信中を抜けます |
| ~~`RequesterView` の配布率~~ | — | 本物になりました(2026/8/25)。開いたDataChannelの数 ÷ 繋ぐべき人数です |
| ~~`PeerView` のエンジン起動~~ | — | 実物になりました。`llmlet-runtime.js` を読んで `startPeer` を呼びます([`webrtc/wasmEngine.ts`](../apps/web/src/webrtc/wasmEngine.ts)、B-1) |
| ~~`PeerView` の処理回数・受信量~~ | — | 実測になりました(#47)。数えているのは [`webrtc/peerStats.ts`](../apps/web/src/webrtc/peerStats.ts)。①のWASMが載るまでは動かないので画面には `—` が出ます。乱数へ戻すときは `VITE_FAKE_METRICS=1` |
| `RequesterView` のモデル進捗 | Runtimeのready(0か1) | #80 の実測(`useModelDownload`)は**画面へ繋いでいない** — Runtimeが同じGGUFを自分で取るので繋ぐと491MBを二重に引く。Runtime側が進捗を報せられるようになってから繋ぐ |
| ~~`RequesterView` の生成~~ | — | 実物になりました(B-1)。Runtime adapter の `onText(delta)` がそのまま流れます。**真のtoken境界ではなく文字出力**なので、API名は `onToken` ではなく `onText` です |
| `RequesterView` の「計算中」の移動 | 出していない(`computingIndex` は常に null) | Runtime側が層ごとの担当を報せられるようになったら繋ぐ |

## 次にやること

1. ~~**WebRTCのシグナリング(`webrtc_signal` の送受信)。**~~ 入りました(#37)。上の「データプレーンの繋ぎ込み(ステップ4)」を参照
2. ~~**①へDataChannelを渡す。**~~ 担当が変わり、RPCの繋ぎ込みまでこちらで持ちます。橋渡しの本体([`webrtc/peerManager.ts`](../apps/web/src/webrtc/peerManager.ts))と、両画面への繋ぎ込み([`hooks/usePeerManager.ts`](../apps/web/src/hooks/usePeerManager.ts))が入りました
3. ~~**WASMが来たら `Module.PeerManager = rpc.manager` を差し込む。**~~ 両画面とも入りました(B-1)。参加者は `startPeer`、発表者は `startRequester` を Runtime adapter 経由で呼びます
4. 上の「②へ」の2番(新しい参加者が来たときの再編成)を②と詰める
5. ~~`PeerView` の処理回数・受信量を実測に替える。~~ 入りました(#47)。計測点は `getStats()` ではなく PeerManager です(本文のバイト数を厳密に数えられ、`getStats()` では取れない処理回数も取れるため)
