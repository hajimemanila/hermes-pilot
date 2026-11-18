# SPEC: Hermes Agent 公式プラグインカタログ掲載対応 (`SPEC-CATALOG-ADMISSION`)

- **状態**: 対応完了（`NousResearch/hermes-agent#156102` レビュー指摘事項 #1〜#5 を実装。`v0.2.0` として
  npm 公開・Release 公開済み、PR には再レビュー依頼を投稿済み）
- **対象 PR**: <https://github.com/NousResearch/hermes-agent/pull/156102>（レビュアー: `@teknium1`、
  対象基準コミット: `5c82ba628ae715e5ae4d390940d5fd4c20612cac` / tag `v0.2.0`）
  - npm: `hermes-pilot@0.2.0`（`latest`、`gitHead` も同 SHA）
  - 旧ピン `8c7d8d81`（`v0.1.0`）は D55〜D59 実装前のため失効
- **対象リポジトリ**: `hermes-mobile-pwa`（プラグイン名: `hermes-pilot` / `Hermes Pilot`）
- **全バッチ共通の完了条件**:
  - `npm run verify`（`npm test` + `check:pwa` + `check:oauth` + `build` + `audit:responsive`）が 0 fail であること
  - `npm run build:demo` が 0 exit で自己完結 HTML（`apps/web/dist-demo/google-sites-embed.html`）を生成し、`demo/index.html` と同期していること
  - `npm pack --dry-run` がエラーなく完了すること

---

## 1. レビュー指摘事項と方針（D55〜D59）

| ID | PR #156102 指摘内容 | 採択方針 | 対象 |
| :--- | :--- | :--- | :--- |
| **D55** | **Hermes state への直接書き込み禁止 & `init` 自動移行の廃止** | `scripts/migrate-to-hermes-pilot.mjs` の `kanban.db` 直接 read-write 更新と `~/.hermes/cron/jobs.json` 直接書き換えを廃止し、旧 cron は `hermes cron list` → `hermes cron remove <id>` の公式 CLI 経由で削除する。`kanban` の `[akapen]` タグは `review.js` 側で後方互換読み取り済みのため DB 書き換え自体を削除する。`bin/hermes-pilot.mjs init` での自動無言移行を廃止し、対話確認（または `--yes` / 明示的な `migrate` サブコマンド）必須とする。 | `scripts/migrate-to-hermes-pilot.mjs`, `bin/hermes-pilot.mjs`, `apps/bridge/test/migrate.test.js` |
| **D56** | **プラグインルート構成の正規化（`hermes plugins install` 即時動作）** | リポジトリルートに `__init__.py`、`dashboard/manifest.json`、`dashboard/plugin_api.py`、`dashboard/pilot_dashboard.py`、`dashboard/dist/index.js`、`dashboard/dist/style.css` をコミット配置し、`hermes plugins install` 後にそのままダッシュボードプラグインとして認識される構成にする。`apps/dashboard/` との整合チェック／同期スクリプトを整備する。 | `__init__.py`, `dashboard/*`, `scripts/sync-dashboard.mjs`, `bin/hermes-pilot.mjs` |
| **D57** | **レビューシートの常時サンドボックス化 & ラッパー経由 `postMessage`** | `GET /api/review/:id/sheet` は `sec-fetch-dest` に関わらず**常に** `sandbox allow-scripts allow-forms` 付きの厳格な CSP で返し、シート内スクリプトが same-origin Cookie や `/ws/term` に到達できないようにする。単体タブ閲覧用のブリッジ所有ラッパーHTML（`/api/review/:id/view`）を追加し、ラッパーが sandbox `<iframe>` で `/api/review/:id/sheet` を囲み、`postMessage` を受けて `POST /api/review/:id/answer` へ中継する。 | `apps/bridge/src/server.js`, `apps/bridge/src/review.js`, `apps/bridge/test/review.test.js` |
| **D58** | **起動ログへのトークン生出力の削除** | `apps/bridge/src/server.js` の起動時 `console.log` から `?t=${auth.token}` を削除し、トークンファイルのパス（`cfg.tokenPath`）のみを出力する（`~/.hermes/logs/pilot.out.log` への生トークン記録を防止）。 | `apps/bridge/src/server.js`, `apps/bridge/test/*` |
| **D59** | **未公開 npm パッケージ参照の排除 & 公開準備** | 未公開の `npx hermes-pilot ...` 表記を `node bin/hermes-pilot.mjs ...`（または手動 `npm link` 後の `hermes-pilot`）へ置換し、`hermes plugins install` → `npm ci` → `node bin/hermes-pilot.mjs init` の導入手順をドキュメントへ反映する。同時に `package.json` の `files` 整理と `npm pack --dry-run` を通して、ユーザーが任意で `npm publish` できる状態を整える。 | `package.json`, `apps/bridge/src/term-snippets.js`, `README.md`, `README.ja.md`, `docs/OPERATIONS.md` |

---

## 2. 実装バッチ一覧

### Batch C1: Hermes state 直接書き込みの廃止 & 移行確認（D55）
- Execution Mode: `Zero-Stop`
- 変更ファイル:
  - `scripts/migrate-to-hermes-pilot.mjs`
  - `bin/hermes-pilot.mjs`
  - `apps/bridge/test/migrate.test.js`（または該当テストファイル）
- 実装仕様:
  1. `scripts/migrate-to-hermes-pilot.mjs` から `DatabaseSync` を使った `kanban.db` への直接書き込み（`rewriteKanbanTag` 内の `UPDATE tasks ...` およびバックアップ作成）を廃止する（関数を残す場合は no-op 互換または削除し、`kanban.db` を一切 `read-write` で開かない）。
  2. `cleanupLegacyCrons` から `~/.hermes/cron/jobs.json` / `cron.json` の直接ファイル書き換え（`fs.writeFileSync` / `fs.renameSync`）を廃止し、`hermes cron list --json`（またはテキスト行解析）で `mobile-akapen-watch` / `mobile-review-watch` のジョブ ID を抽出し、`hermes cron remove <id>` を `execFileSync` / `spawnSync`（テスト用にランナー DI 可）で実行する方式へ置き換える。
  3. `bin/hermes-pilot.mjs` の `runInit()` で旧環境を検知した際、自動無言で `migrate()` を実行するのを止め、TTY かつ `--yes` でない場合は `readline` で `y/N` 確認を求める（非 TTY で `--yes` が無い場合はスキップして `node bin/hermes-pilot.mjs migrate` を案内する）。
- 受入条件:
  - `scripts/migrate-to-hermes-pilot.mjs` に `UPDATE tasks` や `cron/jobs.json` への `writeFileSync` / `renameSync` が存在しないこと
  - `npm test` が全件通過すること

---

### Batch C2: プラグインルート構成の正規化（D56）
- Execution Mode: `Zero-Stop`
- 変更ファイル:
  - `__init__.py`（新規・`apps/dashboard/plugin_init.py` と同内容）
  - `dashboard/manifest.json`（新規・`apps/dashboard/manifest.json` と同内容）
  - `dashboard/plugin_api.py`（新規・`apps/dashboard/plugin_api.py` と同内容）
  - `dashboard/pilot_dashboard.py`（新規・`apps/dashboard/pilot_dashboard.py` と同内容）
  - `dashboard/dist/index.js`（新規・`apps/dashboard/index.js` と同内容）
  - `dashboard/dist/style.css`（新規・`apps/dashboard/style.css` と同内容）
  - `bin/hermes-pilot.mjs`
  - `package.json`
- 実装仕様:
  1. リポジトリルートに `__init__.py` と `dashboard/` 配下のファイル群をコミットし、`hermes plugins install hajimemanila/hermes-pilot --ref <sha>` で展開した直後から Hermes プラグインローダおよびダッシュボードがそのまま認識できる状態にする。
  2. `bin/hermes-pilot.mjs` の `DASHBOARD_FILES` は引き続き `~/.hermes/plugins/hermes-pilot/` への冪等コピーを維持しつつ、リポジトリルート自体をプラグインディレクトリとして直接 `hermes plugins install` された場合（`targetDir === ROOT` のとき）は自己上書きを避けてスキル・データ初期化のみを安全に完了させる。
  3. `package.json` の `files` 配列に `__init__.py` と `dashboard/` を含める。
- 受入条件:
  - ルートに `__init__.py`, `dashboard/manifest.json`, `dashboard/plugin_api.py`, `dashboard/pilot_dashboard.py`, `dashboard/dist/index.js`, `dashboard/dist/style.css` が存在すること
  - `hermes` CLI が導入されている環境では `hermes plugins validate .` が通過すること
  - `npm test` が全件通過すること

---

### Batch C3: レビューシートの常時サンドボックス化 & ラッパー経由 `postMessage`（D57）
- Execution Mode: `Zero-Stop`
- 変更ファイル:
  - `apps/bridge/src/server.js`
  - `apps/bridge/src/review.js`
  - `apps/bridge/test/review.test.js`（または該当テスト）
- 実装仕様:
  1. `GET /api/review/:id/sheet`（`apps/bridge/src/server.js`）は `sec-fetch-dest` ヘッダによる分岐を廃止し、**常に** `sandbox allow-scripts allow-forms; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; script-src 'unsafe-inline'; font-src data:` の厳格な CSP を返却する。これによりシート HTML 内のスクリプトが same-origin Cookie や `/ws/term` へアクセスできないようにする。
  2. 単体タブでシートを開きたい場合用の軽量ラッパーエンドポイント `GET /api/review/:id/view` を新設し、ブリッジ自身が生成する最小 HTML（`src="/api/review/:id/sheet"` を `sandbox="allow-scripts allow-forms"` の `<iframe>` で埋め込み、`window.addEventListener('message', ...)` で回答イベントを受信して same-origin で `POST /api/review/:id/answer` を送信する）を返す。
  3. `injectReviewBridge`（`apps/bridge/src/review.js`）がシート内部に持っていた直接 `fetch('/api/review/...')` フォールバックを削除し、`window.parent.postMessage(...)` のみに一本化する。
- 受入条件:
  - `GET /api/review/:id/sheet` が単体リクエストでも常に `sandbox` CSP ヘッダを返すことをユニットテストで検証すること
  - PWA 内 iframe および `/api/review/:id/view` ラッパー経由の両方で `postMessage` → `POST /api/review/:id/answer` が動作すること

---

### Batch C4: 起動ログのトークン非露出（D58）
- Execution Mode: `Zero-Stop`
- 変更ファイル:
  - `apps/bridge/src/server.js`
  - `apps/bridge/test/*`（必要に応じてアサーション追加）
- 実装仕様:
  1. `apps/bridge/src/server.js` 1718 行目の起動時ログを修正し、`auth.token` の生文字列を一切 `console.log` に出さない。代わりに `cfg.tokenPath`（例: `[bridge] トークンファイル: ${cfg.tokenPath}` および `http://${cfg.host}:${cfg.port}/auth`）のみを出力する。
  2. `/auth` ログイン案内文言（`apps/bridge/src/server.js` 392 行目付近）の「またはブリッジの起動ログにあります」等の記述を「トークンファイル（`~/.hermes/plugin-data/hermes-pilot/token`）を確認してください」に更新する。
- 受入条件:
  - `apps/bridge/src/server.js` 内に `auth.token` を `console.log` / `console.error` へ出力する箇所が存在しないこと
  - `npm test` が全件通過すること

---

### Batch C5: npm パッケージ検証 & 導入手順・ドキュメント同期（D59）
- Execution Mode: `Zero-Stop`
- 変更ファイル:
  - `apps/bridge/src/term-snippets.js`
  - `README.md`
  - `README.ja.md`
  - `docs/OPERATIONS.md`
  - `demo/index.html`（ビルド同期）
- 実装仕様:
  1. `apps/bridge/src/term-snippets.js`（90 行目 `npx hermes-pilot qr`）および `README.md`・`README.ja.md`・`docs/OPERATIONS.md` 内の `npx hermes-pilot ...` 表記を `node bin/hermes-pilot.mjs ...` へ統一する。
  2. カタログ導入手順を `hermes plugins install hajimemanila/hermes-pilot --ref <sha>` → `npm ci` → `node bin/hermes-pilot.mjs init` の順に整理して記載する。
  3. 最終確認として `npm run verify`、`npm run build:demo`、`demo/index.html` 同期、`npm pack --dry-run` を実行してすべて成功させる。
- 受入条件:
  - `apps/bridge/src/`・`README.md`・`README.ja.md` に未公開前提の `npx hermes-pilot` が残っていないこと
  - `npm run verify`・`npm run build:demo`・`npm pack --dry-run` がすべて 0 exit であること

---

## 3. 人間の介在が必要な作業（npm パッケージ初回公開を行う場合）

Hermes Agent はセキュリティ上、あなたの npm アカウント認証・2FA（OTP）を代行できません。`npx hermes-pilot` を使えるように初回パッケージ公開も行う場合は、Batch C1〜C5 完了後に以下の手順を手元ターミナルで実施してください（`node bin/hermes-pilot.mjs` のまま進める場合は不要です）：

1. **npm ログイン**:
   ```bash
   npm login
   ```
   （ブラウザが開くので npm アカウントで認証・2FA 承認）
2. **パッケージ内容の最終確認**:
   ```bash
   npm pack --dry-run
   ```
3. **初回公開（MIT・Public）**:
   ```bash
   npm publish --access public
   ```
   （2FA の OTP コード入力またはブラウザ承認を実施）
4. **PR #156102 の再ピンとコメント**:
   - Batch C1〜C5 の修正コミットを `main` へプッシュ後、新しい 40 文字のコミット SHA を `NousResearch/hermes-agent` の `plugin-catalog/hermes-pilot.yaml`（`sha:`）へ反映してプッシュし、PR #156102 に修正完了コメントを投稿する。
