# 用語集

| 用語 | 意味 |
|---|---|
| llama.cpp | LLM推論エンジン(C/C++)。プロジェクトの心臓部 |
| GGUF | モデル重みを1ファイルにまとめたフォーマット。多くは量子化済み |
| 量子化 | 数値精度を落とし(32bit→4bit等)ファイルサイズ削減。精度は多少低下 |
| 層(レイヤ)/Transformerブロック | LLM内部で反復する構成要素。層単位でPCに分割配置可能 |
| RPC (rpc-server) | llama.cppの層計算を別マシンに委任する仕組み |
| activation(活性化) | ある層の計算結果として次の層に渡される数値データ(テンソル) |
| WASM | C/C++コードをブラウザで高速実行できる形式 |
| WebGPU | ブラウザから直接GPUを使うAPI |
| WebRTC | ブラウザ同士がサーバー非経由で直接データ通信できるP2P技術。DataChannelでバイナリ送受信 |
| DataChannel | WebRTC確立後の任意バイナリ送受信チャンネル。RPC実データを流す |
| シグナリング | WebRTC接続確立に必要なSDP/ICE candidateの事前交換。今回はHonoのWebSocketで仲介 |
| SDP / ICE | SDP=接続情報の記述文書。ICE=通信経路(候補)の探索 |
| STUN / TURN | WebRTCのNAT越え補助サーバー。同一LAN内では基本不要 |
| 制御プレーン / データプレーン | 「軽い指示・状態」と「重い計算データ」の区別 |
| 世代(generation)番号 | ピア増減ごとに増える編成バージョン番号。古い編成の結果を安全に無視するため使用 |
| グルーコード(glue code) | `.wasm`ロード用の`.js`ローダー。メモリ確保・Worker起動・JS↔C橋渡し |
| 判別可能ユニオン型(discriminated union) | `type`フィールドでメッセージ種別を区別するTS型パターン |
| COOP / COEP | Cross-Origin-Opener/Embedder-Policy。WASM pthread利用に必須のHTTPヘッダ |
| モノレポ / Bun workspaces | 複数パッケージを1リポジトリで管理。`bun install`一発で依存解決 |
