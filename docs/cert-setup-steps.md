# Let's Encrypt 証明書の取得手順(#23)

飛び入り参加者に証明書警告を出さないための、証明書取得の**クリック単位の手順**。
事前に1回通しておけば、本番は `bun run dns` → `bun run dev` だけになる。

概要としくみは `apps/server/README.md`「本番デモの証明書」を参照。こちらは作業手順のみ。

---

## 前提

- Cloudflare で管理しているドメインがある
- Homebrew が入っている(`brew --version` で確認)
- 参加者がつなぐネットワークにインターネット接続がある(名前解決に使う)

## ⚠️ 触ってはいけないもの

- **APIトークンを誰にも共有しない**(AIアシスタントにも貼らない)
- **`certs/` 配下をコミットしない**(`.gitignore` 済みだが念のため)
- **Aレコードのプロキシを有効(オレンジの雲)にしない**

---

# 第1部: Cloudflare 側の準備(ブラウザ)

## 1-1. APIトークンを作る

1. https://dash.cloudflare.com/profile/api-tokens を開く
2. **Create Token** をクリック
3. 一番下の **Create Custom Token** の右にある **Get started** をクリック

**Token name**: `dip-llm-demo`(任意)

**Permissions** — **2行**追加する。

| 種別 | 対象 | 権限 |
|---|---|---|
| Zone | **DNS** | **Edit** |
| Zone | **Zone** | **Read** |

- `DNS:Edit` … 証明書取得時のTXT追加と、当日のAレコード更新に使う
- `Zone:Read` … acme.sh がゾーンを探すのに使う。**自動更新するなら必要**

**Zone Resources**: `Include` → `Specific zone` → **使うドメインを選ぶ**

4. **Continue to summary** → **Create Token**
5. **表示されたトークンをコピーする。この画面を離れると二度と見られない**

> 万一なくしたら、同じ画面で Roll(再発行)できる。

## 1-2. Zone ID を控える

1. Cloudflare のダッシュボードで**対象のドメインをクリック**
2. 概要ページの右カラム(または下部)の **API** セクションに **Zone ID**
3. コピーしておく(32桁の16進文字列)

## 1-3. Aレコードを1件だけ作る

1. そのドメインの **DNS → Records** → **Add record**

| 項目 | 値 |
|---|---|
| Type | **A** |
| Name | `llm`(→ `llm.あなたのドメイン`。好きな名前でよい) |
| IPv4 address | `192.0.2.1`(仮。あとで `bun run dns` が書き換える) |
| Proxy status | **DNS only(灰色の雲)** |
| TTL | **1 min** |

2. **Save**

**確認すること**

- [ ] 雲のアイコンが**灰色**(オレンジならクリックして切り替える)
- [ ] TTL が **1 min**(当日の書き換えを速く反映させるため)
- [ ] **同じ名前のAレコードが1件だけ**(複数あると `bun run dns` が止まる)

---

# 第2部: 証明書の取得(ターミナル)

## 2-1. acme.sh を入れる

```bash
brew install acme.sh
```

## 2-2. 環境変数を用意する

```bash
# 自分のドメインに置き換える
export DOMAIN="llm.あなたのドメイン"

# トークンは対話入力(コマンドラインに書くとシェル履歴に残る)
# read -p は bash 専用。zsh(macOSの既定)では `-p: no coprocess` になる
printf 'Cloudflare API Token: '; read -rs CF_Token; echo
export CF_Token

export CF_Zone_ID="控えたZone ID"
```

> `CF_Token` / `CF_Zone_ID` という名前は **acme.sh が読む決まった名前**。変えない。

## 2-3. 証明書を取得する

```bash
acme.sh --issue --dns dns_cf -d "$DOMAIN" --server letsencrypt
```

**`--server letsencrypt` を必ず付ける。** acme.sh 3.x の既定は ZeroSSL なので、
付け忘れると Let's Encrypt の証明書にならない。

- 初回はメールアドレスの登録を求められることがある
  → `acme.sh --register-account -m あなたのメール@example.com --server letsencrypt`
- DNSの反映待ちで**20秒ほど止まる**。正常

## 2-4. リポジトリに配置する

```bash
cd /Volumes/rita_mac_ssd/Develop/teamDev/dip_distributed_llm/apps/server
mkdir -p certs/prod

acme.sh --install-cert -d "$DOMAIN" \
  --fullchain-file "$(pwd)/certs/prod/cert.pem" \
  --key-file       "$(pwd)/certs/prod/key.pem"
```

> `--install-cert` は**更新時のコピー先も同時に登録する**。以降、自動更新されると
> このパスのファイルも自動で置き換わる。

## 2-5. 中身を確かめる

```bash
openssl x509 -in certs/prod/cert.pem -noout -issuer -subject -ext subjectAltName -enddate
```

**見るべき3点**

- [ ] `issuer=` に **`Let's Encrypt`**(`ZeroSSL` なら 2-3 をやり直し)
- [ ] `Subject Alternative Name:` が **`DNS:あなたのドメイン`**
- [ ] `notAfter=` が**デモ当日より後**(90日後になっているはず)

---

# 第3部: 自動更新の設定(任意)

Let's Encrypt の証明書は **90日で切れる**。

## デモが90日以内なら、この部は飛ばしてよい

必要なのは「更新できること」ではなく **当日に有効であること**だけ。取得直後の証明書は
90日有効なので、それまでにデモが終わるなら更新は一度も発生しない。

**飛ばすほうが安全な面もある。** 自動更新を入れると、デモ前日に cron が走って
`certs/prod/*.pem` が置き換わる一方、動いている Hono は古い証明書を握ったまま、
という事故が起きうる(`Bun.serve` は起動時にしか証明書を読まない)。
更新自体を発生させなければ、この落とし穴も無い。

**飛ばす場合にやること(これだけ)**

- [ ] 2-5 で出た `notAfter=` の日付をカレンダーに控える
- [ ] 当日、起動前にもう一度 `openssl x509 -in certs/prod/cert.pem -noout -enddate` で確認
- [ ] `crontab -l | grep acme` で**何も出ない**ことを確認(勝手な更新が走らない状態)

以降は、デモ後も使い続ける場合の手順。

## 3-1. cron が入っているか確認する

```bash
crontab -l | grep acme
```

**何も出なければ**、登録する。

```bash
acme.sh --install-cronjob
```

> Homebrew 版が cron を自動で入れるかは未確認。上の確認をしてから判断すること。

## 3-2. 更新を空実行して確かめる

実際に更新されるのは期限の30日前からなので、強制的に試す。

```bash
acme.sh --renew -d "$DOMAIN" --server letsencrypt --force
```

成功したら `certs/prod/cert.pem` の日付が新しくなっているはず。

```bash
openssl x509 -in certs/prod/cert.pem -noout -enddate
```

> `--force` は Let's Encrypt の**発行レート制限**(同一ドメイン週5回)を消費する。
> 確認は1回で済ませる。

## 3-3. ⚠️ 更新後は Hono の再起動が要る

**`Bun.serve` は起動時に証明書を読む。** ファイルが更新されても、動いているプロセスは
古い証明書を持ったまま。

デモ直前に自動更新が走った場合は、**Hono を起動し直す**こと。

- [ ] 当日、起動前に `openssl x509 ... -noout -enddate` で期限を確認する

---

# 第4部: 動作確認(本番前に1回通す)

## 4-1. ⚠️ ブランチに注意

**`certs/prod/` を読むコードは PR #92 のブランチにしかない。**
develop のままだと mkcert が使われる。

```bash
cd /Volumes/rita_mac_ssd/Develop/teamDev/dip_distributed_llm
git checkout 23/rita/production_https
```

(PR #92 がマージ済みなら develop のままでよい)

## 4-2. Aレコードを、いまつながっているLAN IPに向ける

> **Aレコードは「そのとき自分がつながっているネットワーク」に毎回合わせるもの。**
> `bun run dns` は実行した時点のLAN IPを自動検出して書き込むので、ネットワークを
> 移ったら**そのつど叩き直す**。
>
> 叩き忘れると、Aレコードは前のネットワークのIPを指したままになる。参加者から見ると
> **証明書は正しいのに繋がらない**状態で、警告も出ないぶん切り分けにくい。
>
> 証明書のほうはドメインに対して出ているので、IPが変わっても取り直しは要らない。

```bash
cd apps/server

export CF_API_TOKEN="$CF_Token"     # スクリプトが読む名前は CF_API_TOKEN
export CF_ZONE_ID="$CF_Zone_ID"
export CF_RECORD_NAME="$DOMAIN"

bun run dns
```

`更新しました: llm.xxx 192.0.2.1 → 192.168.x.x (DNS only)` が出れば成功。

## 4-3. 起動する

```bash
bun run dev
```

**起動ログがこうなっていれば成功。**

```
証明書: ./certs/prod/cert.pem — 本番デモ用 certs/prod(公開CA。飛び入り参加者に警告が出ない)
参加URL: https://llm.あなたのドメイン:8443 を既定にします
```

`certs`(mkcert)と出たら、`certs/prod/` に置けていないかブランチが違う。

## 4-4. ここが本番(#23 の完了条件)

**rootCA を入れていない端末**で開く。同じLAN内のスマホが手軽。

```
https://llm.あなたのドメイン:8443/
```

- [ ] **証明書警告が出ない** ← これが #23 の本題
- [ ] 「参加する」で参加でき、発表者画面のロスターに載る(`/ws` が通っている)
- [ ] 発表者画面のモデルのダウンロードが進む(`/models/*` が取れている)

---

# 当日の手順(ここだけ見ればよい)

```bash
cd apps/server

printf 'CF_API_TOKEN: '; read -rs CF_API_TOKEN; echo
export CF_API_TOKEN
export CF_ZONE_ID=...
export CF_RECORD_NAME=llm.あなたのドメイン

bun run dns          # いまつながっているLAN IPへ書き換え
bun run dev          # 起動(環境変数は要らない)
```

詳細は `docs/demo-checklist.md`。

---

# 困ったとき

| 症状 | 原因 |
|---|---|
| `issuer=` が ZeroSSL | `--server letsencrypt` の付け忘れ |
| `Zone not found` | `Zone:Read` 権限が無い、または `CF_Zone_ID` が違う |
| `Authentication failed` | トークンが違う。`CF_Token` と `CF_API_TOKEN` の取り違えにも注意 |
| 起動ログが `certs`(mkcert) | `certs/prod/` に無い、またはブランチが develop |
| `Aレコードが N 件あります` | 同名のAレコードが複数。1件だけ残す |
| 参加者端末で名前が引けない | **DNSリバインディング保護**。`docs/demo-checklist.md`「うまくいかないとき」へ |

## 環境変数の名前が2系統ある点に注意

| 使う人 | 名前 |
|---|---|
| acme.sh | `CF_Token` / `CF_Zone_ID` |
| `bun run dns` | `CF_API_TOKEN` / `CF_ZONE_ID` / `CF_RECORD_NAME` |

値は同じでよいが、**名前が違う**。片方だけ設定して「動かない」となりやすい。
