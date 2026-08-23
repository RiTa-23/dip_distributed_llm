const KEY = "dip.clientId";

/**
 * clientIdはlocalStorageに残す。
 * 毎回 crypto.randomUUID() を呼ぶと、リロードのたびに別人として
 * ロスターに載り、抜けたはずの参加者が残り続ける。
 */
export function getClientId(): string {
  const saved = localStorage.getItem(KEY);
  if (saved) return saved;
  const id = crypto.randomUUID();
  localStorage.setItem(KEY, id);
  return id;
}
