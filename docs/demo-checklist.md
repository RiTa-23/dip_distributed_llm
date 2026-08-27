# デモ当日のチェックリスト

会場で上から順に叩く。**説明は書かない**(理由は `apps/server/README.md`「本番デモの証明書」)。

---

## 0. 前日までに終わらせておくこと

- [ ] `certs/prod/{cert,key}.pem` に Let's Encrypt の証明書がある
- [ ] Cloudflare にAレコードが1件ある(**DNS only / 灰色の雲**)
- [ ] `CF_API_TOKEN` / `CF_ZONE_ID` / `CF_RECORD_NAME` を手元に控えた
- [ ] `bun run setup` 相当が済んでいる(モデル・`web-dist` が配置済み)
- [ ] **rootCA未導入の端末**で警告ゼロを一度確認した

---

## 1. 会場Wi-Fiにつなぐ

- [ ] 発表者PCを会場Wi-Fiに接続
- [ ] 参加者用の端末(スマホ)も同じWi-Fiに接続

## 2. Aレコードを今のLAN IPに更新

```bash
cd apps/server
CF_API_TOKEN=... CF_ZONE_ID=... CF_RECORD_NAME=llm.example.com bun run dns
```

- [ ] `更新しました: ... → 10.x.x.x` が出た
- [ ] 検出されたIPが会場Wi-Fiのものと合っている(違えば `bun run dns 10.0.5.22` と直接指定)

## 3. 名前解決を確認 ← **ここが関門**

**参加者側の端末(スマホ)**のブラウザで開く:

```
https://llm.example.com:8443/
```

- [ ] つながった → **4へ**
- [ ] つながらない / 名前が引けない → **「うまくいかないとき」へ**

> まだHonoを起動していないので、この時点では接続エラーで構わない。
> 見たいのは「名前が引けるか」だけ。`ping llm.example.com` でも可。

## 4. Hono を起動

```bash
cd apps/server
TLS_CERT=./certs/prod/cert.pem \
TLS_KEY=./certs/prod/key.pem \
PUBLIC_ORIGIN=https://llm.example.com:8443 \
bun run dev
```

- [ ] `tls=true` で起動した
- [ ] `curl -s https://llm.example.com:8443/join-info` の先頭がドメインのURL

## 5. 参加者端末で最終確認

- [ ] `https://llm.example.com:8443/` が **証明書警告なし**で開く
- [ ] 参加できてロスターに載る
- [ ] 発表者画面のQRがドメインのURLになっている

---

## うまくいかないとき

### 名前が引けない(3で失敗)

会場のDNSがプライベートIPへの応答を捨てている(DNSリバインディング保護)。
**その場では直せない。** 方式Cに切り替える。

1. Honoを **mkcertの証明書**で起動し直す

   ```bash
   PUBLIC_ORIGIN= TLS_CERT= TLS_KEY= bun run dev
   ```

2. 発表者画面のQR下の候補から **LAN IPのURL** を選ぶ
3. 参加者に下の案内をする

**参加者への案内(そのまま読む):**

> 「接続がプライベートではありません」という警告が出ますが、**会場のLAN内だけで
> 完結している自前サーバー**なので問題ありません。
>
> - **iPhone / Safari** … 「詳細を表示」→「このWebサイトを閲覧」
> - **Android / Chrome** … 「詳細設定」→「(サイト名)にアクセスする(安全ではありません)」
> - **PC / Chrome・Edge** … 「詳細設定」→「(サイト名)にアクセスする」

### 警告は出ないが参加できない

- [ ] 発表者PCのファイアウォールが8443を塞いでいないか
- [ ] APアイソレーション(端末同士が通信できない設定)でないか
  → これだと WebRTC も張れないので、そもそもデモが成立しない

### 途中でLAN IPが変わった

DHCPのリース更新で変わることがある。`bun run dns` をもう一度叩けばよい。
既に参加している人は繋ぎ直しが要る。

---

## 撤収

- [ ] Aレコードを元に戻す(または削除する)
- [ ] 会場のLAN IPを指したまま放置しない
