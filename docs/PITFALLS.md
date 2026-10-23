# Pitfalls（実際に踏んだ地雷と、その再発防止）

このリポジトリで実際に起きた不具合を、**症状 → 原因 → どう検出するか → 対策**の形で残す。
新しい機能を足すときは、ここに書いてある検査（`npm run check:pwa`）を通してから出す。

---

## P1. PWA のアイコンに白枠が付く（Android / HyperOS）

**症状**: ホーム画面のアイコンが「白いカードに載った小さなアイコン」になる。DSH や
Hermes ダッシュボードでは起きないのに、このアプリだけ白枠が付く。アンインストール→
再インストールしても、サイトデータを消しても直らない。

**原因**: ホーム画面のアイコンの実体が **favicon（`/icon.svg`）** で、その SVG が
`<rect x="24" y="24" width="464" height="464">` のように**内側に図形を描いていた**こと。
周囲 24px が透明なので、ランチャーが白いカードを透かして描き、白枠になる。
DSH の SVG は `<rect width="512" height="512">` の全面ベタなので枠が出ない。

**検出**: `npm run check:pwa` の
- `icon /icon-v5.svg が全面ベタ`（`analyze_svg`）
- `icon *.png の外周が不透明`（`analyze_icon`）

**対策**:
- アイコンは**外周 1px まで不透明の全面ベタ**。透明マージン／内側角丸四角は禁止
- manifest の `any` も透明にしない
- favicon を差し替えるときは **URL を変える**（`/icon.svg` → `/icon-v5.svg`）。
  Chrome の favicon キャッシュは**サイトデータ削除では消えない**（グローバル DB）

---

## P2. 「マスカブルなのに白枠」に見える（`any maskable` 併記・グラデーション）

**症状**: `purpose` を指定しているのに非アダプティブ扱いされる／境目が線に見える。

**原因**:
- `"purpose": "any maskable"` の併記は非推奨（同じビットマップが両用途に使われる）
- 背景がグラデーション＋グローだと、前景/背景レイヤーに分けて合成されたとき**矩形の境目**が出る

**検出**: `check-pwa` の `maskable あり`（単独トークンで判定）と `背景が単色`、`安全域`（図柄半径 ≤0.40）

**対策**: `purpose` は **`"maskable"` 単独**。背景は `background_color` / `theme_color` と**同値の単色ベタ**。

---

## P3. `This site cannot be installed` でインストールできない

**症状**: Chrome のメニューでインストールを選ぶと失敗する。ページ側は何も悪くない。

**原因**: **Google Play Services 側の WebAPK インストール基盤の不整合**。
`chrome://webapks` の `Last Update Completion Time` が **1970-01-01** なら、
WebAPK の生成/更新が一度も成功していない。端末内に残った WebAPK レコードと
パッケージが食い違うと、再インストールも失敗し続ける。

**見分け方**（この順で確認する）:
1. 設定タブの **PWA 診断**を実機で実行（manifest / icons / SW / id / scope を ✓✗ で出す）
2. 全項目 ✓ なのに `beforeinstallprompt` が発火しない → ページ側ではなく基盤側
3. `chrome://webapks` で `Last Update Completion Time` を確認
4. **端末を再起動** → 再インストール（実例ではこれで解決）

**対策（実務）**:
- ページ側の要件を `npm run check:pwa:live` で先に潰す
- それでも駄目なら端末再起動 → 再インストール。Android 設定 → アプリ に残存パッケージが無いか確認
- 時間がないときは **「ホーム画面に追加」（ショートカット）** で回避できる。
  ショートカットのアイコンは favicon なので、全面ベタにしておけば白枠は出ない（P1 と同じ対策が効く）

---

## P4. manifest を変えたのにアイコンが古いまま

**症状**: デプロイしたのに端末は古いアイコンを表示し続ける。

**原因**:
- manifest を `immutable` で返していた（Chrome が古い manifest を掴み続ける）
- Service Worker が `/manifest.webmanifest` を SHELL キャッシュしていた
- アイコンのファイル名が同じ（端末側のキャッシュを更新できない）
- インストール済み WebAPK は `id` ではなく **scope** で一意。`id` を変えても別アプリにならず、
  既存 WebAPK と衝突して**インストール不能になるだけ**

**検出**: `check-pwa` の `manifest の cache-control`（immutable でないこと）／アセットログ
`~/.hermes/mobile-pwa/asset-access.log`（端末が実際に何を取りに来たか）

**対策**:
- manifest は `no-cache`、SW の SHELL に**入れない**
- アイコンはファイル名にバージョンを入れる（`-v5`）＋ SW の `CACHE` を上げる
- **`id` は変えない**（scope と揃えたまま）

---

## P5. アイコン取得ログで「削除済みファイル」を要求される

**症状**: 端末が `/icon-192.png` など**もう存在しないファイル**を取りに来て 404。

**原因**: Chrome が古い manifest（古いアイコン URL）を保持している。SW キャッシュか
HTTP キャッシュが残っている。

**対策**: manifest の `no-cache` 化、SW SHELL からの除去、`/favicon.ico` の用意、
キャッシュ削除 → タブを閉じる → 開き直し。それでも残れば端末再起動（P3 と同じ）。

---

## P6. Service Worker のルート分解で 404

**症状**: `/api/snippets/term` が 404。登録したのに届かない。

**原因**: ルータが `/api/<a>/<b>` に分解しており、`a === 'snippets/term'` は決して一致しない。

**対策**: `a === 'snippets' && b === 'term'` の形で判定する。新しいルートを足したら
`curl` で 200 を確認する（テストだけで済ませない）。

---

## 再発防止の運用

```bash
npm run check:pwa           # ローカルの public/ を検査（0.1秒・ネットワーク不要）
npm run check:pwa:live      # 公開URLを未認証で取得して検査（デプロイ後）
npm run check:pwa:selftest  # チェッカー自体が過去の不具合を検出できるか
npm run verify              # test + check:pwa + build（デプロイ前の必須コマンド）
```

`check-pwa` は次を見る。**✗ が1つでもあればデプロイしない**。

- manifest: name / short_name / start_url ⊂ scope / id 同一オリジン / display /
  prefer_related_applications / cache-control が immutable でない
- icons: 実ピクセルと宣言サイズの一致、any 192・any 512・maskable の存在、
  **外周 1px に透明画素が無い**、**背景が単色**、**図柄が中心半径 0.40 以内**、
  **SVG が全面ベタ**
- シェルが**未認証で 200**（manifest / 各アイコン / sw.js / index）
- Service Worker に fetch ハンドラがある
