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
  - Windows: `winget install FiloSottile.mkcert`(Windows 11 標準の winget を推奨)
    - インストール直後は PATH が反映されていないので、ターミナルを開き直すこと
    - choco / scoop を使っているなら `choco install mkcert` / `scoop install mkcert` でも可
- 各スクリプト(`cert` / `dummy-model` / `web:copy`)はBunで動くTypeScriptで書かれており、OS依存のコマンド(`route`/`ipconfig`/`cp -r`等)には頼らない(#30)。LAN IPの検出も[`src/lanAddress.ts`](src/lanAddress.ts)(`os.networkInterfaces()`)を共用している。**macOS・Windows 11 の両方で実機確認済み**(#30)。Windows側は Windows 11 Home (26200) / Bun 1.3.14 / mkcert 1.4.4 で、`bun run cert`(検出したLAN IPが証明書SANに入ること)・`bun run setup` の完走・HTTPS 8443での起動・COOP/COEPヘッダの付与まで確認した。ただし `crossOriginIsolated === true` の実ブラウザでの直接確認だけは行っていない(成立条件のsecure context・COOP・COEPは揃っているが、実測ではない)
- 別PCから HTTPS でテストする場合は、検出されなかったホスト(LAN IP)を引数で追加できる: `bun run cert 192.168.11.5`
- 証明書・モデル・`web-dist` は `.gitignore` 済み(各自ローカルで用意)

## 起動

```bash
bun run dev
```

- 証明書があれば `https://localhost:8443`、無ければ `http://localhost:3000`(`PORT` で変更可)
- **フロント・`/ws`・モデルを 1 つの HTTPS オリジンから配信する**(単一オリジン)。
  自己署名/独自証明書で `wss` が無言失敗するのを防ぐため。
- Windowsのcurlで疎通確認すると、TLS自体は正しいのに
  `curl: (35) schannel: ... CRYPT_E_NO_REVOCATION_CHECK` で落ちる。
  mkcertが発行する証明書には失効情報(CRL配布点/OCSP URL)が無く、
  Windowsのschannelは「失効確認ができないこと」自体をエラーにするため。
  **ローカルのmkcert証明書を叩くときに限り** `curl --ssl-no-revoke` で回避できる
  (失効確認を無効化するオプションなので、公開CAの証明書に対して常用しないこと)。
  ブラウザは失効情報を持たない証明書を確認不能として通すため、この現象は踏まない。
  ただし確認したのは macOS の Chrome のみで、Windows のブラウザでは未確認

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
