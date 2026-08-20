# ディレクトリ構成

```
repo/
├── apps/
│   ├── web/                 # React (requester画面 / peer参加画面)
│   └── server/               # Hono コーディネータ
├── packages/
│   └── shared-types/          # WebSocketメッセージ契約の型定義
├── native/
│   ├── llama.cpp/             # gitサブモジュール(WASM + WebRTC向けRPCパッチ)
│   └── Makefile / Dockerfile
└── package.json               # Bun workspaces
```

| フォルダ | 役割 | 担当 |
|---|---|---|
| apps/web/ | requester用チャットUI・peer用貢献側UI | ③④ |
| apps/server/ | ロスター管理・WebRTCシグナリング取り次ぎ・静的配信 | ② |
| packages/shared-types/ | 共通メッセージ型定義(messages.ts) | ②③④共通、①も参照 |
| native/ | WASM版llama.cpp・RPCパッチのビルド。Bun管理外(別ビルドパイプライン) | ① |

## Bun workspaces設定

```json
{
  "name": "distributed-llm",
  "private": true,
  "workspaces": ["apps/*", "packages/*"]
}
```

## パッケージ名対応

| フォルダ | package.jsonのname |
|---|---|
| apps/web/ | @dip_distributed_llm/web |
| apps/server/ | @dip_distributed_llm/server |
| packages/shared-types/ | @dip_distributed_llm/shared-types |

`apps/web`・`apps/server`から `import ... from '@dip_distributed_llm/shared-types/messages'` でimport可能(bun installがシンボリックリンクを自動生成)。

## 採用理由(要点)

- apps/=実行単位、packages/=共有ライブラリという区分で拡張時の置き場所に迷わない
- Turborepo等の一般的規約に沿う
- native/はEmscriptenという別ツールチェーンでビルドし、成果物(.wasm/.js)をapps/serverが静的配信する静的ファイルとして扱うため、Bun workspacesに含めない
