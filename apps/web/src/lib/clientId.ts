const KEY = "dip.clientId";

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
export function getClientId(): string {
  const saved = localStorage.getItem(KEY);
  if (saved) return saved;
  const id = randomId();
  localStorage.setItem(KEY, id);
  return id;
}
