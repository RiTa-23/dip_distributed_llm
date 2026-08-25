# @dip_distributed_llm/server

Hono コーディネータ。静的配信(React成果物 / GGUF / WASM)・COOP/COEPヘッダ付与・
`/ws`(制御メッセージ / WebRTCシグナリング取り次ぎ・**P1で実装**)・ロスター管理を担う。
実データ(モデル重み・テンソル)は Hono を経由せず、requester⇔peer 間の WebRTC DataChannel で
直接 P2P 通信する(`AGENTS.md` 前提2)。

## セットアップ(初回)

```bash
# リポジトリルートで依存インストール
bun install

# 証明書・ダミーモデル・フロント成果物をまとめて用意
cd apps/server
bun run setup
```

`bun run setup` は以下を実行する:

| 手順 | スクリプト | 内容 |
|---|---|---|
| TLS証明書 | `bun run cert` | mkcert でローカルCA導入 + `certs/{cert,key}.pem` 生成(#14) |
| ダミーモデル | `bun run dummy-model` | `public/models/qwen2.5-1.5b-instruct-q4_k_m.gguf` を生成(#12) |
| フロント配置 | `bun run web:copy` | `apps/web` をビルドし `public/web-dist/` にコピー(単一オリジン配信) |

- 事前に [mkcert](https://github.com/FiloSottile/mkcert) が必要
  - macOS: `brew install mkcert nss`
  - Windows: `choco install mkcert`(または `scoop install mkcert`)
- 各スクリプト(`cert` / `dummy-model` / `web:copy`)はBunで動くTypeScriptで書かれており、macOS/Windows/Linuxで同じように動く(#30)。LAN IPの検出も[`src/lanAddress.ts`](src/lanAddress.ts)(`os.networkInterfaces()`)を共用しており、OS依存のコマンド(`route`/`ipconfig`/`cp -r`等)には頼らない
- 別PCから HTTPS でテストする場合は、検出されなかったホスト(LAN IP)を引数で追加できる: `bun run cert 192.168.11.5`
- 証明書・モデル・`web-dist` は `.gitignore` 済み(各自ローカルで用意)

## 起動

```bash
bun run dev
```

- 証明書があれば `https://localhost:8443`、無ければ `http://localhost:3000`(`PORT` で変更可)
- **フロント・`/ws`・モデルを 1 つの HTTPS オリジンから配信する**(単一オリジン)。
  自己署名/独自証明書で `wss` が無言失敗するのを防ぐため。

## 配信ルート

| パス | 配信元 | 備考 |
|---|---|---|
| `/join-info` | (NICから生成) | 参加者に配るURLの候補。発表者画面のQRの中身(#28) |
| `/models/*` | `public/models/` | GGUF。無ければ 404 |
| `/wasm/*` | `public/wasm/`(①の成果物) | WASM/グルーコード。無ければ 404 |
| `/*` | `public/web-dist/` | React成果物 |
| 未知パス | `public/web-dist/index.html` | SPA フォールバック(例: `/requester` 直開き) |

全レスポンスに COOP/COEP(`same-origin` / `require-corp`)を付与(#13)。

`/join-info` は `os.networkInterfaces()` から会場LANのIPv4を割り出して返す([`src/lanAddress.ts`](src/lanAddress.ts))。ブラウザからは自分のLAN IPが分からず、`window.location.origin` をQRに入れると発表者が localhost で開いた場合に壊れるため。
候補は `192.168.x` → `10.x` → その他の順(172.16-31 は仮想NICが混ざるため後ろ)。

## 本番デモの証明書について

開発は mkcert(rootCA 導入済み端末でのみ警告ゼロ)。**飛び入り参加者の警告ゼロ化は #23 で別途対応**。
TLS 配信コードは証明書ファイルの差し替えのみで共通なので、方式選択はコードを縛らない。
