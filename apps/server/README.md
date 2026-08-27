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

## 本番デモの証明書(#23)

開発用の mkcert は **rootCA を入れた端末でしか信頼されない**。会場で飛び入り参加する
他人のPCやスマホでは証明書警告が出る。これを消すために、本番デモでは
**実在ドメイン + Let's Encrypt** を使う(issue #23 の方式A)。

### しくみ

1. 公開DNSに「ドメイン → 会場のLAN IP」のAレコードを置く。公開DNSがプライベートIPを
   返すのは規格上ふつうに許されている
2. 証明書は **DNS-01** で取る。TXTレコードを一時的に置けるかだけを見られるので、
   **サーバが外部から到達可能である必要がない**(HTTP-01 との違い)
3. 参加者の端末は公開DNSで名前を引き、会場LAN内のHonoに直接つながる。証明書は
   Let's Encrypt 製なのでどの端末でも警告ゼロ

ネットに出るのは名前解決だけで、モデル配布も推論のテンソルも会場LANから出ない
(`AGENTS.md` 前提2は維持)。

### 事前準備(自宅で1回だけ)

証明書は**ドメインに対して**出るので、IPが変わっても取り直しは要らない。

```bash
# Cloudflare の Zone:DNS:Edit 権限のトークン
export CF_Token="..."
acme.sh --issue --dns dns_cf -d llm.example.com
acme.sh --install-cert -d llm.example.com \
  --fullchain-file "$(pwd)/certs/prod/cert.pem" \
  --key-file       "$(pwd)/certs/prod/key.pem"
```

Aレコードは Cloudflare の管理画面で1件作っておく。**必ず「DNS only」(灰色の雲)**に
すること。プロキシ(橙色の雲)だとCloudflareのエッジ経由になり、プライベートIPを
返せないうえ通信も会場LANから出てしまう。

### 当日の手順

`docs/demo-checklist.md` に順番だけ並べてある。焦っているときはそちらを見る。

```bash
# 1. 会場Wi-Fiにつないでから、Aレコードを今のLAN IPに更新
CF_API_TOKEN=... CF_ZONE_ID=... CF_RECORD_NAME=llm.example.com bun run dns

# 2. 本番証明書と公開オリジンを指定して起動
TLS_CERT=./certs/prod/cert.pem \
TLS_KEY=./certs/prod/key.pem \
PUBLIC_ORIGIN=https://llm.example.com:8443 \
bun run dev
```

### 環境変数

| 変数 | 用途 |
|---|---|
| `TLS_CERT` / `TLS_KEY` | 証明書のパス。既定は `./certs/{cert,key}.pem`(mkcert用) |
| `PUBLIC_ORIGIN` | 参加者に配るオリジン。`/join-info` の先頭に入り、QRの既定値になる |
| `CF_API_TOKEN` / `CF_ZONE_ID` / `CF_RECORD_NAME` | `bun run dns` 用 |

**`TLS_CERT` / `TLS_KEY` を分けてあるのは事故防止のため。** 既定のパスのままだと、
会場で何かの拍子に `bun run setup`(= `bun run cert`)を叩いた瞬間に本番証明書が
mkcert産に上書きされ、全端末に警告が出る。本番用は `certs/prod/` に置いて分離する。

`PUBLIC_ORIGIN` を設定しても **LAN IPのURLは候補から消えない**。会場のDNSが
プライベートIPへの応答を捨てる場合(下記)に、発表者画面のQRを切り替えて
退避できるようにしてある。

### 会場でうまくいかないとき

いちばん多い原因は **DNSリバインディング保護**。一部のルータ・リゾルバは
「公開DNSの応答にプライベートIPが入っていたら捨てる」ため、名前解決自体ができない。
会場のリゾルバは変えられないので、**その場では直せない**。

その場合は発表者画面のQRをLAN IPの候補に切り替え、参加者に証明書警告の
クリックスルーを案内する(issue #23 の方式C相当)。案内文は
`docs/demo-checklist.md` に用意してある。

**会場に事前に入れるなら、必ず会場Wi-Fiにつないだ端末で名前解決を試しておくこと。**
これが通れば本番も通る。
