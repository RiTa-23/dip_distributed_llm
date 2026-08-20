# 技術選定の理由

## React
- チームの前提知識・学習コストを優先。requester/peer2画面をコンポーネント単位で分担しやすい
- 通信ロジックはカスタムフック(`useHonoSocket`)に隠蔽し、初心者担当者は画面実装に集中できる

## Bun
- TypeScriptをそのまま実行、ビルド設定の手間が少ない
- `hono/bun`でWebSocket標準サポート
- Bun workspacesでモノレポ(`apps/web` / `apps/server` / `packages/shared-types`)を一括管理
- 不採用: Node.js(セットアップの手数が多い)

## Hono
- Bun/React(TypeScript)と同一言語。`packages/shared-types`の型を両側でimport可能
- 静的配信(`serveStatic`)とWebSocket(`upgradeWebSocket`)を1アプリで両対応
- 不採用: Go — 当初「重いバイナリデータをHonoが中継するならGoが有利」と検討したが、実データはWebRTC DataChannelでP2P直接通信する設計に変更したため、Honoが扱うのは軽量JSON(ロスター・シグナリング)のみとなり、言語間パフォーマンス差は問題にならない

## WebSocket(制御プレーン)
- 双方向・リアルタイムな状態配信に適する。接続確立がHTTPアップグレード1往復で完結
- 不採用: WebSocketのみで実データも扱う(Hono中継) — ブラウザはWSサーバーを立てられずpeer間直結不可。Honoが実データまで中継すると無線LAN区間を実質2回通過しボトルネックになる

## WebRTC(データプレーン)
- ブラウザ間直接P2P通信の唯一の標準技術。実データでHono非経由
- 同一LAN内はSTUN/TURN不要
- シグナリングは既存Hono WebSocketで完結、外部サービス不要
- 不採用: WebRTCなしWebSocket+Hono中継のみ — 接続確立の遅さ(数百ms〜数秒)は要件上問題ないが、Hono中継による無線帯域消費増大がデモ体感速度に直接影響すると判断

## まとめ

| レイヤ | 技術 | 理由 |
|---|---|---|
| フロントエンド | React + Bun | チームの前提知識と開発速度 |
| バックエンド | Hono + Bun | フロントと同言語、静的配信+WS両対応 |
| 制御プレーン | WebSocket | 軽量な状態同期・シグナリング取り次ぎ |
| データプレーン | WebRTC | ブラウザ間直接P2P通信 |
