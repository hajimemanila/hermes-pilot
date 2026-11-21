# SPEC: 汎用システム整合性保証・自律コヒーレンス基盤仕様書 (`SPEC-COHERENCE`)

- **状態**: 仕様確定（2026-11-21・残存バッチ再編: Layer 1 診断コア / `/api/coherence/report` / `specs.js` アーカイブ分割 / `RefactorSheet` 5 種スイープ / Tasks バナー / ドキュメントガイド実装済み。残バッチ `COH-1`〜`COH-5`）
- **前提仕様**: [SPEC-EN-ZERO-LEAK.md](./SPEC-EN-ZERO-LEAK.md) / [SPEC-ROLE-DELEGATION-ROUTING.md](./SPEC-ROLE-DELEGATION-ROUTING.md) / [SPEC-PILOT-V11.md](./SPEC-PILOT-V11.md)
- **対象リポジトリ**: `hermes-mobile-pwa`（プラグイン名: `hermes-pilot` / `Hermes Pilot`）
- **全バッチ共通の完了条件**:
  - 本リポジトリにおける変更後は `npm run verify`（Batch `COH-3` 以降は `check:coherence` を含む全ゲート）が 0 fail であること
  - 外部 AI CLI のサブプロセス起動禁止（`check:oauth` 通過・Hermes Native 完結）および D55 非干渉原則（Hermes 本体の SQLite / cron DB への直接書き込み禁止・ユーザー承認なき自動タスク起票禁止）を遵守すること
  - `SPEC-EN-ZERO-LEAK` 遵守（CLI / Bridge ログ・エラー `reason` は英語単一言語、Web UI 追加文言は `en.json` / `ja.json` 同時追加・英語辞書 CJK / 全角記号ゼロ）
  - `themeTokens.test.js` 遵守（JSX inline style およびコンポーネント CSS への色直書き禁止・テーマトークンのみ使用）
  - Demo Mock 変更を伴うバッチ（`COH-2` / `COH-5`）では `npm run deploy` および `npm run build:demo` ＋ `demo/index.html` 同期が 0 exit であること

---

## 1. 背景と実装済み／残存スコープ（2026-11-21 時点）

### 1.1 先行実装済みコンポーネント
- **Layer 1 汎用診断エンジン**: [apps/bridge/src/coherence.js](file:///Users/hajimenakagawa/projects/hermes-mobile-pwa/apps/bridge/src/coherence.js)（`git-hotspot`, `file-bloat`, `spec-sprawl`, `debt-spike`, `.hermes-coherence.json` Layer 2 ローダ）および [.hermes-coherence.json](file:///Users/hajimenakagawa/projects/hermes-mobile-pwa/.hermes-coherence.json) / [scripts/coherence-baseline.json](file:///Users/hajimenakagawa/projects/hermes-mobile-pwa/scripts/coherence-baseline.json)
- **Bridge Coherence API & SPEC アーカイブ基盤**: [apps/bridge/src/specs.js](file:///Users/hajimenakagawa/projects/hermes-mobile-pwa/apps/bridge/src/specs.js)（`extractSpecStatus` / `partitionSpecs` / `docs/archive` 対応）・[apps/bridge/src/server.js](file:///Users/hajimenakagawa/projects/hermes-mobile-pwa/apps/bridge/src/server.js)（`GET /api/specs?includeArchived=1`・`GET /api/coherence/report`）・[apps/web/src/demo/mockApi.js](file:///Users/hajimenakagawa/projects/hermes-mobile-pwa/apps/web/src/demo/mockApi.js)（`/api/coherence/report` モック）
- **汎用スイープ UI & Tasks 統合**: [apps/web/src/lib/coherenceSweep.js](file:///Users/hajimenakagawa/projects/hermes-mobile-pwa/apps/web/src/lib/coherenceSweep.js)・[apps/web/src/styles/coherence.css](file:///Users/hajimenakagawa/projects/hermes-mobile-pwa/apps/web/src/styles/coherence.css)・[TaskToolSheets.jsx](file:///Users/hajimenakagawa/projects/hermes-mobile-pwa/apps/web/src/features/TaskToolSheets.jsx)（5 プリセット `RefactorSheet`）・[TasksPane.jsx](file:///Users/hajimenakagawa/projects/hermes-mobile-pwa/apps/web/src/features/TasksPane.jsx)（予兆提案バナー・`Show archived` トグル・Spec スコープ済み進捗判定）・関連ガイド（`README*.md`, `docs/{OPERATIONS,PITFALLS}.md`）

### 1.2 残存 Architectural Drift と残バッチ（`COH-1`〜`COH-5`）

| 残バッチ | 解消する残存 Drift（D80〜D85） | 対象ファイル |
| :--- | :--- | :--- |
| **COH-1** | **Frontend イベント・ストレージ契約集約 & `App.jsx` 脆弱リレー解消**: `hm:*`（25 種）と `hm.*`（21 種 + `COHERENCE_DISMISSED`）が生文字列のまま 25+ ファイルに散在し、`App.jsx`（L513, L524, L795, L1088）に `setTimeout` タブ間ディスパッチが残存。 | `apps/web/src/contracts/{events,storage}.js`, `apps/web/src/**`, `apps/web/test/contracts.test.js` |
| **COH-2** | **API 契約レジストリ + Demo パリティ修復 + 検証契約の抽象化（D85）**: Web 54 系統の `/api/*` と `server.js` / `mockApi.js` の契約表不在、`/api/discord/session`・`/api/gateway/{pause,resume}` の Demo 欠損、`specs.js` / `pipeline-optimizer.js` / `pipeline-watcher.js` 内の `npm run verify` / `npm run deploy` / `390×844` 決め打ち直書き。 | `apps/bridge/src/contracts/routes.js`, `apps/bridge/src/{specs,pipeline-optimizer,pipeline-watcher}.js`, `apps/web/src/demo/mockApi.js`, 関連テスト |
| **COH-3** | **本リポジトリ Layer 2 チェッカー `check:coherence` 実装 & `verify` 統合**: Layer 1 エンジンは動くが `.hermes-coherence.json` の `"checker"` が未接続で、API パリティ・契約生文字列・廃止シンボル再流入・EN/JA 辞書 & Docs コマンド一致を機械検証する `scripts/check-coherence.mjs` が未作成。 | `scripts/check-coherence.mjs`, `.hermes-coherence.json`, `package.json`, `apps/bridge/test/coherence.test.js` |
| **COH-4** | **完了済み歴史 SPEC のアーカイブマーク & 契約整合仕上げ**: `activeSpecCount` が 23 件と高く `spec-sprawl`（上限 6）が発火し続けるため、完了済み過去 SPEC に `- **Status**: archived` を付記して視界を整理。 | 完了済み `docs/SPEC-*.md` 群, `apps/bridge/test/specs.test.js` |
| **COH-5** | **パイプライン完走フックの汎用予兆検知 & レポート連携（D55）**: `coherence.js` の `coherenceAlertFrom()` が `pipeline-watcher.js` の完走レポート生成へ未接続。完走タイミングのみで安全に呼び出し `coherence_alert` ＋ 推奨次手を出力する。 | `apps/bridge/src/pipeline-watcher.js`, `apps/bridge/test/pipelineWatcher.test.js`, `apps/web/src/demo/mockApi.js` |

---

## 2. 合意決定表（D80〜D85 要約）

| ID | 決定事項 |
| :--- | :--- |
| **D80** | **2 層診断構成**: Layer 1（`apps/bridge/src/coherence.js`）は設定ゼロで全言語対応、Layer 2（`.hermes-coherence.json` の `"checker"`）で本リポジトリ専用検査 `scripts/check-coherence.mjs` を統合。 |
| **D81** | **Frontend / Backend 単一真実源**: `contracts/{events,storage,routes}.js` に契約を集約し、契約外の生 `'hm:*'` / `'hm.*'` / 未登録 `/api/*` を禁止。 |
| **D82** | **`RefactorSheet` 汎用スイープ**: 実装済み（5 プリセット＋単発 / Spec Architect 2 択起票）。 |
| **D83** | **D55 準拠の完走フック予兆検知**: 自動カンバン起票はせず、`pipeline-watcher.js` の完了レポートと `TasksPane` バナーのみで提案。 |
| **D84** | **モノリスラチェット＋SPEC アーカイブ**: 既存 `docs/SPEC-*.md` のファイルパスを維持したままヘッダの `- **Status**: archived` でアーカイブ扱いとし、リンクや `specs.test.js` 互換を守る。 |
| **D85** | **検証コマンドの抽象化（リポジトリ固有メモリ委譲）**: `specs.js`（`MODE_CONTRACTS`）・`pipeline-optimizer.js`（`A2B_RULES`）・`pipeline-watcher.js`（`buildNextSteps`）から `npm run verify` / `npm run deploy` / `390×844` の決め打ちを外し、対象リポジトリ固有のルール・メモリ・SPEC Verify 欄へ委ねる契約へ一般化する。 |

---

## 3. カンバンタスク分割（残存 Batch `COH-1` 〜 `COH-5`）

### Batch COH-1: Frontend イベント・ストレージ契約の完全集約と App.jsx 脆弱リレー解消

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: Frontend の全 25 種 `hm:*` イベントと全 21+1 種 `hm.*` ストレージキーを契約モジュールへ集約し、重複生文字列と `App.jsx` の `setTimeout` タブ間イベントリレーを解消する。
- **変更・新規ファイル**:
  - 新規: `apps/web/src/contracts/events.js`, `apps/web/test/contracts.test.js`
  - 変更: `apps/web/src/contracts/storage.js`（既存 `COHERENCE_DISMISSED` に加え全 21 既存キーを集約）, `apps/web/src/App.jsx`, `apps/web/src/main.jsx`, `apps/web/src/features/{ChatPane,TasksPane,ReviewPane,MemosPane,SettingsPane,TermPane,LiveSheet,TaskToolSheets}.jsx`, `apps/web/src/components/{ArchitectJobBar,MissionReceiptSheet,FxLayer}.jsx`, `apps/web/src/lib/*.js`, `apps/web/src/i18n/{index,lang}.js`, `apps/web/src/demo/{DemoStage,DemoBanner,frame}.js`
- **実装要点**:
  - `HM_EVENTS`（全 25 定数＋`HM_EVENT_META`＋`emitHmEvent(name, detail)`）を新設し、`lib/vibe.js` の `VIBE_EVENT`/`FX_EVENT` と `lib/snippetBars.js` の `SNIPPET_BARS_EVENT` は再エクスポートで後方互換を維持する。
  - `HM_STORAGE` へ既存 21 キー（`hm.board`, `hm.storedSid`, `hm.lang`, `hm.vibe`, `hm.sound`, `hm.theme`, `hm.reviewSeenAt`, `hm.chatReportSeen`, `hm.chatReportSeenAt`, `hm.session.seen.v1` 等）＋ `COHERENCE_DISMISSED` を集約し、各 `lib/*.js`・`i18n/lang.js` の既存定数名エクスポートは再エクスポートへ切り替える。
  - `apps/web/src/**`（`contracts/`・`test/` 除く）から生 `'hm:*'` / `'hm.*'` リテラルをすべて定数参照へ置換する。
  - `App.jsx` の `SearchSheet.onOpenSession` は `setTimeout` を廃して `setPendingChatOpen` 渡しへ、`hm:open-inbox` の `setTimeout`（`jumpToWaiting` / deepLink）は `pendingInboxOpen` prop 渡し（`TasksPane` で消費）へ統合する。
- **受入条件（Verify）**:
  - `contracts.test.js` が一意性・既存再エクスポート互換・`pendingInboxOpen` リレーを検証してパスすること。
  - `apps/web/src`（`contracts/`・`test/` 除く）に生 `'hm:*'` / `'hm.*'` リテラルが 0 件であること。
  - `npm run verify` が全件パスすること。

---

### Batch COH-2: Backend API 契約レジストリ・Demo パリティ修復・検証契約の抽象化（D85）

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: `/api/*` 契約レジストリ新設と Demo Mock 欠損修復に加え、プラグイン本体に残る `npm run verify` / `npm run deploy` 決め打ちを撤廃し対象リポジトリ固有の検証へ委譲する（D85）。
- **変更・新規ファイル**:
  - 新規: `apps/bridge/src/contracts/routes.js`, `apps/bridge/test/routeContracts.test.js`
  - 変更: `apps/web/src/demo/mockApi.js`, `apps/bridge/src/specs.js`, `apps/bridge/src/pipeline-optimizer.js`, `apps/bridge/src/pipeline-watcher.js`, `apps/bridge/test/{specs,pipelineOptimizer,pipelineWatcher}.test.js`, `demo/index.html`（同期）
- **実装要点**:
  - `routes.js` に全現行 `/api/*` ルート一覧 `API_ROUTES`（`{ method, pattern, demo: 'mocked' | 'bridge-only' | 'deprecated', deprecatedBy? }`）と `normalizeApiPath` / `matchApiRoute` を実装する（`/api/coherence/report` は `'mocked'`、`/api/review/from-image` は `'deprecated'`、ログ/認証系のみ `'bridge-only'`）。
  - `mockApi.js` に `GET /api/discord/session`（`{ ok: true, found: false, demo: true }`）と `POST /api/gateway/{pause,resume}` 状態保持（`demoOps` / `/api/overview` / `/api/tasks` 連動）を追加する。
  - `specs.js`（`MODE_CONTRACTS` L145–160）、`pipeline-optimizer.js`（`A2B_RULES` L65）、`pipeline-watcher.js`（`buildNextSteps` L217–218）の `npm run verify` / `npm run deploy` / `390×844` 直書きを、対象リポジトリ固有のメモリ・ルール・SPEC Verify 欄へ委ねる抽象検証契約へ改め、`specs.test.js`（L519–532, L784）・`pipelineOptimizer.test.js`（L396）・`pipelineWatcher.test.js`（L519）の期待値を更新する。
- **受入条件（Verify）**:
  - `routeContracts.test.js`（Web 54+ ルートと `API_ROUTES` / `server.js` / `mockApi.js` の一致確認）と更新済み 3 テストが全件パスすること。
  - `npm run verify`・`npm run deploy`・`npm run build:demo` ＋ `demo/index.html` 同期がすべて exit 0 であること。

---

### Batch COH-3: 本リポジトリ Layer 2 チェッカー check-coherence 実装と npm run verify 統合

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: `hermes-mobile-pwa` 固有の横断契約・パリティを機械検証する `scripts/check-coherence.mjs` を実装し、`.hermes-coherence.json` と `npm run verify` の両方へ統合する。
- **変更・新規ファイル**:
  - 新規: `scripts/check-coherence.mjs`, `apps/bridge/test/coherence.test.js`（Layer 2 統合テスト追記）
  - 変更: `.hermes-coherence.json`（`"checker": "scripts/check-coherence.mjs"` 追加）, `scripts/coherence-baseline.json`（最新行数調整が必要な場合のみ切り下げ・確認）, `package.json`
- **実装要点**:
  - `scripts/check-coherence.mjs`（英語単一言語出力、`--json` / `--strict` / `--update-baseline` / `--allow-grow` 対応）を実装し、`--json` 時に `{ ok, hardFails, softSignals }` を返して `coherence.js` の Layer 2 ローダから無改造で統合できるようにする。
  - **Hard Fail 5 ルール**: (1) `api-parity`（Web `/api/*` ↔ `API_ROUTES` ↔ `server.js` ↔ `mockApi.js` 一致、`deprecated` 呼出ゼロ）、(2) `event-contract`（`contracts/events.js` 外 `'hm:*'` 生文字・片側孤立・`setTimeout` 内 `hm:open-*` ゼロ）、(3) `storage-contract`（`contracts/storage.js` 外 `'hm.*'` 生文字ゼロ）、(4) `docs-scripts-parity`（`en.json` ↔ `ja.json` キー一致＋`README*.md`, `docs/{PITFALLS,OPERATIONS}.md` 内 `npm run <name>` の実在一致）、(5) `legacy-reentry`（`optimizeAntigravitySkills` 等の許可外再流入禁止）。
  - **Soft Signal**: `coherence-baseline.json` との厳密ラチェット比較（`--update-baseline` は縮小時のみ切り下げ、拡大は `--allow-grow` 必須）と `akapen` 残存数通知。
  - `package.json` に `"check:coherence": "node scripts/check-coherence.mjs"` を追加し、`verify` 末尾へ `&& npm run check:coherence` を連結する。
- **受入条件（Verify）**:
  - `coherence.test.js` で `analyzeCoherence(ROOT)` の `layers.repoChecker === true` かつ `ok === true`、および全 Hard Fail 検出ケースがパスすること。
  - `npm run check:coherence` と `npm run verify` が exit 0 で完了し、標準出力・コードに CJK が含まれないこと。

---

### Batch COH-4: 完了済み歴史 SPEC のアーカイブマークと SPEC スプロール解消

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: 完了済みの過去 `docs/SPEC-*.md` へ `- **Status**: archived` を付記し、Launchpad の既定表示をアクティブ SPEC 中心に整理するとともに `coherence.js` の `spec-sprawl` 警告を解消する。
- **変更・新規ファイル**:
  - 変更: 完了済み歴史 `docs/SPEC-*.md` 群（`SPEC-PILOT-V2`〜`V11`, `SPEC-PUBLIC-PLUGIN`, `SPEC-CATALOG-ADMISSION`, `SPEC-ver-0-2-1`, `SPEC-SHARE280`, `SPEC-REPO-PICKER`, `SPEC-PROFILE-CHAT`, `SPEC-i18n-gen`, `SPEC-i18n-resp`, `SPEC-UI-POLISH-V22`, `SPEC-ROLE-DELEGATION-ROUTING`, `SPEC-EN-ZERO-LEAK`, `SPEC-enter-enter-discuss-next-ste`）、`apps/bridge/test/specs.test.js`（必要ならアーカイブ件数検証追記）
- **実装要点**:
  - 各完了済み SPEC のファイルパス自体は移動せず（ドキュメントリンクおよび `specs.test.js` のパス互換を 100% 維持）、先頭 40 行以内のメタデータ部に `- **Status**: archived` を付記する（既存の `- **状態**:` 行があっても `coherence.js` / `specs.js` の `ARCHIVED_RE` が `Status: archived` を優先・併記認識するため安全）。
  - `SPEC-COHERENCE.md` 自体は全バッチ完了までアクティブ（`archived: false`）のまま残し、アクティブ SPEC 数 `<= 6`（`specSprawlLimit` 以下）に収まることを確認する。
- **受入条件（Verify）**:
  - `listSpecs('.').filter((s) => !s.archived)` の件数が `<= 6` になり、`coherence.js` の `spec-sprawl` シグナルが消えること。
  - `apps/bridge/test/specs.test.js`（過去 SPEC ファイル参照テスト含む）および `npm run verify` が全件パスすること。

---

### Batch COH-5: パイプライン完走フックでの汎用予兆検知と統合レポート連携（D55 準拠）

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: パイプライン完走時に `coherence.js` の汎用予兆検知を読み取り専用で実行（D55 準拠）し、完了レポートと次の一手提案へ統合する。
- **変更・新規ファイル**:
  - 変更: `apps/bridge/src/pipeline-watcher.js`, `apps/bridge/test/pipelineWatcher.test.js`, `apps/web/src/demo/mockApi.js`
- **実装要点**:
  - `createPipelineWatcher` のオプションに `coherenceAnalyzer`（既定 `analyzeCoherence`）と `coherenceThresholds` を追加する（未指定時は実ディレクトリが存在する `workdir` に対してのみ実行）。
  - `tick()` でパイプライン収束・統合レポート生成を行う瞬間だけ `coherenceAlertFrom(await analyzer(workdir, thresholds))` を安全実行する（10 秒定期ポーリングごとには走らせず、失敗時は `log.warn` のみでレポート生成を止めない）。
  - `alert === true` 時のみ、出力レポート行へ `coherence_alert: { summary, recommendedSweep, highlights, layers }` を付与し、`buildNextSteps`（EN / JA 両方）へ対象スイープを促す汎用表現の 1 行を差し込む（`npm run` 決め打ち禁止・自動カンバン起票禁止）。
  - `mockApi.js` のデモ用完走レポート（`DEMO_PIPELINE_REPORTS` 等）にもサンプル `coherence_alert` 形状を整える。
- **受入条件（Verify）**:
  - `pipelineWatcher.test.js` で閾値超過時の `coherence_alert` 付与・EN/JA 両文面生成・未超過/解析失敗時の非干渉（レポート正常配信）がすべてパスすること。
  - `npm run verify`・`npm run deploy`・`npm run build:demo` ＋ `demo/index.html` 同期がすべて exit 0 であること。
