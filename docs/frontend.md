# フロントエンドの現状と進め方

`apps/web` の中身についての説明。2026/8/25時点。

## 3行でいうと

- **画面は2つ。URLのパスだけで役割が決まる**(入口で選ばせる画面は作らない)
- **制御プレーンは本物のHonoに繋がっている**(2026/8/25に既定を切り替えた)。Honoを起動せずに見た目だけ試したいときはモックへ戻せる
- **データプレーン(WebRTC)はDataChannelが開くところまで入った**(2026/8/25)。その上を流れるRPC通信は①待ちなので、生成・処理量は今もダミーで動く

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

viteのdevサーバ(`:5173`)とHonoを別々に動かすときは、Honoのオリジンを渡してください。`/ws` と `/join-info` の両方がプロキシされます。

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

### 発表者だけ、もう1本のトラックが並行する

モデル(GGUF)のダウンロードは数GBあるので、編成の進行とは**独立して**画面を開いた瞬間から走ります。

```text
トラックA  ダウンロード ─────────────────→ 完了
トラックB  preparing → waiting → connecting → active
                                              ↓
                          両方そろって初めて入力欄が開く
```

つまり入力欄が使えるかどうかは `phase === "active" && modelReady` の **AND** です。片方だけでは開きません。

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
│   └── useHonoSocket.mock.ts  Honoの代わり。本物と同じ形を返す
├── lib/
│   ├── clientId.ts            localStorageに保存するclientId(役割ごとに別キー)
│   ├── assignments.ts         層の割り当ての仮置き(表示専用)
│   ├── parseServerMessage.ts  受信JSONの検証。契約に合わないフレームは捨てる
│   ├── wsUrl.ts               接続先URLの組み立て
│   └── format.ts              バイト数・件数の表示
├── webrtc/                    Reactに依存しない接続の組み立て
│   ├── session.ts             共通の型・世代の判定・candidateの順番待ち
│   ├── peerSession.ts         参加者側。offerを受けてanswerを返す
│   ├── requesterSession.ts    発表者側。全参加者へofferを出す
│   └── peerManager.ts         開いたDataChannelにllama.cppのRPCを載せる
│                              (WASM側が呼ぶ Module.PeerManager の実装)
├── components/                両画面で使う部品。1部品1フォルダ相当
│   ├── TopBar / StatusBlock / LayerBar / ProgressBar / Metric / DevPanel
│   ├── JoinQr                 参加者を集めるQR(発表者画面のサイドバー)
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

面の色(`--c-surface`)と副次テキスト(`--c-text-dim`)は、この4色を混ぜて作っています。**新しい色を足さないでください。** 足したくなったら `color-mix` で既存の色から作れないかを先に考えてください。

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

入口は [`hooks/useWebrtcSignaling.ts`](../apps/web/src/hooks/useWebrtcSignaling.ts) 1つで、両画面が同じ形で呼びます。

```tsx
const rtc = useWebrtcSignaling({ role: "peer", myId, enabled: joined, lastMessage, send });
// rtc: { generation, expectedIds, openIds, status }
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

判定そのものは [`webrtc/session.ts`](../apps/web/src/webrtc/session.ts) の `isStaleAbort` / `isStaleForCurrent` で、テストは [`webrtc/session.test.ts`](../apps/web/src/webrtc/session.test.ts) にあります。

### ICE candidate は remoteDescription が入るまで溜める

offer より先に candidate が届くことはありませんが、`setRemoteDescription` は非同期です。その解決を待たずに `addIceCandidate` を呼ぶと `InvalidStateError` で落ちるので、両側で順番待ちの箱(`createCandidateQueue`)を挟んでいます。`docs/webrtc-implementation.md` の見本にはこの処理がありません。

### 実機で確認したこと(WebRTC、2026/8/25)

同一オリジン(`:3000`)で `/requester` と `/` を並べて開き、次を通しました。**参加者が「貢献中」に変わるのは DataChannel が実際に開いたときだけ**なので、70msタイマーの偽物は完全に外れています。

1. 参加者が準備完了 → `generation_start`(第10世代)→ 発表者が offer → 参加者が answer → 両画面が稼働中へ
2. 参加者が「離脱する」→ 発表者に `generation_aborted` が届き、接続を閉じて再編成中へ
3. 参加者が再参加 → 第11世代で張り直し、両画面が稼働中へ戻る

コンソールにエラーは出ていません。ICEの詳細は `chrome://webrtc-internals` で見られます。

### まだ無いもの

- **TURNは持ちません。** 会場のAPアイソレーションが有効だとP2Pが成立しません(`docs/webrtc-implementation.md`)。ローカル検証では踏みません
- **WebRTCの失敗で `peer_status: "error"` は送っていません。** 送るとサーバの「全員ready」が崩れて次の世代が始まらず、1人の失敗で全体が止まるためです。今は画面だけ `error` にしています
- **WASM本体がありません。** `peerManager.ts` は単体で動きテストも通っていますが、`Module.PeerManager` に差し込む相手(`llmlet-mod.js` / `.wasm`)が①からまだ来ていないため、実際にRPCが流れるところまでは繋がっていません

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

1. **WASMのビルド(`llmlet-mod.js` / `.wasm`)を出してください。** RPCの橋渡し([`webrtc/peerManager.ts`](../apps/web/src/webrtc/peerManager.ts))はこちらで書き終えていますが、差し込む相手が無いと動きません。ビルド時の必須条件は `-sEXPORTED_RUNTIME_METHODS` に `release_conn` を含めることです(詳細は `docs/webrtc-implementation.md`)
2. `getLayerAssignment()` … 各ピアの担当層。無い場合は層番号の表示を諦めます
3. `onComputeStart` / `onComputeEnd` … 参加者側で「自分の番」が来た/終わったの通知。あると処理回数・処理時間・脈動が実測になります。無い場合は `RTCPeerConnection.getStats()` の250ms間隔ポーリングで粗く代替します

**今の層の割り当ては均等割りの仮置きです**([`lib/assignments.ts`](../apps/web/src/lib/assignments.ts))。表示専用で、割り当ての決定には使っていません。本物の配分はllama.cppが空きメモリから比例配分します(`AGENTS.md` のアーキテクチャ前提3)。

## ダミーで動いている部分の一覧

繋ぎ込みのときに差し替える箇所です。

| 場所 | 今 | 本物 |
|---|---|---|
| ~~`useHonoSocket.mock.ts`~~ | — | `useHonoSocket.ts` へ切り替え済み(2026/8/25)。モックは `VITE_MOCK_SOCKET=1` で呼び戻せる |
| `lib/assignments.ts` | 均等割り | ①の `getLayerAssignment()` |
| ~~`PeerView` のWebRTC接続~~ | — | 本物になりました(2026/8/25)。`useWebrtcSignaling` の `status` が `open` になったら受信中を抜けます |
| ~~`RequesterView` の配布率~~ | — | 本物になりました(2026/8/25)。開いたDataChannelの数 ÷ 繋ぐべき人数です |
| `PeerView` のエンジン起動 | 2.2秒の `setTimeout` | ①の `startWasmPeerServer()` |
| `PeerView` の処理回数・受信量 | 乱数 | `getStats()` または ①のフック |
| `RequesterView` のモデルDL | 一定速度のタイマー | `fetch` + `ReadableStream` の実測 |
| `RequesterView` の生成 | 固定文を1文字ずつ | ①の `onToken()` |
| `RequesterView` の「計算中」の移動 | 12文字ごとに次のピアへ | ①の `onPeerTurn()` |

## 次にやること

1. ~~**WebRTCのシグナリング(`webrtc_signal` の送受信)。**~~ 入りました(#37)。上の「データプレーンの繋ぎ込み(ステップ4)」を参照
2. ~~**①へDataChannelを渡す。**~~ 担当が変わり、RPCの繋ぎ込みまでこちらで持ちます。橋渡しの本体([`webrtc/peerManager.ts`](../apps/web/src/webrtc/peerManager.ts))は入りました。`useWebrtcSignaling` の `onOpen(remoteId, channel)` を `pm.attach`、`onData(remoteId, data)` を `pm.handleMessage` に繋ぎます
3. **WASMが来たら `Module.PeerManager = pm` を差し込む。** ①のビルド(`llmlet-mod.js` / `.wasm`)待ちです。それまで繋ぎ込みの最後の一手は書けません
4. 上の「②へ」の2番(新しい参加者が来たときの再編成)を②と詰める
