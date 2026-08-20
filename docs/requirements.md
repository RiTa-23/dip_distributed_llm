# 要件定義・アーキテクチャ・課題点

## 概要

会場LAN内で複数ブラウザ(PC)の計算資源を束ね、1つの大きなLLMを分散推論させるハッカソンプロジェクト。参加PCが増えるほど大きい/賢いモデルが動く。

## スコープ

| 項目 | 決定 |
|---|---|
| 通信範囲 | 会場LAN内のみ。インターネット越し通信なし |
| 推論リクエスト人数 | 同時1人固定。複数人同時対応はしない |
| ピアの増減 | 次の生成開始タイミングでのみ反映。生成中のトークン単位では反映しない |
| クラウドサービス | 不使用(Cloudflare Durable Objects等も不採用) |

## アーキテクチャ

```
requester(要求元ブラウザ・1人固定)
 - WASM版llama.cpp(rpc-client役 = オーケストレータ)
 - Honoから完全なGGUFを1回HTTPダウンロード
 - 各peerとWebRTC DataChannelで直接P2P通信

Hono(1プロセス)
 - 静的配信: Reactビルド成果物 / GGUF本体 / wasm・jsグルーコード
 - /ws: 制御メッセージ(JSON) + WebRTCシグナリング(SDP/ICE取り次ぎのみ)
 - ロスター管理

peer(貢献側ブラウザ・複数・動的増減)
 - WASM版llama.cpp(rpc-server役 = 計算リソース提供のみ)
 - requesterとWebRTCで直接接続
```

星型トポロジー: requesterが全peerに個別接続。peer間の直接通信はない(llama.cppのRPC自体が星型設計のため)。

## 技術スタック

| 技術 | 役割 |
|---|---|
| React | フロントエンド(requester画面/peer画面) |
| Hono | ロスター管理・WebRTCシグナリング仲介 |
| WebSocket | Hono⇔ブラウザの制御メッセージ・シグナリング |
| WebRTC (DataChannel) | requester⇔peer間の実データ(RPC通信)、P2P |
| llama.cpp (RPCモード) | 分散推論エンジン本体 |
| WebAssembly (WASM) | llama.cppのブラウザ実行形式 |
| WebGPU | GPU高速化(非対応ならCPUフォールバック) |

## 通信の2層分離

- **制御プレーン**: Hono経由WebSocket。ロスター・生成開始合図・WebRTCシグナリング(SDP/ICE)のみ。軽量
- **データプレーン**: requester⇔peer間WebRTC DataChannel。RPCの実データ(モデル重み・テンソル)。Honoを経由しない

Honoにデータを中継させない(経由すると無線LAN区間を実質2回通過しボトルネックになるため)。

## モデル配布

requesterが完全なGGUFをロードし、WebRTC DataChannel経由で各peerへテンソルを直接送信。peerは事前にGGUFを持つ必要がない。Honoは完全なGGUFファイル1つを静的配信するだけでよい。

## llmlet(参考先行事例)との関係

[llmlet](https://github.com/ktock/llmlet): WASM版llama.cpp + WebRTCでのブラウザ分散。実証済み事実:
- llama.cppは公式にWasmコンパイル+WebGPU対応済み
- llmletがRPCバックエンドにWebRTC向けパッチを当てている(今回のベースにできる)
- 2GBヒープ上限(CPUバックエンド)
- pthread利用のためCOOP/COEPヘッダ必須
- 並列化未対応(逐次評価)、1サーバは同時に複数クライアント処理不可(今回の要件と一致)

今回の差分: 自前Honoでシグナリング完結(llmletは外部PeerJS依存)、generation番号による動的再構成(llmletに設計なし)、UI/UX作り込み。

## 課題点

| # | 課題 | 補足 |
|---|---|---|
| 1 | WebRTC向けRPCパッチの流用可否 | llmletのパッチをシグナリングだけHono経由に差し替え可能か、最優先検証 |
| 2 | WebGPUバックエンドの対応範囲 | 未対応演算があればCPU(ヒープ上限2GB)フォールバック |
| 3 | 無線LANのボトルネック | モデル重み初回配布(GB単位)が最重量 |
| 4 | レイヤ割り当て | llama.cpp本体の自動配分(RPC接続時に空きメモリ自動問い合わせ、比例配分)に任せる。モデルロード時1回限り、ロード後の再配分なし |
| 5 | COOP/COEPヘッダ設定 | pthread利用のため必須 |
| 6 | ピア切断時のリカバリ | 生成中断→次の編成で自動リトライ、冗長化なし |
| 7 | デモ不動作時のフォールバック | 層分割を諦め単純タスク分散に切替等、初日に合意 |
