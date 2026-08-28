# coturn(会場LAN内TURN)セットアップ手順

複数PCで `generation_aborted reason=connection_failed` が続く場合の対処。実測で `pc.connectionState === "failed"` が約15秒で立っており、**端末間のdirect経路が成立していない**ことが確認できている。

外部のSTUN/TURNサービスは使わない(AGENTS.md 前提6)。立てるのは**会場LAN内のホスト**で、これは前提6に反しない。

---

## 一度セットアップしたあと、IPが変わったら

**`bun run venue` 一発で済む。** 以下の初期セットアップを読む必要はない。

```bash
bun run --cwd apps/server venue             # IPは自動検出
bun run --cwd apps/server venue 10.0.5.22   # 明示指定(仮想NICが複数あるとき)
```

これが next の4つをまとめて面倒を見る。IPが変わると全部ズレるが、**手作業で回すと必ずどれか忘れる**。

1. Cloudflare Aレコード(`CF_*` 未設定ならスキップ)
2. `turnserver.conf` の `listening-ip` / `relay-ip`
3. `apps/web/.env.local` の `VITE_TURN_URLS`(**credentialは保持**)
4. **Webのビルド** — `VITE_*` はビルド時に焼き込まれるので必須

さらに coturn を再起動し、**新IPで待受できたか**と**配信物に新IPが焼き込まれたか**まで確認してから完了と言う。ここまでやるので「設定したのに効かない」が起きない。

Cloudflareのトークンを持たないメンバーのPCでも通る(その手順だけ飛ばす)。

---

## 前提: コードは書かなくてよい

クライアント側は実装済みでdevelopにマージ済み。

| 要素 | 状態 |
|---|---|
| `apps/web/src/webrtc/iceConfig.ts` | ✅ 済(`c3c0c34`) |
| 失敗時の文言・経路診断のrelay対応 | ✅ 済(`8e77ef2`) |
| 設定の受け口 `VITE_TURN_*` | ✅ 済 |
| **`apps/web/.env.local`** | ❌ 未作成 |
| **coturn 本体** | ❌ 未インストール |

**足りないのはこの2つだけ。**

---

## ⚠️ 先に読むべき2つの落とし穴

### 1. `VITE_*` はビルド時に焼き込まれる

`config.ts` は `import.meta.env.VITE_TURN_URLS` を読む。**`.env.local` を置いただけでは効かない。**

必ず後述の手順で `bun run --cwd apps/server web:copy` を実行し、ブラウザをハードリロードすること。

### 2. 3つとも設定しないと起動時に落ちる

`VITE_TURN_URLS` / `VITE_TURN_USERNAME` / `VITE_TURN_CREDENTIAL` は3点セット。一部だけだと設定エラーで落ちる(「入れたつもりで効いていない」まま検証しないための意図的な設計)。

---

## 手順

以降、TURNは **Honoを動かしているPC(= rita のMac)** に同居させる。参加者から到達できることが `/ws` で既に実証されているホストなので、ここが最も確実。

### Step 1 — インストール

```bash
brew install coturn
```

### Step 2 — LAN IP を確認する

```bash
ipconfig getifaddr en0
```

現在は **`192.168.1.43`**。以降この値を `<LAN_IP>` と書く。

> **⚠️ ネットワークが変わるとこの値も変わる。** 会場では別の値(以前の実測では `172.16.8.27`)になる。IPが変わったら Step 3 の設定と Step 6 の `.env.local` を**両方**直して**ビルドし直す**こと。

### Step 3 — 設定ファイルを書く

`/opt/homebrew/etc/turnserver.conf` を作る(Apple Silicon の場合。Intel Macは `/usr/local/etc/`)。

```conf
# 会場LAN内TURN。外向けには一切公開しない。
listening-port=3478
listening-ip=<LAN_IP>
relay-ip=<LAN_IP>

# 長期credential方式(WebRTCのTURNはこれ)
lt-cred-mech
realm=dip.local
user=dip:<パスワード>

# LAN内なのでTLSは張らない。証明書運用を増やさない
no-tls
no-dtls

# 中継に使うポート範囲。狭めておくとファイアウォール許可が楽
min-port=49160
max-port=49200

# WebRTC互換に必要
fingerprint

# ログ(切り分け用。うるさければ後で消す)
verbose
log-file=stdout
```

`<パスワード>` は適当な文字列でよい(会場LAN内・数時間の用途)。**このファイルはリポジトリに入れない。**

### Step 4 — macOSのファイアウォールを通す

システム設定 → ネットワーク → ファイアウォール が**オン**の場合、`turnserver` の着信接続を許可する。オフなら何もしなくてよい。

```bash
# 状態確認
/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
```

### Step 5 — 起動する

```bash
turnserver -c /opt/homebrew/etc/turnserver.conf
```

**フォアグラウンドで起動して、ログを見える状態にしておく。** `brew services` で常駐させない(デモ後に止め忘れる)。

起動できたか確認:

```bash
lsof -nP -iUDP:3478
lsof -nP -iTCP:3478 -sTCP:LISTEN
```

### Step 6 — クライアント設定を書く

```bash
cp apps/web/.env.example apps/web/.env.local
```

`apps/web/.env.local` を編集する。

```dotenv
VITE_TURN_URLS=turn:<LAN_IP>:3478?transport=udp,turn:<LAN_IP>:3478?transport=tcp
VITE_TURN_USERNAME=dip
VITE_TURN_CREDENTIAL=<Step 3 で決めたパスワード>
VITE_FORCE_RELAY=0
```

`.env.local` は `.gitignore` 済み(`apps/web/.gitignore:28`)なので、パスワードを書いてもコミットされない。

> **`transport=tcp` を必ず残すこと。** 参加者から Hono(TCP 8443)へ到達できているのは実証済みなので、**TCPのTURNが最も確実に通る**。UDPが遮断されているLANでもTCPなら中継できる。

### Step 7 — ビルドし直す(必須)

```bash
bun run --cwd apps/server web:copy
```

反映されたか確認:

```bash
grep -o 'turn:[^"]*' apps/server/public/web-dist/assets/*.js | head -2
```

TURNのURLが出てくれば焼き込み成功。**出てこなければ効いていない。**

### Step 8 — Honoを再起動し、ハードリロード

```bash
bun run --cwd apps/server dev
```

ブラウザは Cmd+Shift+R。

---

## 検証

### まず relay 経路だけを試す

`.env.local` を一時的に `VITE_FORCE_RELAY=1` にして Step 7・8 をやり直す。`iceTransportPolicy: "relay"` に固定され、**中継経路だけ**が試される。

これで繋がれば **coturnは正しく動いている**。繋がらなければcoturn側の問題(設定・ファイアウォール・IP)なので、directの話に戻る前にここを直す。

確認できたら **必ず `VITE_FORCE_RELAY=0` に戻してビルドし直す**。本番でrelay固定にすると、directで足りる端末まで中継を通ることになり、rita のMacに全トラフィックが集中する。

### 経路を確認する

requester のブラウザコンソール:

```
[webrtc] local candidate peer=... type=relay ...    ← relay候補が出ていればTURNに到達できている
[webrtc] iceConnectionState peer=... → connected
```

`attachIceDiagnostics`(`session.ts:72`)が接続成立時に経路を報告する。`relay` が含まれていればTURN経由。

TURNへ到達できない場合はこう出る:

```
[webrtc] ICE server error { url: "turn:...", errorCode: ..., errorText: ... }
```

### サーバログ

```bash
grep -nE "generation_aborted|generation_start" /tmp/hono-*.log
```

`generation_start` まで進み、`connection_failed` が出なくなれば解決。

---

## デモ当日の注意

1. **会場に着いたら `bun run --cwd apps/server venue` を叩く。** LAN IPが変わっているので、これでAレコード・TURN設定・ビルドが揃う
2. **coturnが動いていなければ最初だけ手動で起動する。** 一度動いていれば `venue` が再起動まで面倒を見る
   ```bash
   nohup turnserver -c /opt/homebrew/etc/turnserver.conf > /tmp/coturn.log 2>&1 &
   ```
3. **`VITE_FORCE_RELAY=0` を確認する。** 1のままだと全員分の中継が発表者PCを通り、帯域が詰まる
4. TURNはあくまで**フォールバック**。directで繋がる端末はdirectのまま(`iceTransportPolicy: "all"`)
5. **同じ会場でも再接続でIPが変わる。** 繋ぎ直したら `venue` をもう一度叩く

---

## 切り分けに使えるログ

原因を追うときはこの3種類を見る。いずれも常時出る(調査用の一時変更ではない)。

| 出どころ | 何が分かるか |
|---|---|
| `[webrtc] local candidate ... type=` | **`relay` が出ればTURNに到達できている。** `host` しか出なければTURNへ届いていない |
| `[webrtc] remote candidate ...` | 相手の候補が届いているか。**1件も出なければシグナリングの問題** |
| `[webrtc] iceConnectionState ... → failed` | ICE自身の判定。`CONNECT_STALL_MS`(10秒)はICEが諦めるより先に切るので、**サーバのログだけでは「時間切れ」としか分からない** |
| `no_pong` / `ws_close`(サーバ) | 切断が応答途絶によるものか、タブを閉じた等かの区別 |

### 計測で分かっていること

`CONNECT_STALL_MS` を一時的に40秒へ延ばして測ったところ、**ICEは約15秒で `failed` に達した**(10秒では打ち切られて見えなかった)。つまり「遅い」のではなく「経路が無い」。

**この10秒という値は、ICE自身の判定より先に切ってしまう。** 失敗時に画面へ出る文言が具体性を失うため、必要なら見直す余地がある(現状は #78 で決めた10秒のまま)。

---

## TURNで直らない場合

以下はTURNでは解決しないので、別途切り分ける。

- **`remote candidate` が1件も出ない** → シグナリング(`/ws` 経由のICE中継)の問題
- **`clientId` が繰り返し `ws_close` する** → その端末のWebSocketが不安定。実測で `93a6d77a-...` と `c5b94109-...` が該当。ICEが直っても残る
