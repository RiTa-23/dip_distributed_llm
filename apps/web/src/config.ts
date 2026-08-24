/** 両画面が使う定数。散らばらないようここ1か所に置く。 */

/** Honoの制御プレーン。ステップ3で useHonoSocket が使う */
export const WS_PATH = "/ws";

/** モデルの層数。本来は①のWASMから取れるはずの値で、今は仮置き */
export const TOTAL_LAYERS = 32;

export const MODEL_NAME = "qwen2.5-1.5b-instruct-q4_k_m.gguf";

/** 表示名の初期値。参加者が書き換える */
export const DEFAULT_DISPLAY_NAME = "参加者のPC";

/**
 * `/ws` の接続先の上書き。既定(空文字)では画面を配信しているオリジンへ繋ぐ。
 * viteのdevサーバ(5173)とHono(8443)を別々に動かすときだけ使う。
 *   例: VITE_HONO_WS_URL=wss://localhost:8443/ws bun run dev
 */
export const WS_URL_OVERRIDE: string = String(import.meta.env.VITE_HONO_WS_URL ?? "");

/** 参加URLをHonoに問い合わせるパス。QRの中身になる(サーバの `/join-info`) */
export const JOIN_INFO_PATH = "/join-info";

/**
 * `/join-info` の問い合わせ先の上書き。既定(空文字)では同一オリジンへ問い合わせる。
 * viteのdevサーバ単体では `/join-info` が無く、同一オリジンのURLへ落ちる。
 * dev中も本物のLAN IPでQRを試したいときだけ使う。
 *   例: VITE_JOIN_INFO_URL=https://localhost:8443/join-info bun run dev
 */
export const JOIN_INFO_URL_OVERRIDE: string = String(import.meta.env.VITE_JOIN_INFO_URL ?? "");

/**
 * 制御プレーンをモックで動かすかどうか。
 *
 * Honoの `/ws` はまだ404を返すスタブなので、既定はモックのまま。
 * 本物へ繋ぐとき: `VITE_MOCK_SOCKET=0 bun run dev`
 * ②の #16〜#19 がマージされたら、この既定値を本物側へ倒す。
 */
export const USE_MOCK_SOCKET: boolean = import.meta.env.VITE_MOCK_SOCKET !== "0";
