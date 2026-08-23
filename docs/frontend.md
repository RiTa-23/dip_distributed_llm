# フロントエンドの現状と進め方

`apps/web` の中身についての説明。2026/8/23時点。

## 3行でいうと

- **画面は2つ。URLのパスだけで役割が決まる**(入口で選ばせる画面は作らない)
- **今は全部ダミーで動く**。Honoが未完成でも、参加から貢献中までの流れが最後まで再現できる
- **本物のWebSocketへの差し替えは1ファイル1行**で済むようにしてある

## 動かし方

```
bun install          # リポジトリのルートで
cd apps/web
bun run dev
```

| URL | 画面 | 役割 |
|---|---|---|
| `/` | 参加者画面 | 計算資源を貸す側。QRの飛び先にする予定 |
| `/requester` | 発表者画面 | 推論をリクエストする側。URLを直打ちする |

画面の下端に **開発用パネル** が出ます(本番ビルドでは出ません)。

- `PHASE` の7つのボタン … 任意の状態へ飛ぶ。エラーや再編成中の見た目はここから確認する
- `ROSTER` の3つのボタン … ピアを足す/抜く、生成を開始する

**「ピアを抜く」を押すと再編成が起きます。** ここがフロントで一番作り込みが要る箇所なので、何度でも試せるようにしてあります。

## 画面が通る7つの状態

参加者と発表者は**同じ順で同じ状態を通ります**。違うのは各状態で何をしているかだけです。

```
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

```
トラックA  ダウンロード ─────────────────→ 完了
トラックB  preparing → waiting → connecting → active
                                              ↓
                          両方そろって初めて入力欄が開く
```

つまり入力欄が使えるかどうかは `phase === "active" && modelReady` の **AND** です。片方だけでは開きません。

## ディレクトリ

```
apps/web/src/
├── App.tsx                    パスで役割を分ける(分岐はここ1か所だけ)
├── index.css                  配色トークンと素の要素のリセットだけ
├── config.ts                  総層数・モデル名・WSのパス
├── types/cluster.ts           Phase・ClusterState・LayerAssignment
├── hooks/
│   ├── clusterReducer.ts      状態遷移のルール
│   ├── useCluster.ts          両画面が状態に触る唯一の入口
│   └── useHonoSocket.mock.ts  Honoの代わり。本物と同じ形を返す
├── lib/
│   ├── clientId.ts            localStorageに保存するclientId
│   ├── assignments.ts         層の割り当ての仮置き(表示専用)
│   └── format.ts              バイト数・件数の表示
├── components/                両画面で使う部品。1部品1フォルダ相当
│   ├── TopBar / StatusBlock / LayerBar / ProgressBar / Metric / DevPanel
└── views/
    ├── PeerView.tsx
    └── RequesterView.tsx
```

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

## 本物のHonoに繋ぎ込む手順(ステップ3)

1. `src/hooks/useHonoSocket.ts` を作る。返り値の形は `useHonoSocket.mock.ts` の `HonoSocket` と完全に同じにする
2. `useCluster.ts` の import を1行差し替える

```diff
- import { useHonoSocketMock as useHonoSocket } from "./useHonoSocket.mock";
+ import { useHonoSocket } from "./useHonoSocket";
```

**ビューは1行も変わりません。** モックを噛ませてあるのはこのためです。

## 分担

`components/` と `hooks/` を先に固めてあるので、あとはビュー単位で分かれれば衝突しません。

| 範囲 | 内容 |
|---|---|
| `views/PeerView.*` | 参加フォーム、貢献中の演出、離脱 |
| `views/RequesterView.*` | チャット、ピア一覧、モデルの進捗 |
| `components/` `hooks/` | 共通。触るときは一声かける |

## 他の担当への依頼

### ②(Honoサーバ)へ

1. **`generation_start` を発火させる条件が未実装です。** 今はコメントが残るだけで誰も呼んでいません。これが呼ばれないとフロントは `waiting` から一切進めません
2. **HTTPS化(secure context)が必要です。** 会場LANで `http://192.168.x.x` のまま配信すると、WebGPU・pthread(SharedArrayBuffer)・WebRTC がすべて使えません。`localhost` だけが例外なので、開発中は気づきません
3. **未知のパスに `index.html` を返すフォールバックが要ります。** URLだけで役割を分けているので、`/requester` を直接開くと404になります

なお開発サーバー側のCOOP/COEPヘッダは `vite.config.ts` に入れてあります。本番のHono側と揃えてください。

### ①(コア分散基盤)へ

余裕があれば、という前提の依頼です。無くても画面は成立します。

1. `getLayerAssignment()` … 各ピアの担当層。無い場合は層番号の表示を諦めます
2. `onComputeStart` / `onComputeEnd` … 参加者側で「自分の番」が来た/終わったの通知。あると処理回数・処理時間・脈動が実測になります。無い場合は `RTCPeerConnection.getStats()` の250ms間隔ポーリングで粗く代替します

**今の層の割り当ては均等割りの仮置きです**([`lib/assignments.ts`](../apps/web/src/lib/assignments.ts))。表示専用で、割り当ての決定には使っていません。本物の配分はllama.cppが空きメモリから比例配分します(`AGENTS.md` のアーキテクチャ前提3)。

## ダミーで動いている部分の一覧

繋ぎ込みのときに差し替える箇所です。

| 場所 | 今 | 本物 |
|---|---|---|
| `useHonoSocket.mock.ts` | 固定のピア2人 + 自分 | Honoの `/ws` |
| `lib/assignments.ts` | 均等割り | ①の `getLayerAssignment()` |
| `PeerView` のエンジン起動 | 2.2秒の `setTimeout` | ①の `startWasmPeerServer()` |
| `PeerView` の処理回数・受信量 | 乱数 | `getStats()` または ①のフック |
| `RequesterView` のモデルDL | 一定速度のタイマー | `fetch` + `ReadableStream` の実測 |
| `RequesterView` の生成 | 固定文を1文字ずつ | ①の `onToken()` |
| `RequesterView` の「計算中」の移動 | 12文字ごとに次のピアへ | ①の `onPeerTurn()` |

## 次にやること

1. QRコードの表示(参加者を集める導線)
2. 本物のWebSocketへの繋ぎ込み(②の完成後)
3. WebRTCのシグナリング(②の完成後)
