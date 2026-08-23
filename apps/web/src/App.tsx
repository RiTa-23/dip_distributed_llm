import { PeerView } from "./views/PeerView";
import { RequesterView } from "./views/RequesterView";

/**
 * ルーティングはURLだけで役割を分ける。入口で選ばせる画面は作らない。
 *   /           参加者(計算資源を貸す側)。QRの飛び先
 *   /requester  発表者(推論をリクエストする側)。URL直打ち
 * 分岐がこのファイル1か所に閉じているため、方式を変えても下流は変わらない。
 */
export default function App() {
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path === "/requester") return <RequesterView />;
  return <PeerView />;
}
