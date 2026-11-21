# SPEC: 多言語の穴とレスポンシブの甘い部分（i18n-resp）

- **Status**: archived
- **アーカイブ日**: 2026-11-21（COH-4・全バッチ完了済み。以後は参照用に保持し、新規起票の対象外）

対象: `~/Projects/hermes-mobile-pwa`（PWA `apps/web` ＋ ブリッジ `apps/bridge`）
決定: 赤ペンシート `spec-i18n-resp-01` round 1（回答は `plugin-data/hermes-pilot/review/sheets/spec-i18n-resp-01-1.answer.json`）
起票先: board `hermes-pilot`（実体はこのリポジトリ）

---

## 0. 決定（人が選んだもの・変更不可）

- **Q1 = B**: PWA の画面・PWA メタ＋**ブリッジが返す短いメッセージのコード化**まで。長文生成物（パイプライン報告・シート HTML・CLI 出力）は対象外（それは C の領域）。
- **Q2 = A**: **680px 以上で「狭い 2 ペイン」**（左 280–300px）。820px 以上は現行の 380/360 を維持。
- **Q3 = A**: **横向きを許可**し、ノッチ／短い高さに対応（manifest `orientation: any`、safe-area 左右、低い高さの詰め）。
- **Q4 = A**: **実測監査（ヘッドレス Chrome を CDP で駆動・依存追加なし）＋静的な言語漏れテスト**。

---

## 1. 実測（2026-11-15 再測定・方法つき）

### 1.1 多言語

- 画面辞書 `apps/web/src/i18n/ja.json` / `en.json`: **829 キーで完全一致（差分 0）・空値 0**。`err.*` は両言語 13 キー。→ **画面の辞書は穴ゼロ**（当初の報告どおり）。
- ブリッジ `apps/bridge/src/*.js` の**日本語文字列リテラルは 259**（コメント除去後の引用符内のみを数える／`review.js` 59, `specs.js` 35, `term-snippets.js` 32, `snippets.js` 30, `pipeline-watcher.js` 16, `inbox.js` 15, `repos.js` 14, `server.js` 14 …）。
  - うち **`message:` / `error:` の値に入るもの 61**（review.js 40 / repos.js 13 / specs.js 6 / capture.js 1 / chat-profile.js 1）＝ **PWA の画面にそのまま出る日本語**。
  - `throw Object.assign(new Error('日本語'), {statusCode})` が **27**（inbox.js 12 / ops.js 5 / specs.js 3 / kanban.js 3 / capture.js 3 / server.js 1）。これも `sendFailure` 経由で `detail` として画面に届く。
- API エラー基盤は**すでにある**: `api-errors.js`（`ERROR_MESSAGES` 12 コード＋`errorBody()`）、`server.js:270/285`（`sendError`/`sendFailure`）、`web/src/api.js:22`（`localizedMessage`）。`errorBody()` の呼び出しは 3 箇所だけ。
- **欠陥（今回の本丸）**: `apps/web/src/api.js:66-73` は `code` を受け取っても辞書を引かず、`data.error`（＝ブリッジの**英語既定文**）をそのまま出す。`localizedMessage()` を呼ぶのは `OFFLINE` の 1 分岐だけ。→ **JA 表示でも API エラーは英語**、コード化されていない 61＋27 箇所は**EN 表示でも日本語**。

### 1.2 レスポンシブ

- 横溢れは実際に 0（既存の実測マトリクス 60 通り）。壊れているのは**境界の外側**と**境界の二重管理**。
- レイアウト境界は **820px の 1 本**だけ: `styles.css:3277`、`styles.css:4044`（`receipt-kpis`）。JS 側 `lib/useSplitLayout.js:12` の `SPLIT_QUERY = '(min-width: 820px)'` が同じ値を**手で複製**している（`styles.css:3267` のコメントも「必ず一致させる」と自認）。同ファイル `:14` の `SPLIT_MASTER_WIDTH` は**未使用の死んだ定数**。
- 左ペイン幅は CSS 変数で `review 380 / tasks 360`（`styles.css:3270,3275`）。
- safe-area は `--safe-t` / `--safe-b` の 2 つだけ（`styles.css:60-61`）。**左右（`--safe-l/--safe-r`）が無い**ため、`viewport-fit=cover`（`apps/web/index.html:5`）＋横向きでノッチに食われる。
- `manifest.webmanifest` が `"orientation": "portrait"` → **インストール版は横向き不可**。
- `styles.css` は 4243 行・`font-size` の px 直書き **211**・`clamp`/`rem` の font-size **0** → 中間幅でのスケールは無く、2 ペインの狭い左で文字が詰まる。
- 44px 以上のタップ領域を明示している規則は 3 箇所のみ（`styles.css:2782, 2877, 4174`）。
- Chrome はこのホストに在る（`/Applications/Google Chrome.app`）。Node は 22 系（`engines: >=22.19.0`）＝ `WebSocket` がグローバルにあるので CDP に依存追加は不要。

---

## 2. 設計

### B1 — i18n の土台（コード表と失敗ヘルパ）

- `api-errors.js` に**コード体系**を足す。命名は `<DOMAIN>_<REASON>`（`REPO_NOT_GIT` / `TASK_STATE_LOCKED` / `SHEET_MISSING` / `IMAGE_TOO_LARGE` / `BOARD_NAME_INVALID` …）。既存 12 コードはそのまま温存。
- `fail(code, params)` を追加（`{ ok: false, code, params }` を返すだけ。`throw` しない＝呼び出し側の戻り値規約に合わせる）。`throw` したい場所（inbox.js/ops.js）用に `ApiError extends Error { code, params, statusCode }` を同ファイルに置き、`server.js` の `sendFailure` が `err.code` を読むように 1 行だけ広げる。
- `ERROR_MESSAGES` の英語既定文は**必ず 1 コード 1 文**で持ち、辞書に無いコードでも読める状態を維持（現行方針）。
- 受け入れ: `web/test/apiErrors.test.js` — 全コードに英語既定があり、`fail()` の戻り形が §6.3 と一致。

### B2 — 呼び出しの置換＋辞書

- **フロント**: `api.js` のエラー生成を `localizedMessage(code, data.error || data.detail || 'HTTP ' + status)` に変更。`params` を `t()` に渡す（`err.NOT_WAITING` の `{status}` を実際に埋める）。
- **ブリッジ**: 61 箇所の `message:`/`error:` と 27 箇所の `new Error('日本語')` を上記コードへ置換（`review.js` 40 / `repos.js` 13 / `inbox.js` 12 / `specs.js` 6 / `ops.js` 5 / `kanban.js` 3 / `capture.js` 3 / `chat-profile.js` 1 / `server.js` 1）。**対象外**: `runKanban()` に渡す `--reason` / `--summary`（カンバンに残る運用文＝人と worker が読む）、`term-snippets.js` / `snippets.js` の同梱データ、シート HTML の生成文（Q1=C）。
- `ja.json` / `en.json` に `err.<CODE>` を**コードと 1:1** で追加（両言語同数）。
- 受け入れ: `web/test/i18nErrorCoverage.test.js` — `ERROR_MESSAGES` のキー集合 ⊆ `err.*` のキー集合（両言語）、`params` の `{name}` が両言語で一致。

### B3 — 境界の一本化＋680px 狭い 2 ペイン

- 新規 `apps/web/src/lib/layout.js` に数値を集約:
  `SPLIT_MIN = 680` / `SPLIT_WIDE_MIN = 820` / `MASTER_W = { narrow: 280, wide: { review: 380, tasks: 360 } }`、`query(min) => '(min-width: ' + min + 'px)'`。
- `useSplitLayout.js` は `layout.js` から読む（`SPLIT_QUERY` は再エクスポートで互換維持、`SPLIT_MASTER_WIDTH` は削除）。戻り値を `{ split, wide }` に広げる（`split` = 680 以上、`wide` = 820 以上）。
- `styles.css`: 680–819 のブロックを 3277 の直前に足す（`--split-master-w: 280px` ＋ 一覧の 2 行折り返し・詳細の padding 圧縮）。820 以上のブロックは現行のまま。
- 受け入れ: `web/test/layoutBreakpoints.test.js` — `styles.css` に現れる `min-width` の集合が `layout.js` の定数集合と一致（**3 つ目の境界を作らせない**）。実測は B5 の監査で 744/768 が 2 ペインになること。

### B4 — 横向き・safe-area・短い高さ

- `manifest.webmanifest`: `orientation: "portrait"` → `"any"`。
- `styles.css`: `--safe-l` / `--safe-r` を追加し、`.app`（`styles.css:140-147`）と 2 ペインの `.split-master` / `.split-detail`、ボトムナビに左右の safe-area を反映。
- `@media (max-height: 430px)` ブロックを追加: `--nav-h: 48px`、トップバー 46→40px、シートのヘッダ余白圧縮。横向き 844×390 で 1 画面に一覧＋操作が入る粒度にする。
- 中間幅の文字詰まりは**この 2 バッチでは rem 化しない**（211 箇所の px は別件）。狭い左ペイン向けに `--split-master-w: 280px` 帯の `font-size` だけ個別に詰める。

### B5 — 再発防止（機械）

- 新規 `scripts/audit-responsive.mjs`（依存追加なし）:
  - `Google Chrome --headless=new --remote-debugging-port=0` を起動し、stderr の `DevTools listening on ws://…` を読んで Node 標準 `WebSocket` で CDP 接続。
  - viewport: `390x844` / `744x1024`（iPad mini 縦）/ `768x1024` / `820x1180` / `1180x820`（横向き）/ `844x390`（スマホ横向き）/ `640x960`。
  - 各 viewport × `en`/`ja` × 5 タブで: `document.documentElement.scrollWidth === clientWidth`、はみ出し要素（`scrollWidth > clientWidth + 1`）の一覧、タップ対象の最小 44px、`console` エラー／`pageerror`。
  - 出力: 1 行 1 違反（`<viewport> <lang> <tab> <kind> <detail>`）／違反 0 で exit 0／Chrome が無ければ `skipped: chrome not found` を 1 行出して exit 0。
  - `npm run audit:responsive` を追加。
- 新規 `apps/web/test/i18nLeak.test.js`（静的）: `apps/bridge/src/*.js` と `apps/web/src/**` を走査し、`message:`/`error:`/`new Error(` の**日本語リテラルを 0 件**にする（allowlist は `review.js` の `runKanban` 引数と生成文のみ、行番号ではなくパターンで許可）。コメント内は対象外（除去してから判定）。
- `package.json`: `verify` に `audit:responsive` を追加（Chrome 無し環境は skip で緑）。
- **44px タップ対象の解消（t_c1ba8a8e・実装済み）**: 初日に受理した 23 パターンは全廃し、baseline を空にした
  （`audit-responsive.baseline.json` は `tap: []` / `clip: []`）。進め方は 2 通り:
  - 見た目を変えずに当たり判定だけ広げる（`t-pill` / `chip` / `snippet-chip` / `settings-nav-chip` / `btn` / `hm-switch` / `＋`）:
    透明な `::before` を中央へ 44x44 置く。ピル自身が `overflow: hidden` だと自分で切ってしまうので、
    省略は中のスパンに任せる（`.t-pill > span`）。行が浅い場合は帯側の padding で 44px を通す
    （`.telemetry` / `.chips` / `.chips-scroll` / `.ak-tabs`）。
  - 外へ広げると隣を食うもの（`.icon-btn` / `.link` / `.chat-report-btn` / `.snippet-chip.add`）:
    箱そのものを 44px にし、見た目は `::before` で塗る（`.icon-btn` は 32px の面を `inset: 6px`）。
  - 監査は「疑似要素の computed 寸法」に加えて `elementFromPoint` で広げた端を叩き、
    `overflow` の親に切られていないかまで測る（切られていれば違反）。

---

## 3. バッチ（board `hermes-pilot` / assignee `mobile` / 直列）

| # | 内容 | 主な変更 | 従属 |
|---|---|---|---|
| 1 | B1 i18n 土台 | `apps/bridge/src/api-errors.js`, `web/test/apiErrors.test.js` | — |
| 2 | B2 置換＋辞書 | `web/src/api.js`, ブリッジ 9 ファイル, `i18n/{ja,en}.json`, `web/test/i18nErrorCoverage.test.js` | 1 |
| 3 | B3 680px 境界 | `web/src/lib/layout.js`(新), `useSplitLayout.js`, `styles.css`, `web/test/layoutBreakpoints.test.js` | 2 |
| 4 | B4 横向き・safe-area | `manifest.webmanifest`, `styles.css`, `index.html` | 3 |
| 5 | B5 監査 | `scripts/audit-responsive.mjs`(新), `web/test/i18nLeak.test.js`(新), `package.json` | 4 |

直列にする理由: 3 と 4 が同じ `styles.css` を触る／2 の allowlist を 5 が読む。並列にすると衝突する。

## 4. 検証（共通）

- `npm run verify`（= `npm test` + `check:pwa` + `check:oauth` + `build`、＋今回 `audit:responsive`）が緑。
- 現在のベースライン: `npm test` = **622 tests / 0 fail**（2026-11-15 実行）。
- 実測の before/after は `shots/` に 390×844 と 744×1024（B3）／844×390 と 1180×820（B4）。

## 5. 起票（board `hermes-pilot` / assignee `mobile`）

| # | タスク | 内容 |
|---|---|---|
| 1 | `t_7a2b2c9c` | [i18n-1] ブリッジのエラーコード表を広げ、fail()/ApiError を用意する |
| 2 | `t_1892ce03` | [i18n-2] API エラーをコード化し、PWA が必ず自言語で出すようにする |
| 3 | `t_a9edfb3b` | [resp-1] 境界を 1 箇所に集約し 680px で狭い 2 ペインにする |
| 4 | `t_ed2ee4ac` | [resp-2] 横向きを許可し、safe-area 左右と低い高さに対応する |
| 5 | `t_1d81c7ed` | [guard] レスポンシブ実測監査と i18n 漏れテストを verify に入れる |

**注意（実測）**: このボードのディスパッチャは起票と同時に 5 枚すべてを `running` にし、**同じ作業ツリー**
（`~/Projects/hermes-mobile-pwa`）を同時に編集する。`kanban_link` は board 引数を無視して別ボードを見るため
**親子（直列）を後から張れない**（実測: `unknown task(s)`）。各カードに「自分の担当ファイルだけ `git add`・
`checkout -- .`/`stash`/`reset --hard` 禁止」をコメントで入れて衝突を抑えている。
直列にしたい場合は、**起票 → すぐに後続を手で blocked にする**運用が要る（下の付録バグが直るまで abort は使えない）。

## 6. 付録: 調査中に見つけた別件バグ（この SPEC の対象外）

- **`kanban.abort()` が全ボードで壊れている**（実測 2026-11-15）: `apps/bridge/src/kanban.js:246` が
  `['--board', slug, 'kanban', ...args]` の順で CLI を呼ぶため、`hermes` が `--board` を解釈できず
  `hermes: 'hermes-pilot' is not a 'hermes' command` で失敗する。結果、PWA の
  **「中断（kill switch）」が `ok:false` を返して何も止まらない**（`POST /api/boards/:slug/tasks/:id/abort`）。
  正しい順は `['kanban', '--board', slug, ...args]`（`review.js:647` / `inbox.js:185` / `capture.js` の
  `buildCreateArgs()` は既にこの順で正しい。壊れているのは `kanban.js:246` の 1 箇所だけ）。修正は 1 行だが、
  この SPEC の 5 バッチとは別件なのでここでは記録だけ残す。
