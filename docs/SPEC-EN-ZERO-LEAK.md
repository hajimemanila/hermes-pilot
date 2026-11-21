# SPEC: 英語環境ゼロ日本語リーク保証仕様書 (`SPEC-EN-ZERO-LEAK`)

- **Status**: archived
- **アーカイブ日**: 2026-11-21（COH-4・全バッチ完了済み。以後は参照用に保持し、新規起票の対象外）

- **状態**: 仕様確定（2026-11-21・全レイヤー多言語監査の結果に基づく残存 5 項目の解消仕様）
- **前提仕様**: [SPEC-i18n-gen.md](./SPEC-i18n-gen.md) / [SPEC-CATALOG-ADMISSION.md](./SPEC-CATALOG-ADMISSION.md) / [SPEC-UI-POLISH-V22.md](./SPEC-UI-POLISH-V22.md)
- **対象リポジトリ**: `hermes-mobile-pwa`（プラグイン名: `hermes-pilot` / `Hermes Pilot`）
- **全バッチ共通の完了条件**:
  - `npm run verify`（`npm test` + `check:dashboard` + `check:pwa` + `check:oauth` + `build` + `audit:responsive`）が 0 fail であること
  - `npm run deploy` および `npm run build:demo` + `demo/index.html` 同期が 0 exit であること

---

## 1. 監査で検出された残存箇所と真因（I1〜I5）

直近の多言語対応（`f847432`〜`f4e192b`）により、Web PWA 辞書（`en.json`）・Demo モード・同梱 3 スキルの `SKILL.md`・`SOUL.md`（`A2B_RULES`）・自動生成レビュー HTML の英語化は完了している。
しかし実コード監査の結果、英語環境（`lang=en`・英語ブラウザロケール・英語プロンプト）のユーザーに日本語（漢字・かな・全角和文記号）が見えてしまう経路が以下 **5 箇所** に残っていた。

| ID | 事象 | ソース上の真因 |
| :--- | :--- | :--- |
| **I1** | **Quick Review の HTML テンプレートが 100% 日本語** | `skills/quick-review/SKILL.md:126` は英語で「`.html` シートを作る場合は `assets/sheet-template.html` をコピーして中身を差し替えよ」と指示しているが、コピー元の `skills/quick-review/assets/sheet-template.html` 自体が `<html lang="ja">` のまま残っており、見出し（`設問` / `全体へのコメント`）、プレースホルダ、ボタン（`回答テキストを作る` / `コピー`）、JS 生成回答文（`【レビュー回答】` / `(未選択 = お任せ)` / `✓ コピーしました`）が日本語のまま出力される。 |
| **I2** | **ターミナル PTY エラー & Bridge 起動・実行ログが日本語固定** | `apps/bridge/src/server.js` の `/ws/term`（L1699 / L1717）が xterm 画面へ直接 `[bridge] node-pty が読み込めません` / `[bridge] PTY を起動できません` を送信している。さらに `server.js`（L1543 / L1757–1787）と `pipeline-watcher.js`（L1072）が吐く標準出力・エラーログが日本語固定のため、PWA の「設定 → ログ（Bridge / Errors）」および Hermes Dashboard の「Logs & Audit」で英語ユーザーに日本語が表示される。 |
| **I3** | **CLI・導入・移行・配備スクリプトが日本語／日英混在出力** | `bin/hermes-pilot.mjs`（`--help`, `mintPairCode`, `printPairing`, `askMigrate`, `runInit`, `runService`, `runStart`）、`scripts/postinstall.mjs`、`scripts/migrate-to-hermes-pilot.mjs`、`scripts/deploy.mjs` のコンソール出力に日本語単独メッセージおよび日英併記行が残っており、初回導入時（`npm ci` / `init` / `qr` / `service status`）やターミナルタブの英語スニペット（`Pilot Status` / `Pairing QR` / `Restart Bridge`）実行時に日本語が出る。 |
| **I4** | **Review の Reopen 既定理由が日本語固定（＋ autoStart の `lang` 欠落）** | `apps/bridge/src/review.js:1278` が `reason` 省略時のフォールバックに `'レビューの再確認をお願いします'` を直書きしており、`server.js:1145` も `langOf(req, url)` を渡していない。また `architect.js:1226` の `autoStart` `launchSpec()` 呼び出しが `job.lang` を渡していない（現状 `DEFAULT_LANG` が `'en'` のため英語ユーザーでは英語になるが、明示伝播が欠けている）。 |
| **I5** | **Bridge API の `reason` / `detail` に日本語直書き＋UI の全角 `＋` 残存＋`LiveSheet` 失敗フォールバック不整合** | `apps/bridge/src/{gitinfo,live,search,transcript,usage}.js` がエラー応答に機械コード `code` と併せて日本語の `reason` を返しており、`server.js:304` が `detail` として（`/api/live` は HTTP 200 JSON の `reason` として）そのまま露出する。加えて `LiveSheet.jsx:69` が `catch (e)` 時に `code` を載せず `reason: e.message` だけセットするため `localizeError(data)` が `err.BAD_REQUEST` に落ちてしまう。また `apps/web/src/i18n/en.json`（L109, L304, L724）および `AnnotationEditor.jsx:419`・`ChatPane.jsx:2733, 2751` に全角プラス `＋`（`U+FF0B`）が残っている。 |

---

## 2. 合意決定表（D70〜D74）

| ID | 論点 | 採択方針 | 対象 |
| :--- | :--- | :--- | :--- |
| **D70** | `quick-review` の HTML テンプレート言語 | `skills/quick-review/assets/sheet-template.html` を完全英語（`<html lang="en">`）へ刷新し、回答テキスト生成フォーマットも `replyTextOf('en')`（`[Review Answer] ` / `(unselected = take recommended)` / `note:` / `Overall Note:`）に一致させる（`parseReplyText` との往復保証）。あわせて `languageRule.test.js` でスキル配下のアセットに対する CJK ゼロ検証を機械固定する。 | `skills/quick-review/assets/sheet-template.html`, `apps/bridge/test/languageRule.test.js` |
| **D71** | Bridge ログ・ターミナル PTY エラーの言語 | `server.js` の `/ws/term` エラー出力、起動／異常終了ログ、API 500 ログ、および `pipeline-watcher.js` の警告ログを標準英語へ統一する（技術ログは言語トグルに依存せず英語で一貫）。`startup-log.test.js` のトークン非露出アサーションも英語ログに合わせて更新し、生トークン非出力と CJK ゼロを検証する。 | `apps/bridge/src/server.js`, `apps/bridge/src/pipeline-watcher.js`, `apps/bridge/test/startup-log.test.js` |
| **D72** | CLI・各種運用スクリプトの出力言語 | `bin/hermes-pilot.mjs`・`scripts/postinstall.mjs`・`scripts/migrate-to-hermes-pilot.mjs`・`scripts/deploy.mjs` の標準出力／標準エラー出力をすべて英語へ統一する（`hermes` / `npm` / `git` と同じく CLI の運用メッセージは英語単一言語とし、日英併記や日本語単独行を排除する）。既存の `cli.test.js`・`migrate.test.js` の検証正規表現を英語出力へ更新し、主要コマンド出力の CJK ゼロを固定する。 | `bin/hermes-pilot.mjs`, `scripts/*.mjs`, `apps/bridge/test/{cli,migrate}.test.js` |
| **D73** | `review.reopen` と `architect.js` の言語一貫性 | `server.js:1145` から `review.reopen(b, body?.reason, langOf(req, url))` へ言語を渡し、`review.js:1275-1280` の既定理由を `lang === 'ja' ? 'レビューの再確認をお願いします' : 'Please re-check and update the implementation'`（既定 `lang = 'en'`）へ分岐する。`architect.js:1226` の `launchSpec` 呼び出しにも `lang: job.lang` を明示渡しする。 | `apps/bridge/src/review.js`, `apps/bridge/src/server.js`, `apps/bridge/src/architect.js`, `apps/bridge/test/reviewI18n.test.js` |
| **D74** | API `reason`・`LiveSheet`・全角 `＋` のクリーンアップ | `gitinfo.js`・`live.js`・`search.js`・`transcript.js`・`usage.js` の `reason` 文字列を英語（`ERROR_MESSAGES` 準拠）へ統一し、既存の `code` による PWA 側 `localizeError()` 翻訳（EN/JA）を維持する。`LiveSheet.jsx:69` は `code: e?.code, params: e?.params, error: e?.message` を保持する。さらに `en.json`・`AnnotationEditor.jsx`・`ChatPane.jsx` の全角 `＋`（`U+FF0B`）を ASCII `+` へ置換し、`noHardcodedJapanese.test.js` の `GLYPHS` 例外も外せる状態へ進める。 | `apps/bridge/src/{gitinfo,live,search,transcript,usage}.js`, `apps/web/src/features/{LiveSheet,AnnotationEditor,ChatPane}.jsx`, `apps/web/src/i18n/en.json`, `apps/web/test/noHardcodedJapanese.test.js`, `demo/index.html` |

---

## 3. 詳細技術仕様

### 3.1 `quick-review` テンプレートの完全英語化（D70）

- 対象: `skills/quick-review/assets/sheet-template.html`
  - L2 `<html lang="ja">` → `<html lang="en">`
  - L6 `<title>Quick Review テンプレート</title>` → `<title>Quick Review Template</title>`
  - L7–22 HTML コメント → 英語化（`#akForm` / `#out` / `#genBtn` / `.q[data-q]` 契約説明を英語で記述）
  - L65 `<div class="kicker">QUICK REVIEW ／ ...` → `<div class="kicker">QUICK REVIEW / label=<span id="labelSlot">example-01</span> round=1</div>`
  - L66–109 本体見出し・設問プレースホルダ・選択肢・推奨バッジ（`Recommended`）・全体メモ（`<h2>Overall Note</h2>`, `placeholder="Instructions spanning multiple questions (optional)"`）・ボタン（`Generate reply text` / `Copy`）・フッタ（`Target: <code id="targetSlot">...</code>`）を英語へ統一。
  - L112–170 スクリプト内の固定文字列を `apps/bridge/src/review.js` の `REPLY_TEXT.en` 準拠に揃える:
    - 先頭行: `'[Review Answer] ' + LABEL`
    - 未選択: `'(unselected = take recommended)'`
    - 補足接頭辞: `' / note: '`
    - 全体コメント行: `'Overall Note: ' + (gv || '(none)')`
    - 末尾案内: `'Apply the answers above and continue. Items left unselected are settled by the recommended option.'`
    - ステータス文言: `'Reply text generated. Paste it or click [Submit answers].'`, `'✓ Copied'`, `'Select the text to copy'`
- 検査強化 (`apps/bridge/test/languageRule.test.js`):
  - `skills/quick-review/assets/sheet-template.html` を読み込み、CJK 文字（`/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff01-\uff60]/`）が 0 件であることをアサートするテストを追加する。
  - さらに同テンプレート内スクリプト相当の出力が `parseReplyText()`（`apps/bridge/src/review.js`）で正しく往復パースできることを検証する。

### 3.2 Bridge ログ・`/ws/term` エラー・Reopen・AutoStart 言語整合（D71・D73）

1. **`apps/bridge/src/server.js`**:
   - `/ws/term`（`openTerm` L1699, L1717）:
     - `'\r\n[bridge] node-pty failed to load\r\n'`
     - `` `\r\n[bridge] Failed to start PTY: ${err?.message ?? err}\r\n` ``
   - 起動・異常終了・500 エラーログ（L1543, L1757–1787）:
     - L1543: `console.error('[api] failed:', err)`
     - L1757–1759: `` `[bridge] Port ${cfg.port} is already in use. Check for leftover manual processes: ` + `lsof -nP -iTCP:${cfg.port} -sTCP:LISTEN -> hermes-pilot service restart (or launchctl kickstart -k gui/$(id -u)/ai.hermes.pilot)` ``
     - L1762: `'[bridge] Server error:'`
     - L1768: `` `[bridge] Upstream: ${cfg.hermesBase}` ``
     - L1769: `` `[bridge] Token file: ${cfg.tokenPath}` ``
     - L1770: `` `[bridge] Auth page: http://${cfg.host}:${cfg.port}/auth` ``（`/auth` を維持し既存起動検知と整合）
     - L1775: `` `[bridge] Failed to start reviewWatcher: ${err?.message}` ``
     - L1781: `` `[bridge] Failed to start pipelineWatcher: ${err?.message}` ``
     - L1785: `'[bridge] Hermes session token: resolved'`
     - L1787: `` `[bridge] Failed to resolve session token (is the dashboard stopped?): ${err?.message}` ``
   - `reopen` ルート（L1145）: `review.reopen(b, body?.reason, langOf(req, url))` へ変更。
2. **`apps/bridge/src/pipeline-watcher.js`**:
   - L1072: `` `[pipeline-watcher] Failed to update run reportedAt: ${err?.message ?? err}` ``
3. **`apps/bridge/src/review.js`（L1275–1280）**:
   - `async function reopen(id, reason, lang = 'en')`: 既定フォールバックを `lang === 'ja' ? 'レビューの再確認をお願いします' : 'Please re-check and update the implementation'` にする（`lang = 'en'` 既定の規約は `reviewI18n.test.js` の `lang = 'ja'` 禁止ルールも満たす）。
4. **`apps/bridge/src/architect.js`（L1226–1232）**:
   - `launchSpec({ ..., lang: job.lang })` とし、`autoStart` 経路でもジョブ生成時の `lang` を維持する。
5. **テスト更新（`apps/bridge/test/startup-log.test.js`・`reviewI18n.test.js`）**:
   - `startup-log.test.js` の起動ログパターン検査を `[bridge] Token file: ...` / `[bridge] Auth page: ...` に更新し、実起動の stdout/stderr に生トークンおよび日本語（CJK）が含まれないことを検証する。
   - `startup-log.test.js` L123–127 のログイン案内検査も `LOGIN_TEXT.en.hint`（英語既定）と `LOGIN_TEXT.ja.hint` の両方が旧文言「起動ログにあります」を含まずトークンファイル（`plugin-data/hermes-pilot/token`）を指すことを確認する。

### 3.3 CLI と導入・移行・配備スクリプトの英語出力統一（D72）

1. **`bin/hermes-pilot.mjs`**:
   - `helpText()`（L172–177）の `環境 / Environment:`・`データ先 / Data:`・LaunchAgent 注記を英語単一表記へ整理。
   - `mintPairCode()`（L355）: `` `One-time code: ${code} (valid for ${minutes} min, single-use)` ``
   - `printPairing()`（L368–422）: `'Pairing targets:'`, `'No reachable address found (check Tailscale or your LAN connection).'`, `` `QR image (PNG): ${pngPath}` ``, `` `  -> Open this image at full size and scan it with your phone camera (${png.length} bytes).` ``, 端末幅超過メッセージと端末内 QR 見出しをすべて英語化。
   - `askMigrate()`（L455）: `'Legacy data (akapen / mobile-pwa) found. Migrate legacy data now? [y/N]: '`
   - `runInit()`（L625–677）: `Migrated legacy data:`, `init done`, `data`, `token`, `skills`, `migrate`, `dashboard tab` 案内（`hermes plugins enable hermes-pilot` とダッシュボード再起動案内を含む）を英語へ統一。
   - `runService()`（L737–853）: macOS (`launchd`) / Linux (`systemd --user`) の状態・登録・削除・再起動メッセージ（`present` / `missing`、`state: running` / `not installed` 等）を英語へ統一。
   - `runStart()`（L872–875）＆ `qr` 作成ログ（L919）を英語へ統一。
2. **`scripts/postinstall.mjs`**（L13, L28, L32）:
   - `[postinstall] node-pty prebuilds not found (skipping)`
   - `` `[postinstall] chmod failed: ${err?.message}` ``
   - `` `[postinstall] node-pty spawn-helper: fixed ${fixed} file(s)` ``
3. **`scripts/migrate-to-hermes-pilot.mjs`**（L382, L393, L401, L426–470）:
   - `report.skipped`・`formatReport()`・CLI エラー出力をすべて英語へ統一（出力される `kanban.db` 件数・`crons.removed` / `crons.detected`・`old directories were NOT removed` 等の意味・構造は維持）。
4. **`scripts/deploy.mjs`**（L24–58）:
   - エラーメッセージと `Verify:` / `Deployed:` ログを英語へ統一。
5. **テスト更新（`apps/bridge/test/cli.test.js`・`apps/bridge/test/migrate.test.js`）**:
   - `--help` / `qr` / `service status` / `init` / `migrate`（`formatReport`）のアサーションを新しい英語出力に合わせ、CLI・スクリプトの stdout に日本語（CJK）が出ないことを検証する。

### 3.4 Bridge API `reason` 英語化（D74 前半）

- 対象:
  - `apps/bridge/src/gitinfo.js`（L119, 122, 123, 131, 172, 178, 181）
  - `apps/bridge/src/live.js`（L194, 211）
  - `apps/bridge/src/search.js`（L133, 137, 152）
  - `apps/bridge/src/transcript.js`（L151, 155, 220）
  - `apps/bridge/src/usage.js`（L123, 167, 213, 214, 275）
- 変更内容:
  - 各モジュールの `code`（`NO_GIT_RECORD`, `NO_COMMITS`, `GIT_REPO_MISSING`, `GIT_SHOW_FAILED`, `FILE_NOT_IN_COMMIT`, `DB_NOT_FOUND`, `READ_FAILED`, `QUERY_REQUIRED`, `SEARCH_FAILED`, `SESSION_REQUIRED`, `AGG_FAILED`, `SCOPE_MISSING`）は変更せず、`reason` 文字列を英語（`api-errors.js` の `ERROR_MESSAGES` と同義の英語文）に統一する。
  - `apps/bridge/test/gitinfo.test.js`（L80, L91 等）・`search.test.js`・`usage.test.js`・`live.test.js`・`transcript.test.js` で `reason` に日本語が含まれないことを検証・更新する。
  - あわせて `apps/web/test/i18nErrorCoverage.test.js` の `SCOPED` 対象に上記 5 モジュール（または `reason:` ゼロ CJK 検査）を加え、今後の逆戻りを防ぐ。

### 3.5 Web UI 全角 `＋` 正規化・`LiveSheet` 修正・統合監査（D74 後半）

1. **`apps/web/src/i18n/en.json`**:
   - L109 `"review.emptyNewAnnotation": "+ Create an annotation"`
   - L304 `"settings.barsHint": "... reachable from the chat + menu, ..."`
   - L724 `"tasks.newTask": "+ New"`
   - （参考）`ja.json` は日本語 UI の表記として現状維持し、`i18n.test.js` のキー数／プレースホルダ一致に影響がないことを確認する。
2. **JSX コンポーネント**:
   - `apps/web/src/features/AnnotationEditor.jsx:419`: `＋` → `+`（既存テスト `annotationLayout.test.js:83` は `className="ak-anno-more"` を検査しているため互換）。
   - `apps/web/src/features/ChatPane.jsx:2733, 2751`: `＋` → `+`
   - `apps/web/src/features/LiveSheet.jsx:69, 141`:
     - L69: `setData({ ok: false, code: e?.code, params: e?.params, error: e?.message, reason: e?.message, turns: [], tasks: [] })`
     - L141: `data.code || data.error ? localizeError(data) : data.reason || t('live.failed')` とし、`/api/live` の通信断時は `err.OFFLINE`（辞書翻訳）、`code` なし時は `reason` / `live.failed` が出るようにする。
3. **テスト＆デモ同期**:
   - `apps/web/test/noHardcodedJapanese.test.js`: `GLYPHS = /＋/g` の例外除去（`apps/web/src/` の JSX/JS から `＋` も完全ゼロになったことを固定）。
   - `apps/web/test/i18nLeak.test.js` / 新規アサーションで `en.json` 全値（`settings.languageJa` の `"日本語"` を除く）に CJK および全角記号 `[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uff01-\uff60]` が 0 件であることを固定する。
   - `npm run deploy`・`npm run build:demo`・`demo/index.html` 同期を実施してバンドルへ反映する。

---

## 4. カンバンタスク分割（Batch E1 〜 Batch E4）

### Batch E1: Quick Review HTML テンプレート（`sheet-template.html`）の完全英語化＆アセットガード追加

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: `skills/quick-review/SKILL.md` が `.html` シート作成時のコピー元として指示している `skills/quick-review/assets/sheet-template.html` を完全英語化し、スキル配下アセットの CJK ゼロ検証テストを追加する。
- **変更・新規ファイル**:
  - 変更: `skills/quick-review/assets/sheet-template.html`
  - 変更: `apps/bridge/test/languageRule.test.js`
- **受入条件（Verify）**:
  - `skills/quick-review/assets/sheet-template.html` が `<html lang="en">` となり、UI ラベル・プレースホルダ・ボタン・生成回答テキスト（`[Review Answer]` / `(unselected = take recommended)` / `note:` / `Overall Note:`）・HTML コメントを含め日本語（CJK・全角和文記号）が 0 文字であること。
  - `#akForm` / `#out` / `#genBtn` / `.q[data-q]` / `label[data-opt]` / `input[type=radio]` の DOM 構造が維持され、`injectReviewBridge` および `parseReplyText`（`apps/bridge/src/review.js`）で往復パースできること。
  - `apps/bridge/test/languageRule.test.js` が `skills/quick-review/assets/sheet-template.html` の CJK 0 件を検証するテストを含めてパスすること。
  - `npm run verify` が全件パスすること。

### Batch E2: Bridge PTY・起動ログ・Review Reopen・API `reason` の英語化

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: ターミナルタブ（`/ws/term`）の PTY エラー、Settings/Dashboard ログビューアに出る Bridge 起動・実行ログ、`review.reopen` 既定理由、およびデータ API モジュールの `reason` フィールドから日本語直書きを排除する。
- **変更・新規ファイル**:
  - 変更: `apps/bridge/src/server.js`
  - 変更: `apps/bridge/src/pipeline-watcher.js`
  - 変更: `apps/bridge/src/review.js`
  - 変更: `apps/bridge/src/architect.js`
  - 変更: `apps/bridge/src/gitinfo.js`
  - 変更: `apps/bridge/src/live.js`
  - 変更: `apps/bridge/src/search.js`
  - 変更: `apps/bridge/src/transcript.js`
  - 変更: `apps/bridge/src/usage.js`
  - 変更: `apps/bridge/test/startup-log.test.js`
  - 変更: `apps/bridge/test/gitinfo.test.js`
  - 変更: `apps/bridge/test/reviewI18n.test.js`
  - 変更: `apps/web/test/i18nErrorCoverage.test.js`
- **受入条件（Verify）**:
  - `server.js` の `openTerm` / `server.listen` / `server.on('error')` / 500 ログおよび `pipeline-watcher.js:1072` のログ出力に日本語が存在せず、`startup-log.test.js`（生トークン非露出＆英語ログ確認）がパスすること。
  - `server.js` が `review.reopen(b, body?.reason, langOf(req, url))` を呼び出し、`review.reopen(..., 'en')`（既定）が英語、`(..., 'ja')` が日本語フォールバックを返すこと（`reviewI18n.test.js` で検証）。
  - `architect.js` の `autoStart` `launchSpec` 呼び出しに `lang: job.lang` が渡されていること。
  - `gitinfo.js` / `live.js` / `search.js` / `transcript.js` / `usage.js` の全 `reason` が英語になり、`i18nErrorCoverage.test.js` および `gitinfo.test.js` / `search.test.js` / `usage.test.js` がパスすること。
  - `npm run verify` が全件パスすること。

### Batch E3: CLI（`hermes-pilot`）および導入・移行・配備スクリプトの英語出力統一

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: `hermes-pilot` CLI および `postinstall` / `migrate` / `deploy` スクリプトのコンソール出力をすべて英語へ統一し、初回導入やターミナルタブのスニペット実行時に英語ユーザーへ日本語が表示されないようにする。
- **変更・新規ファイル**:
  - 変更: `bin/hermes-pilot.mjs`
  - 変更: `scripts/postinstall.mjs`
  - 変更: `scripts/migrate-to-hermes-pilot.mjs`
  - 変更: `scripts/deploy.mjs`
  - 変更: `apps/bridge/test/cli.test.js`
  - 変更: `apps/bridge/test/migrate.test.js`
- **受入条件（Verify）**:
  - `bin/hermes-pilot.mjs`（`helpText`, `mintPairCode`, `printPairing`, `askMigrate`, `runInit`, `runService`, `runStart`, `qr`）、`scripts/postinstall.mjs`、`scripts/migrate-to-hermes-pilot.mjs`、`scripts/deploy.mjs` の非コメント出力文字列に日本語（CJK・全角和文括弧/記号）が含まれないこと。
  - `hermes-pilot qr` で引き続き 8 文字ワンタイムコード・`Pairing targets:`・PNG/ターミナル QR 案内（本トークン非露出）が出ること。
  - `migrate.test.js`（D55 規約: `kanban.db` 書換ゼロ・`hermes cron` CLI 経由クリーンアップ・冪等性）と `cli.test.js` が英語出力期待値で全件パスすること。
  - `npm run verify` が全件パスすること。

### Batch E4: 全角 `＋` の ASCII 化・`LiveSheet` 修復・英語環境 0-CJK 最終検証＆デモ同期

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: `en.json`・JSX に残る全角 `＋`（`U+FF0B`）の ASCII `+` 化と `LiveSheet.jsx` エラーフォールバック修正を行い、Web/Demo/Bridge/Skills/CLI 全域の英語環境ゼロ CJK 回帰テスト＋ビルド＆デモ同期を完了する。
- **変更・新規ファイル**:
  - 変更: `apps/web/src/i18n/en.json`
  - 変更: `apps/web/src/features/AnnotationEditor.jsx`
  - 変更: `apps/web/src/features/ChatPane.jsx`
  - 変更: `apps/web/src/features/LiveSheet.jsx`
  - 変更: `apps/web/test/noHardcodedJapanese.test.js`
  - 変更: `apps/web/test/i18nLeak.test.js`
  - 同期: `demo/index.html`
- **受入条件（Verify）**:
  - `en.json` の `"settings.languageJa": "日本語"` を除く全キーおよび `apps/web/src/**/*.{js,jsx}` 非コメント部に CJK・全角和文記号（`＋` 含む）が 0 件であること。
  - `noHardcodedJapanese.test.js` で `GLYPHS = /＋/g` 除外が不要（撤去済み）でパスし、`annotationLayout.test.js`・`i18n.test.js`・`i18nLeak.test.js` が全件パスすること。
  - `LiveSheet.jsx` がオフライン／API エラー時に `code` / `params` / `error` を保持して `localizeError()` で正しい言語メッセージを表示すること。
  - `npm run verify`・`npm run deploy`・`npm run build:demo` + `demo/index.html` 同期がすべて 0 exit で完走すること。
