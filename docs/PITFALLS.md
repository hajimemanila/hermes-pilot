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

## P7. テーマ（Dark / Light）× Vibe の色漏れ（黒枠・黒ドット・読めない文字）

**症状**: Light にするとナビの点・バッジに**黒いリング**が付く／「実行中」ピルのドットが
**どちらの Vibe でも黒い**／設定タブの PWA 診断の ✓✗ が白カードの上で読めない。

**原因**: コンポーネント側の**直書き**。面の色はテーマで変わるのに、個別セレクタに Dark の値を
焼き込んでいた（実測 2026-11-19）:

| 箇所 | 直書き | 正しい持ち方 |
| --- | --- | --- |
| `.nav-badge` / `.nav-dot` / `.drawer-btn-badge` | `box-shadow: 0 0 0 2px rgba(6,22,26,.96)` | `var(--badge-ring)`（Dark 暗色 / Light 白） |
| `.t-dot.live`（実行中ピルの点） | `background: var(--on-warn)`（#1d1300 = 黒） | `var(--accent)`（文字用トークンを図形に流用しない） |
| `.row-badge` / `.drawer-btn-badge` の文字 | `color: #06201a` / `#04202a` | `var(--on-good)` / `var(--on-accent)` |
| `.ak-thumb-btn::after`（拡大ラベル） | `background: rgba(6,22,26,.78)` | `var(--glass-strong)`（Light で暗い面＋暗い文字になる） |
| `.receipt-preview` | `background: #06181f` | `var(--code-bg)` |
| `SettingsPane` の診断 ✓✗ | inline `#4ade80` / `#f87171` / `#fca5a5` | `var(--good)` / `var(--bad)` / `var(--danger-fg)` |

Dopamine 側も `--vibe-badge-ring` に同じ値を二重定義していたので、
`--vibe-badge-ring: var(--badge-ring)` の別名だけにした（重複を残さない）。

**検出**: `apps/web/test/themeTokens.test.js`
- `--badge-ring` が両テーマに定義されている
- 点・バッジ類が `var(--badge-ring)` を使い、暗色を直書きしていない
- `.t-dot.live` が `var(--accent)`（`--on-warn` を図形に使わない）
- 宣言に `rgba(6, 22, 26` / `#06201a` / `#04202a` / `#06181f` の直書きが残っていない
- `.jsx` の `style={{ … }}` に色（`#hex` / `rgba()`）を書かない

実画面は Chrome で `html[data-theme]` と `html[data-vibe]` を切り替え、点・バッジの computed
`boxShadow` に暗色が混ざっていないかを 4 通り（Dark/Light × dopamine/serotonin）で機械走査する。

**対策の原則**: 面・文字・縁取りは必ずテーマトークン（`--badge-ring` / `--on-good` / `--on-accent` /
`--glass-strong` / `--code-bg`）。**新しい小さい部品を足すとき、色を書くのは `:root` と
`html[data-theme='light']` の 2 箇所だけ**にする。Vibe は既存トークンの別名を置くに留める。

**測定の罠**: `transition` 中の computed は**中間色**を返す（`#5eead4`→`#0f766e` の途中を
Light の漏れと誤判定した）。機械走査の前に `*{transition:none!important}` を挿す。

---

## P8. コヒーレンス診断の「出ない・消えない・戻らない」

**症状**（いずれも Tasks タブ / Launchpad / `verify` の見え方の話で、アプリは壊れていない）:

- 完走したのに **提案バナーが出ない**（または毎回出て鬱陶しい）
- ✕ で閉じたのに翌セッションでまた出る／逆に、直したのに閉じたまま二度と出ない
- アーカイブした SPEC が Launchpad から**消えたまま戻せない**
- 何も変えていないのに `verify` が `file-bloat` / ラチェットで落ちる

**原因と対策**（`apps/web/src/lib/tasksView.js` とブリッジ側の判定に集約）:

| 症状 | 原因 | 対策 / 見方 |
| --- | --- | --- |
| バナーが出ない | 閾値未満（`hardFailCount > 0 ｜ hotspotCount >= 1 ｜ softSignalCount >= 3` の全部が偽） | 出ないのが正しい。件数は `RefactorSheet` のライブ診断帯で確認する |
| バナーが出ない（旧ブリッジ） | `GET /api/coherence/report` が 404 | Tasks タブは直近 24 時間の完走レポートの `coherence_alert` に自動で切り替わる。両方無ければ**何も出さない**（飾りにしない） |
| 閉じても出続ける／出なくなる | 閉じた記録は `HM_STORAGE.COHERENCE_DISMISSED`（`hm.coherenceDismissed`）に **署名**（ハード失敗・ソフト兆候・ホットスポット件数＋推奨スイープ）付きで保存される | **件数か推奨スイープが変わると別アラートとして出し直す**のが仕様。完全に消したいときは DevTools で `localStorage.removeItem('hm.coherenceDismissed')` |
| アーカイブ SPEC が見えない | Launchpad の既定はアクティブのみ（`specs` が既定でアクティブ） | SPEC ピッカーの **`Show archived (N)`** を ON にする。サーバが `archivedSpecs` を返さない旧ブリッジでも `archived` フラグで振り分ける |
| `verify` が肥大で落ちる | 基準ファイル（`scripts/coherence-baseline.json` など `baselineFile`）を超えた | 行を減らすのが先。**縮小時だけ** チェッカーの `--update-baseline` で基準を切り下げる（増やす更新はしない） |
| 診断が固まる | Layer 2 の `checker` は 10 秒タイムアウト | タイムアウト・JSON 不正は `softSignals` に落ちて本体は止まらない。チェッカー単体を `--json` で直接叩いて切り分ける |

**原則**: 診断は**読み取り専用**（D55）。バナーやレポートから勝手にカンバンへ起票しない。
起票は人が 1 タップしたときだけ（`RefactorSheet` の 2 択起動）。

---

## P9. 正本を直したのに、呼び出し側が同じ判断を続けている

**症状**: 正本（接続状態・定期同期・イベント payload・タスク遷移）を直したのに、しばらくすると
別の場所で同じ判断が復活して静かにずれる。ビルドもテストも緑のままなので、症状が出るまで気づかない。

**原因**: 「動いてはいるが、同じ事実を 2 か所以上が別々に決めている」箇所は、片方を直しても
もう片方が**そのまま残る**。実測では接続状態が 4 系統、定期同期が 7 本の独立タイマー、
blocked からの遷移判断が 5 か所に散っていた。正本を作っても、呼び出し側の実装を消さなければ戻る。

**検出**: `npm run check:coherence` の 3 ルール。

- `sync-owner` — `apps/web/src/App.jsx` の `setInterval(`
- `transport-owner` — `apps/web/src/lib/transport.js` 以外の `offlineSince` と `1000 * 2 **`
- `transition-owner` — `review.js` / `review/media.js` の `runKanban(['unblock'`・`runKanban(['complete'`

`checkerPending` に入っている間はソフト信号（`fatal`）で、`--strict` で回すと落ちる。

**対策**: 直すときは**呼び出し側の実装を消して正本を呼ぶ**（別名で包む・再エクスポートは可）。
新機能は正本の表に 1 行足すだけで済ませ、`setInterval`・独自バックオフ・独自の `unblock` 分岐を増やさない。
正本の場所は [OPERATIONS.md の「整合性の正本」](./OPERATIONS.md#整合性の正本このリポジトリの-4-つ)。

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
