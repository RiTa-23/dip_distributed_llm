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

### 何が外に出て、何が出ないか

| 通信 | 外に出るか | いつ |
|---|---|---|
| 参加者端末からの名前解決(ドメイン → LAN IP) | **出る** | 参加のたび |
| `bun run dns` によるAレコードの検索・更新(Cloudflare API) | **出る** | 発表者PCから、当日1回 |
| `acme.sh` による証明書の取得(Let's Encrypt / Cloudflare API) | **出る** | 発表者PCから、事前に |
| モデル配布・推論のテンソル(データプレーン) | **出ない** | — |
| `/ws` の制御メッセージ・WebRTCシグナリング | **出ない** | — |

**参加者の通信で外に出るのは名前解決だけ**で、モデル配布も推論のテンソルも会場LANに
留まる(`AGENTS.md` 前提2は維持)。発表者PCは準備と当日の設定でCloudflare APIへ
外向き通信を行う。

### 事前準備(証明書の取得)

証明書は**ドメインに対して**出るので、IPが変わっても取り直しは要らない。ただし
**Let's Encrypt の有効期限は90日**なので、「1回取れば永久に使える」わけではない。

```bash
# Cloudflare の Zone:DNS:Edit 権限のトークン
export CF_Token="..."
acme.sh --issue --dns dns_cf -d llm.example.com
acme.sh --install-cert -d llm.example.com \
  --fullchain-file "$(pwd)/certs/prod/cert.pem" \
  --key-file       "$(pwd)/certs/prod/key.pem"
```

**取得したら有効期限を確認する。** デモ当日に切れていると警告ゼロが崩れる。

```bash
openssl x509 -in certs/prod/cert.pem -noout -enddate -subject
```

`acme.sh` は導入時に自動更新の cron を仕込む。更新されると `--install-cert` で
指定した先のファイルも書き換わるが、**Bun.serve は起動時に証明書を読むので、
更新後は Hono の再起動が必要**。デモ直前に更新が走った場合は、起動し直して
起動ログの証明書パスと上の `-enddate` を見直すこと。

- [ ] `-enddate` がデモ日より後
- [ ] 更新後に Hono を再起動し、警告ゼロのまま開ける

Aレコードは Cloudflare の管理画面で1件作っておく。**必ず「DNS only」(灰色の雲)**に
すること。プロキシ(橙色の雲)だとCloudflareのエッジ経由になり、プライベートIPを
返せないうえ通信も会場LANから出てしまう。

### 当日の手順

`docs/demo-checklist.md` に順番だけ並べてある。焦っているときはそちらを見る。

```bash
# 1. 会場Wi-Fiにつないでから、Aレコードを今のLAN IPに更新
CF_API_TOKEN=... CF_ZONE_ID=... CF_RECORD_NAME=llm.example.com bun run dns

# 2. 起動するだけ。certs/prod/ があれば自動でそちらが使われる
bun run dev
```

**環境変数は要らない。** 当日に長いコマンドを打ち間違えないよう、証明書を置くだけで
デモ用の構成になるようにしてある。

ただし `TLS_CERT` と `TLS_KEY` が**両方**設定されていると、そちらが優先される
(下の「証明書の選ばれ方」を参照)。前の作業で export したまま同じシェルで起動すると
意図しない証明書が使われるので、起動ログで確かめること。

### 証明書の選ばれ方

起動時に上から順に探し、最初に見つかったものを使う。

| 優先 | 場所 | どういうときに使われるか |
|---|---|---|
| 1 | `TLS_CERT` / `TLS_KEY` | 明示指定。置き場所を自由にしたいとき |
| 2 | `certs/prod/{cert,key}.pem` | **本番デモ用。あればこれが既定** |
| 3 | `certs/{cert,key}.pem` | 開発用(mkcert)。`bun run cert` が生成する先 |
| — | (どれも無い) | HTTPで起動(CI・クイック確認用) |

起動ログにどれが選ばれたかが出るので、意図と違えばそこで気づける。

```text
証明書: ./certs/prod/cert.pem — 本番デモ用 certs/prod(公開CA。飛び入り参加者に警告が出ない)
参加URL: https://llm.example.com:8443 を既定にします
```

**開発用(mkcert)の使い方は今まで通り。** `certs/prod/` を置かなければ従来と同じ動作で、
ネットワークが無い場所でも `bun run cert` → `bun run dev` だけで完結する。

**`bun run cert` が本番証明書を壊すことはない。** 書き込む先が `certs/` で、本番用の
`certs/prod/` とは別だから。優先順位も変わらないので、会場で誤って叩いても
デモ用の構成のまま動き続ける。

### 参加者に配るURLの決まり方

`certs/prod/` の証明書を使っているときは、**その証明書のSANからドメインを読み取って**
QRの既定値にする。配布URLと証明書が食い違うと警告が出るので、設定を別に持たず
証明書そのものを情報源にしている。

mkcertの証明書はDNS名が `localhost` しか無いため、開発中は自然と従来通り
LAN IPのURLだけが返る。

**ドメインを使っていても LAN IPのURLは候補から消えない。** 会場のDNSが
プライベートIPへの応答を捨てる場合(下記)に、発表者画面のQRを切り替えて
退避できるようにしてある。

### 環境変数(すべて任意)

`.env.example` をコピーして `.env.local` に書けば、Bunが自動で読む。
起動時に並べる必要はない。**`.env.local` は `.gitignore` 済み。**

```bash
cp .env.example .env.local
```

| 変数 | 用途 |
|---|---|
| `TLS_CERT` / `TLS_KEY` | 証明書のパスを明示指定する。両方揃っているときだけ有効 |
| `PUBLIC_ORIGIN` | 参加者に配るオリジンを上書きする。既定は証明書から決まる |
| `PORT` | 待ち受けポート。既定は証明書があれば8443、無ければ3000 |
| `WS_PING_INTERVAL_SEC` | 生存確認のping間隔(秒)。既定30 |
| `CF_API_TOKEN` / `CF_ZONE_ID` / `CF_RECORD_NAME` | `bun run dns` 用。**ドメインの持ち主だけ** |

## 開発中、他のメンバーのPCでサーバーを立てる

ドメインの持ち主(以下「ホスト役」)のPCをリバースプロキシにすると、
**秘密鍵を配らずに**他のメンバーのPCでサーバーを立てられる。

```text
参加者の端末 ──https──▶ ホスト役のPC ──https──▶ 立てる人のPC
                        (Caddy)                (Hono / mkcert)
                        LE証明書はここだけ
```

**Aレコードはホスト役のPCを指したまま動かさない。** 立てる人が変わったら、
Caddyの転送先を1行変えるだけ。**同時に立てない前提**の運用。

- 証明書もCloudflareのトークンも**配らない**
- 立てる人は mkcert だけあればよい
- **全員が同じLANにいることが前提**(AレコードがプライベートIPを指すため)

### 立てる人がやること

```bash
bun install
bun run --cwd apps/server setup      # mkcert が要る
cp apps/server/.env.example apps/server/.env.local
```

`.env.local` に1行足す。

```dotenv
PUBLIC_ORIGIN=https://llm.example.com:8443
```

あとは `bun run --cwd apps/server dev`。

> **`bun run setup` は必ず通すこと。** 証明書なし(HTTP)で起動すると、
> `PUBLIC_ORIGIN` が `https://` と食い違って無視される(「参加者に配るURLの決まり方」を参照)。

### ホスト役がやること

```bash
brew install caddy
```

`Caddyfile` を書く(リポジトリには入れない)。

```caddyfile
{
	auto_https off
}

llm.example.com:8443 {
	tls /path/to/apps/server/certs/prod/cert.pem /path/to/apps/server/certs/prod/key.pem

	reverse_proxy https://member-mac.local:8443 {
		transport http {
			tls_insecure_skip_verify
		}
	}
}
```

```bash
caddy run --config Caddyfile
```

- `transport http { ... }` は**必ず複数行で書く。** 1行にまとめるとCaddyが構文エラーにする
- `tls_insecure_skip_verify` … 転送先がmkcertなので検証を省く。LAN内なので許容する
- 転送先は **`<ホスト名>.local` を推奨**。相手のIPが変わっても追随する(macOSは自動で名乗る)
- WebSocketの `Upgrade` はCaddyが自動で通す(v2は設定不要)

担当が変わったら転送先を書き換えて `caddy reload`。

**ホスト役自身が立てるときはCaddyを使わない。** 止めていつも通り `bun run dev` すれば、
ポートの取り合いも起きず今まで通り動く。

### 通る通信・通らない通信

| 通信 | ホスト役のPCを | 量 |
|---|---|---|
| 画面・`/ws` の制御メッセージ | **通る** | 小 |
| `/models/*`(GGUF) | **通る** | 開発中はダミーなので問題なし |
| WebRTCのテンソル・モデル配布 | **通らない**(P2P直結) | 大だが影響なし |

**推論の重いところは経由しない。**

### 弱点

- **ホスト役のPCが止まると、ドメイン経由では誰も開発できない**(スリープ含む)
- ホスト役のLAN IPが変わったら `bun run dns` でAレコードを更新する

これが重いなら、**各自mkcertのままで警告はクリックスルー**が素直。
開発用途ならsecure contextは成立するので動作確認自体はできる。

### 会場でうまくいかないとき

いちばん多い原因は **DNSリバインディング保護**。一部のルータ・リゾルバは
「公開DNSの応答にプライベートIPが入っていたら捨てる」ため、名前解決自体ができない。
会場のリゾルバは変えられないので、**その場では直せない**。

その場合は発表者画面のQRをLAN IPの候補に切り替え、参加者に証明書警告の
クリックスルーを案内する(issue #23 の方式C相当)。案内文は
`docs/demo-checklist.md` に用意してある。

**会場に事前に入れるなら、必ず会場Wi-Fiにつないだ端末で名前解決を試しておくこと。**
ここで引ければ、少なくともDNSリバインディング保護は踏んでいないと分かる。

ただし**名前が引けることと、参加できることは別**。ファイアウォールやAPアイソレーション
など、名前解決とは無関係に落ちる要因が残る。Honoを起動してから、参加者側の端末で
次を順に確認すること。

1. `https://<ドメイン>:8443/` が **証明書警告なし**で開く(HTTPS到達 + 証明書)
2. 参加して**ロスターに載る**(`/ws` のWebSocketが通っている)
3. 発表者画面のモデルのダウンロードが進む(`/models/*` が取得できている)

1つでも欠けたら「うまくいかないとき」を見る。
