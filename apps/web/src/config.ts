/** 両画面が使う定数。散らばらないようここ1か所に置く。 */

/** Honoの制御プレーン。ステップ3で useHonoSocket が使う */
export const WS_PATH = "/ws";

/** モデルの層数。本来は①のWASMから取れるはずの値で、今は仮置き */
export const TOTAL_LAYERS = 32;

export const MODEL_NAME = "qwen2.5-1.5b-instruct-q4_k_m.gguf";

/** 表示名の初期値。参加者が書き換える */
export const DEFAULT_DISPLAY_NAME = "参加者のPC";

/**
 * 再編成中がこれだけ続いたら、画面に案内と繋ぎ直しの導線を出す(#63)。
 *
 * 正常な再編成でも待ち時間はある。増えた側のエンジン起動が終わるまで
 * Honoは次の `generation_start` を出せないため、既存の参加者はそのあいだ
 * 再編成中で止まる(今のダミー起動で2.2秒、①のWASMが載ればもう少し伸びる)。
 * それを踏まえて余裕をとった値で、正常系でこの案内が出てはいけない。
 */
export const REORGANIZING_STALL_MS = 12_000;

/**
 * 発表者の配布中(connecting)がこれだけ続いたら、編成が成立しなかったとみなして
 * `generation_failed` を送る(#78の実機確認で判明した穴)。
 *
 * 参加者がanswerを返さないまま黙って落ちると、発表者の `RTCPeerConnection` は
 * ICEが諦めるまで `connectionState` が `failed` にならない(30秒以上かかる)。
 * その間 Honoから見た phase は active のままなので、落ちた参加者が
 * `peer_status: "error"` を送っていても(#79)編成は組み直されない。
 *
 * ここで測るのはDataChannelの開通だけで、モデルのダウンロードは別トラック
 * (編成の進行とは独立に進む)なので、その所要時間は勘定に入れない。
 * 会場LANのWebRTCが数秒かかることを見込んでも、この長さなら正常系では出ない。
 */
export const CONNECT_STALL_MS = 10_000;

/**
 * `/ws` の接続先の上書き。既定(空文字)では画面を配信しているオリジンへ繋ぐ。
 * viteのdevサーバ(5173)とHono(8443)を別々に動かすときだけ使う。
 *   例: VITE_HONO_WS_URL=wss://localhost:8443/ws bun run dev
 *
 * VITE_HONO_ORIGIN を指定した場合はviteが `/ws` をプロキシするので、こちらは要らない。
 */
export const WS_URL_OVERRIDE: string = String(import.meta.env.VITE_HONO_WS_URL ?? "");

/**
 * 参加URLをHonoに問い合わせるパス。QRの中身になる(サーバの `/join-info`)。
 *
 * 常に同一オリジンへ投げる。別オリジンのHonoを直接叩くとCORSで弾かれるため、
 * dev中に本物のLAN IPで試したいときは vite.config.ts のプロキシを使う。
 *   例: VITE_HONO_ORIGIN=https://localhost:8443 bun run dev
 */
export const JOIN_INFO_PATH = "/join-info";

/**
 * 制御プレーンをモックで動かすかどうか。
 *
 * 既定は本物(`useHonoSocket`)。②の `/ws`(#16〜#19)がマージされ、実機で
 * hello → roster_update → generation_start → 切断 → 再接続 まで通ったため、
 * 2026/8/25にモックから既定を倒した。
 *
 * モックへ戻すとき: `VITE_MOCK_SOCKET=1 bun run dev`
 * Honoを別プロセスで動かすとき: `VITE_HONO_ORIGIN=http://localhost:3000 bun run dev`
 *
 * モックはまだ消さない。Honoを起動せずに再編成の見た目を確認する用途と、
 * DevPanelのROSTERボタン(ピアの増減を手で起こす)がモック側にしかないため。
 */
export const USE_MOCK_SOCKET: boolean = import.meta.env.VITE_MOCK_SOCKET === "1";

/**
 * 参加者画面の計測を作り物に戻すかどうか。
 *
 * 既定は実測(`hooks/usePeerStats.ts` が PeerManager の数え上げを読む)。ただし
 * 実測はデータプレーンに実際にバイトが流れて初めて動くので、①のWASMが載って
 * いない状態では3つとも0のまま(画面には `—`)になる。
 *
 * デモで「それらしく動いて見える」状態が要るときだけ、これで乱数へ戻す:
 *   VITE_FAKE_METRICS=1 bun run dev
 *
 * `USE_MOCK_SOCKET` と同じ形にしてある。返り値の形は実測と同じなので、
 * `PeerView` 側は1行も変わらない。
 */
export const FAKE_METRICS: boolean = import.meta.env.VITE_FAKE_METRICS === "1";

/**
 * ①のWASM(llmletのビルド)を読み込む先。Honoは `./public/wasm` をここへ配信する
 * (`apps/server/src/index.ts`)。**まだビルドが置かれていないので今は404**で、
 * そのときは起動処理がダミー経路へ落ちる(`webrtc/wasmEngine.ts`)。
 *
 * 読み込むのは静的配信されたグルーコードだけで、RPCの実データはHonoを通さず
 * DataChannelを流れる(AGENTS.md 前提2)。
 */
export const WASM_MODULE_URL = "/wasm/llmlet-mod.js";
