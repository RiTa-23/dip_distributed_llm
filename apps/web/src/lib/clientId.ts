import type { Role } from "@dip_distributed_llm/shared-types/messages";

/**
 * clientIdの保存先は役割ごとに分ける。
 *
 * 1つのキーを両画面で共有すると、同じブラウザで `/` と `/requester` を開いたときに
 * 参加者と発表者が同一のclientIdを名乗る。Honoは「同一clientIdの張り替え(リロード)」
 * と解釈して先に繋いだ側のソケットを捨てるため、発表者がロスターを受け取れなくなり、
 * `generation_start` も発火しない(requesterが居ない扱いになるため)。
 * 2026/8/25、本物の `/ws` へ繋いだ実機確認で判明した。
 */
const KEYS: Record<Role, string> = {
  peer: "dip.clientId.peer",
  requester: "dip.clientId.requester",
};

/**
 * crypto.randomUUID はsecure contextでしか存在しない。
 * 会場LANをHTTPで開くと undefined になり、呼ぶとアプリごと落ちて画面が真っ白になる。
 * そうなると「HTTPSで開き直してください」という案内すら出せないので、必ず値を返す。
 *
 * crypto.getRandomValues の方はsecure contextでなくても使える。
 */
export function randomId(): string {
  if (typeof crypto !== "undefined") {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    if (typeof crypto.getRandomValues === "function") {
      const b = crypto.getRandomValues(new Uint8Array(16));
      return Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
    }
  }
  // ここまで来ることはまずないが、IDが無いと名乗れないので最後の手段
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 14)}`;
}

/**
 * clientIdはlocalStorageに残す。
 * 毎回作り直すと、リロードのたびに別人としてロスターに載り、
 * 抜けたはずの参加者が残り続ける。
 */
export function getClientId(role: Role): string {
  const key = KEYS[role];
  const saved = localStorage.getItem(key);
  if (saved) return saved;
  const id = randomId();
  localStorage.setItem(key, id);
  return id;
}
