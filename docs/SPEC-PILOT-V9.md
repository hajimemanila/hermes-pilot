# SPEC-PILOT-V9: Hermes Pilot V9 — A2B パイプライン完成度向上（Agy Opt-in 重複起票防止・Architect ライブ監視導線・ボード横断 Review 同期・旧 Cron 整理）仕様書

- **Status**: archived
- **アーカイブ日**: 2026-11-21（COH-4・全バッチ完了済み。以後は参照用に保持し、新規起票の対象外）

- **状態**: 仕様確定（2026-11-15 A2B Pipeline 精査 D41〜D44）
- **前提**: `docs/SPEC-PILOT-V8.md`（commit `8ed0172`）まで実装済みであること
- **対象リポジトリ**: `hermes-mobile-pwa`（Bridge / Web PWA / Migration Script / Interactive Demo）
- **完了条件（全バッチ共通）**:
  - 既存テスト（`apps/bridge/test/*.test.js`・`apps/web/test/*.test.js`）が全件パスし、追加仕様に対する単体・統合テストが追加されていること
  - `noHardcodedJapanese.test.js` / `i18nLeak.test.js` / `i18n.test.js` / `scripts/check-oauth-boundary.mjs` / `scripts/audit-responsive.mjs` に違反しないこと
  - Interactive Demo（`apps/web/src/demo/`）および `npm run build:demo` の整合性が保たれていること

---

## 1. A2B Pipeline 完成度の観点での評価と設計方針

V8 完了後の実機検証（`Agy Opt-in` で `spec-chat-jump-pos` を策定、および `audit.jsonl` の稼働ログ分析）を踏まえ、Architect→Builder（A2B）パイプラインの完成度を引き上げるため以下 4 点を設計方針として採用する。

1. **Agy Opt-in のランナー責務分離とカンバン重複起動の防止（D41）**:
   - **課題**: 現行の `apps/bridge/src/architect.js` は、`antigravity`（`agy` CLI）の終了時（非 0 終了、および macOS 版 `agy` ランチャー特有の「GUI へ渡して成果物生成前に即 `exit 0`」）で自動的に `fallbackToKanban()` を呼び出し、同一ジョブ内で `[ARCH]` カンバンタスクを起票して Hermes Agent を起動する設計になっている。その結果、ユーザーが見ている画面裏では GUI 側の Antigravity とカンバン側の Hermes Agent が**二重稼働する懸念**があり、どちらが主導して `review/sheets/` や `docs/SPEC-*.md` を書いているか追跡できなくなっていた。
   - **評価・方針**: A2B パイプラインの責務境界を明確にするため、**Agy Opt-in 選択時は自動カンバンフォールバック（`fallbackToKanban` の自動発火）を廃止**し、Agy Opt-in で `[ARCH]` カンバンタスクを生成しない。`agy` が `exit 0` なら `runner: 'antigravity'`・`mode: 'cli'` のまま `status: 'awaiting_spec'` へ移行して成果物（Round 1 シート / `[review]` タスク / `docs/SPEC-*.md`）の到着を監視し、非 0 終了時は明確に `status: 'failed'` として理由を残す。Hermes Native への切替は、失敗時や 3 分以上停滞時に UI の **「🔄 Hermes Native で再試行」** ボタンからユーザーの明示操作でのみ起動する。

2. **ボード横断 `[review]` 検知・中間シート検知・全画面横断のアクティブ表示（D42）**:
   - **課題**: `skills/spec-architect/SKILL.md`（L61）および `apps/bridge/src/review.js` の仕様上、Quick Review（`[review]`）タスクは既定で `mobile` ボードへ起票される。一方、種まき（`seed`）は `hermes-pilot` 等リポジトリ固有ボードで起票されることが多いが、現行 `architect.js` の `hasArtifacts(job)` と `jobsFor()` は `tasksOf(job.board)` のみを走査しているため、`hermes-pilot` ボードで策定したジョブが `mobile` ボードに届いた `[review]` タスクを一切検知できなかった。また、`GET /api/architect/jobs?board=...` が表示中のボード・リポジトリと完全一致するジョブしか返さないため、別ボードやリポジトリ未選択のチャットを開くと進行バーが消えていた。
   - **方針**:
     1. `hasArtifacts(job)` と `jobsFor()` で走査するレビュー元ボードを `[job.board, 'mobile']`（重複除去）に拡張し、どのボードから種を撒いても `mobile` ボードの `[review]` を確実に `awaiting_review` として紐づける。
     2. `reviewDir/sheets/`（または指定ディレクトリ）配下の `spec-*.json`（`mtime >= job.startedAt - SPEC_MTIME_SLACK_MS`）を検出し、Round 1 の中間進捗を観測可能にする。
     3. ジョブの現在フェーズ `phase`（`spawning` / `round1_sheet` / `awaiting_review` / `round2_spec` / `spec_ready` / `launched` / `failed`）および停滞フラグ `stalled`（180 秒以上 review/spec 待ちのまま無進展）を `publicJob()` で返す。
     4. `jobsFor(query)` は `strictBoard: true` が明示されない限り、未破棄のアクティブジョブ（`running` / `awaiting_spec` / `awaiting_review` / `failed`）は選択中ボードを問わず返却し、`TasksPane` / `ChatPane` どちらからでも途中経過を常時追えるようにする。

3. **カンバン非依存の稼働中 Architect ジョブ確認導線（D43）**:
   - **課題**: Agy Opt-in では `[ARCH]` カンバンタスクを作らないため、Hermes Pilot 全体の「いま何が動いているか」を示す上部コックピットの `⚡ 実行中` ピルや `LiveSheet` に Architect ジョブが一切現れず、死活監視ができなかった。
   - **方針**:
     1. `GET /api/live`（`apps/bridge/src/live.js`・`apps/bridge/src/server.js`）に `architect` 配列および `counts.architect` を追加し、稼働中の Architect ジョブ（`antigravity` / `hermes` 両方）を統合返却する。
     2. `apps/web/src/lib/telemetry.js` の `runningTotal({ tasksRunning, turns, architectRunning })` と `App.jsx`・`TasksPane.jsx` でアクティブ Architect 件数を合算し、`agy` 実行中もコックピットの `⚡ 実行中` ピルが点灯するようにする。
     3. `LiveSheet.jsx` に **Architect ジョブ** セクションを追加し、ランナー名・フェーズ・経過時間・停滞警告・1 タップ操作（Review を開く / タスク詳細を開く / ジョブを閉じる）を提供する。
     4. `ArchitectJobBar.jsx` に現在フェーズ表示・3 分停滞警告＋**「🔄 Hermes Native で再試行」**導線・**「🔍 進捗詳細」**ボタン（`taskId` がある Hermes Native はタスク詳細 / WorkerFeed、タスク無しまたは Agy Opt-in は `LiveSheet` を開く）を実装する。

4. **旧 `mobile-akapen-watch` 外部 cron の自動クリーンアップ（D44）**:
   - **課題**: Hermes Pilot 本体の `reviewWatcher` と `pipelineWatcher` により全通知・レポート処理が完結しているが、プラグイン移行前の旧外部 cron `mobile-akapen-watch` がローカル環境（`~/.hermes/`）に残存して Discord へ重複通知するケースがある。
   - **方針**: `scripts/migrate-to-hermes-pilot.mjs` に `~/.hermes/cron/`（JSON/SQLite 等、存在するストア形式を安全に検出）から旧 `mobile-akapen-watch` / `mobile-review-watch` エントリを検出・無効化/削除する冪等クリーンアップ処理を追加し、`apps/bridge/test/migrate.test.js` で検証する。

---

## 2. 合意決定表（D41〜D44）

| ID | 論点 | 採用方針 |
| :--- | :--- | :--- |
| **D41** | Agy Opt-in 時の重複起動防止 | `runner === 'antigravity'` の終了時（`code === 0` の空振り・非 0 終了とも）における自動 `fallbackToKanban()` を廃止し、Agy Opt-in では `[ARCH]` カンバンタスクを生成しない。`exit 0` は `awaiting_spec`（`mode: 'cli'`・`runner: 'antigravity'`）で成果物を待機し、非 0 終了は `failed` として理由を表示する。Hermes Native 切替は UI ボタンからの明示操作に一本化する。 |
| **D42** | ボード横断 Review 検知とフェーズ・停滞算出 | `findJobReviewTask` 走査対象を `[job.board, 'mobile']` に広げ、他ボード起点の種まきでも `mobile` ボード上の `[review]` を検知する。`review/sheets/spec-*.json` の新規生成検知と `phase`（`spawning`〜`failed`）・`stalled`（3 分超）を算出し、`jobsFor()` はアクティブジョブ（`running` / `awaiting_spec` / `awaiting_review` / `failed`）をボード横断で返す（`strictBoard: true` で従来互換絞り込み可）。 |
| **D43** | カンバンを作らない Architect ジョブの全体監視導線 | `/api/live` に `architect` ジョブ一覧と `counts.architect` を載せ、コックピット `⚡ 実行中` ピル（`runningTotal`）・`LiveSheet`・`ArchitectJobBar` のすべてから監視可能にする。`ArchitectJobBar` にフェーズ表示・停滞警告・明示の「🔄 Hermes Native で再試行」・1 タップ「🔍 進捗詳細」（`LiveSheet` またはタスク詳細起動）を追加する。 |
| **D44** | 旧 `mobile-akapen-watch` 外部 cron の整理 | `scripts/migrate-to-hermes-pilot.mjs` に旧 `mobile-akapen-watch` / `mobile-review-watch` cron の検出・削除（または無効化）ステップを追加し、環境に残った重複 Discord 通知を自動解消できるようにする。 |

---

## 3. 詳細技術仕様

### 3.1 Agy Opt-in 重複起票防止とボード横断・フェーズ検知（`apps/bridge/src/architect.js`）

1. **自動フォールバック廃止（D41）**:
   - `seed()` 内のランナー終了ハンドラから `antigravity` に対する `fallbackToKanban(job, ...)` 呼び出しを削除する:
     - `code !== 0`: `job.status = 'failed'`, `job.error = reason.slice(0, 600)`（ランナー種別 `antigravity` を問わず統一）。
     - `code === 0` かつ `runnerId === 'antigravity'`: `hasArtifacts(job)` が `true` なら SPEC/Review 状態へ進め、`false` の場合もカンバン起票は行わず `job.status = 'awaiting_spec'` として `runner: 'antigravity'`・`mode: 'cli'` を維持する（GUI/エージェント側が非同期でファイルを書き終えるのを待機）。
   - `buildSeedPrompt` 等の既存契約は維持し、`architect.test.js` の旧「自動フォールバックする」テストケースは D41 契約（「自動フォールバックせず `awaiting_spec` / `failed` に留まり `[ARCH]` を重複起票しない」）へ更新する。

2. **ボード横断 Review 検知と中間シート・フェーズ・停滞算出（D42）**:
   - `STALLED_AFTER_MS = 180_000`（3 分）および `ARCHITECT_PHASES`（`spawning`, `round1_sheet`, `awaiting_review`, `round2_spec`, `spec_ready`, `launched`, `failed`）を定義・エクスポートする。
   - ヘルパー `reviewBoardsFor(jobBoard)`: `[jobBoard, 'mobile']` を重複除去して返す（空文字は除外）。
   - `hasArtifacts(job)`: `specsOf`（または `listSpecsFn`）に加えて、`reviewBoardsFor(job.board)` の全ボードに対して `findJobReviewTask(job, readTasks(b))` をチェックする。さらに `listRecentSheets(reviewDir, sinceMs)` で `spec-*.json` が新しく書かれていれば `true` とする。
   - `findRecentSheet(reviewDir, job)`: `path.join(reviewDir, 'sheets')` 内の `spec-*.json` のうち `mtimeMs >= job.startedAt - SPEC_MTIME_SLACK_MS` の最新ファイル名（例: `sheets/spec-xxx-1.json`）を返す純関数・IO ヘルパーを用意する（`reviewDir` 未指定時は安全に `null`）。
   - `computePhase(job)`:
     - `'failed'` → `'failed'`
     - `'launched'` → `'launched'`
     - `'spec_ready'` → `'spec_ready'`
     - `'awaiting_review'` → `'awaiting_review'`
     - `job.reviewSeenOnce`（一度でも `awaiting_review` を通過して回答完了後 `awaiting_spec` へ戻った） → `'round2_spec'`
     - `job.sheetPath` 検知済み → `'round1_sheet'`
     - それ以外の `running` / `awaiting_spec` → `'spawning'`
   - `isJobStalled(job, at)`:
     - `['running', 'awaiting_spec'].includes(job.status)` かつ `job.queueState !== 'queued'` のとき、経過時間 `at - (job.startedAt ?? job.createdAt)` が `STALLED_AFTER_MS`（180,000ms）以上なら `true`（`done` / `archived` / `awaiting_review` / `spec_ready` / `launched` / `failed` は常に `false`）。
   - `jobsFor(query = {})`:
     - デフォルトでは `ACTIVE_JOB_STATUSES`（`['running', 'awaiting_spec', 'awaiting_review', 'failed']`）に該当し未破棄のジョブは他ボード・他リポジトリでも `mine` に含める（`query.strictBoard === true` の場合のみ従来の厳密一致 `job.board === board` に限定）。
     - 各ジョブで `reviewBoardsFor(job.board)` 全ボードから `findJobReviewTask(job, tasks)` を検索する。見つかった場合 `job.reviewBoard` にそのボード名、見つかって `awaiting_review` に入ったら `job.reviewSeenOnce = true` を記録する。
     - `publicJob(job)` に `phase`, `stalled`, `sheetPath`, `reviewBoard` を含める（機密フィールド `repoPath` 等は引き続き除外）。

### 3.2 コックピット `⚡ 実行中` と `LiveSheet` への Architect 統合（Bridge + Web）

1. **Bridge `/api/live` 拡張（`apps/bridge/src/live.js`・`apps/bridge/src/server.js`）**:
   - `createLive(cfg, kanban, deps = {})`:
     - `deps.architectJobs`（任意関数、未指定時は空配列）を受け取る。
     - `snapshot(opts = {})` で `await` または同期でアクティブ Architect ジョブを取得できるよう配慮（同期/非同期互換のため、既存の同期呼び出しテストを壊さないよう `opts.architectJobs` でスナップショット配列を受け取れる形にしつつ、`server.js` の `/api/live` ハンドラ側で `await architect.jobs({ strictBoard: false })` から `live.snapshot({ dbs, architect: snapshot.jobs })` へ渡す設計にするのが安全・簡潔）。
     - `live.snapshot({ dbs, architect })` は `architect` 引数のうち稼働中（`['running', 'awaiting_spec', 'awaiting_review'].includes(j.status)` で未破棄のもの、または `running` / `awaiting_spec` のもの。注: `awaiting_review` は判断待ちピル 🔔 に出るので、`counts.architect`（稼働中件数）は `running` / `awaiting_spec` のみ数えつつ、`out.architect` 一覧には `awaiting_review` も含めて `LiveSheet` で見られるようにする）を `{ id, board, runner, runnerLabel, status, phase, stalled, taskId, reviewTaskId, reviewBoard, seed, startedAt, elapsedSec }` に整形し、`out.architect` と `out.counts.architect` を返す。

2. **Web コックピット・タブドット更新（`apps/web/src/lib/telemetry.js`・`apps/web/src/App.jsx`・`apps/web/src/features/TasksPane.jsx`）**:
   - `apps/web/src/lib/telemetry.js`:
     - `runningTotal({ tasksRunning = 0, turns = 0, architectRunning = 0 } = {})`: 3 つの非負数の合計を返す（既存 2 引数呼び出しも完全互換）。
   - `apps/web/src/App.jsx`:
     - `/api/live` 同期時に `d?.counts?.architect ?? 0` を `liveArchitect` state へ保持し、`hm:live-turns` イベントでも同期する。
     - `const running = runningTotal({ tasksRunning: overview?.runningTasks, turns: liveTurns, architectRunning: liveArchitect })` に更新。
     - ナビタブのタスクタブ進行中ドット判定（L889）でも `liveArchitect` を加算する。
     - `App.jsx` に `hm:open-live` カスタムイベントリスナーを追加し、任意の画面（`ChatPane` や `ArchitectJobBar`）から 1 タップで全体の `LiveSheet` を開けるようにする（あわせて `LiveSheet` から `hm:open-task` イベント等で特定ボードのタスク詳細へ遷移できるようにする）。

3. **`LiveSheet` に Architect ジョブ欄を追加（`apps/web/src/features/LiveSheet.jsx`）**:
   - 上部サマリ `.strip` を `turns` / `tasks` / `architect` の 3 列（または `architect.length > 0` のとき表示）に拡張し、`turns` / `tasks` の下に「**Architect（仕様策定）**」セクションを配置する。
   - 各 Architect ジョブ行に、ステータスドット・種要約・`runnerLabel` ・ `board` ・ `phase` ラベル・`fmtElapsed(job.elapsedSec)`・停滞警告バッジ（`stalled` の場合）・以下の 1 タップ操作を出す:
     - `awaiting_review` のとき: 「🔍 Quick Review」ボタン（`hm:open-review` 発火してシートを閉じる）
     - `taskId` があるとき: 「📋 タスク」ボタン（該当ボードのタスク詳細を開く）
     - 閉じる / 中断ボタン: 「✕ 終了」（`POST /api/architect/jobs/:id/dismiss` を叩いて再取得）

### 3.3 `ArchitectJobBar` 強化と Tasks/Chat 導線統一

1. **純粋ロジック拡張（`apps/web/src/lib/specSeed.js`）**:
   - `jobPhaseKey(job)`: `job.phase` を i18n キーへ写像する（`spawning` → `seed.phaseSpawning`, `round1_sheet` → `seed.phaseRound1Sheet`, `awaiting_review` → `seed.statusAwaitingReview`, `round2_spec` → `seed.phaseRound2Spec`, `spec_ready` → `seed.statusReady`, `launched` → `seed.statusLaunched`, `failed` → `seed.statusFailed`）。
   - `shouldOfferHermesRetry(job)`: `job?.status === 'failed'` または `(job?.runner === 'antigravity' && Boolean(job?.stalled))` のとき `true`。
   - `pickActiveArchitectJob(jobs, dismissedIds, preferredBoard)`: `preferredBoard` と一致するジョブがあれば優先しつつ、別ボードのアクティブジョブもフォールバック表示対象として拾えるようにする（既存の 2 引数呼び出し互換）。

2. **`ArchitectJobBar.jsx` UI 強化（`apps/web/src/components/ArchitectJobBar.jsx`）**:
   - 進行中（`ticking`）のサブ行に現在フェーズ（`t(jobPhaseKey(job))`）および `job.sheetPath`（検知済みの場合はファイル名）を表示する。
   - `job.stalled` が `true` のとき、バーを警告トーン（`stalled` クラス）にし、「⚠️ 3分以上進捗がありません（Agent が停止・待機中の可能性）」と明示する。
   - `onInspect`（またはデフォルトで `job.taskId` ありなら `hm:open-task`、無しなら `hm:open-live` 発火）を呼ぶ **「🔍 進捗詳細」** アクションボタンを追加する。
   - `shouldOfferHermesRetry(job)` が `true` のとき（失敗時、および Agy Opt-in が 3 分以上停滞したとき）、**「🔄 Hermes Native で再試行」** ボタンを表示する（自動切替ではなく、押下時に既存ジョブを閉じつつ Hermes Native で新規 `seed` を呼ぶ）。

3. **`TasksPane.jsx`・`ChatPane.jsx`・`i18n`・`demo/mockApi.js`**:
   - `ChatPane.jsx`: `/api/architect/jobs` 呼び出し時、`seedBoard` が空でも必ず取得し、アクティブな Architect ジョブが他ボードで動いている場合も `ArchitectJobBar` を描画する（再試行時のボードも `board || job.board` を渡す）。
   - `TasksPane.jsx`: `hm:open-task` イベントまたは `ArchitectJobBar` の `onInspect` を受け取り、`job.taskId` が同ボード（または他ボード切り替え経由）に存在する場合は即座に `detail` シートを開き、Agy Opt-in 等で `taskId` が無い場合は `setLiveOpen(true)` で `LiveSheet` を開く。また上部 `running` カウント計算に `liveArchitect` を含める。
   - `ja.json` / `en.json`: D41〜D43 で増えるすべてのキー（フェーズ文言・停滞警告・進捗詳細ボタン・LiveSheet Architect 見出し等）を日英両方で定義する。
   - `apps/web/src/demo/mockApi.js`: `/api/live` モックに `architect` 配列・`counts.architect` を追加し、Architect ジョブの `phase` / `stalled` デモ動作を同期する。

### 3.4 旧 `mobile-akapen-watch` 外部 cron の自動クリーンアップ（`scripts/migrate-to-hermes-pilot.mjs`）

1. **`cleanupLegacyCrons(hermesHome)` ヘルパーの追加**:
   - `~/.hermes/cron/jobs.json`（`{ jobs: [...], updated_at }` オブジェクト形式・配列形式の両方、および存在する場合の互換パス `~/.hermes/cron.json`）を安全に走査し、`name`・`id`・`script`・`prompt`・`label` 等に `mobile-akapen-watch` または `mobile-review-watch` を含むエントリを検出する（対象ファイルが存在しない環境では無害に空結果を返す）。
   - `dryRun: false` のとき該当エントリを `jobs` から除外し、`updated_at` 等トップレベル構造を保ったまま原子的リネーム書き込みで保存して、削除対象件数と削除したジョブ名リストを返す。
2. **CLI 実行結果レポートへの組み込みと単体テスト**:
   - `scripts/migrate-to-hermes-pilot.mjs` のメイン移行処理から `cleanupLegacyCrons` を呼び出し、移行完了サマリに削除した旧 cron 件数を表示する。
   - `apps/bridge/test/migrate.test.js` に、`jobs.json` 内の `mobile-akapen-watch` が削除され他 cron が保持されること・ファイル不在でもエラーにならないことのテストを追加する。

---

## 4. 実装バッチ構成（Spec Launchpad 用）

### Batch V9-B1: Agy Opt-in 重複起票防止（自動カンバンフォールバック廃止）とボード横断 Review・フェーズ検知
- **Execution Mode**: [Mode: Zero-Stop]
- **目的**: Agy Opt-in 実行時に自動で `[ARCH]` カンバンタスクが起票されて Hermes Agent と二重稼働する問題（D41）を根絶し、あわせて `mobile` ボード上の `[review]` 横断検知・中間シート検知・`phase` / `stalled` 算出・アクティブジョブのボード横断返却（D42）をブリッジ層に実装する。
- **変更・新規ファイル**:
  - `apps/bridge/src/architect.js`
  - `apps/bridge/src/server.js`
  - `apps/bridge/test/architect.test.js`
- **実装詳細**:
  - `apps/bridge/src/architect.js` の `seed()` 終了ハンドラから `antigravity` 向け自動 `fallbackToKanban()` 呼び出しを削除し、`exit 0` は `awaiting_spec`（`runner: 'antigravity'`, `mode: 'cli'`）、非 0 終了は `failed` に遷移させる。
  - `reviewBoardsFor(job.board)`（`[job.board, 'mobile']`）を `hasArtifacts` と `jobsFor` に導入し、別ボードで撒かれた種でも `mobile` ボードの `[review]` を `awaiting_review` として紐づける（`reviewBoard` を記録）。
  - `findRecentSheet(reviewDir, job)`、`computePhase(job)`（`spawning`〜`failed`）、`isJobStalled(job, at)`（`STALLED_AFTER_MS = 180_000`）を実装し、`publicJob` に `phase`, `stalled`, `sheetPath`, `reviewBoard` を返す。
  - `jobsFor(query)` でデフォルトはアクティブ非破棄ジョブをボード横断で返すようにする（`strictBoard: true` 時のみ厳密一致）。
  - `apps/bridge/test/architect.test.js` を D41・D42 契約に合わせて更新・拡充する（Agy 非フォールバック・`mobile` ボード横断 review 検知・`phase` 遷移・3 分停滞判定）。
- **受入条件（Verify）**:
  - `node --test apps/bridge/test/architect.test.js` が全件パスすること
  - `npm test` および `npm run check:oauth` が全件パスすること

### Batch V9-B2: コックピット「⚡ 実行中」・LiveSheet への Architect ジョブ統合
- **Execution Mode**: [Mode: Zero-Stop]
- **目的**: カンバンタスクを持たない Agy Opt-in ジョブも含めて、現在進行中の Architect ジョブを上部コックピット `⚡ 実行中` ピルおよび `LiveSheet` から常時監視・操作できるようにする（D43 前半）。
- **変更・新規ファイル**:
  - `apps/bridge/src/live.js`
  - `apps/bridge/src/server.js`
  - `apps/bridge/test/live.test.js`
  - `apps/web/src/lib/telemetry.js`
  - `apps/web/src/App.jsx`
  - `apps/web/src/features/LiveSheet.jsx`
  - `apps/web/src/i18n/ja.json`
  - `apps/web/src/i18n/en.json`
  - `apps/web/test/telemetry.test.js`
- **実装詳細**:
  - `apps/bridge/src/live.js`: `snapshot({ dbs, architect })` でアクティブ Architect ジョブ一覧（`out.architect`）と実行中カウント（`out.counts.architect`）を返す。
  - `apps/bridge/src/server.js`: `GET /api/live` ハンドラで `await architect.jobs()` を参照し `live.snapshot({ dbs, architect: archSnap.jobs })` へ渡す。
  - `apps/web/src/lib/telemetry.js`: `runningTotal({ tasksRunning, turns, architectRunning })` に `architectRunning` を加算する（`telemetry.test.js` に単体テスト追加）。
  - `apps/web/src/App.jsx`: `/api/live` から `counts.architect` を購読して `runningTotal` とタスクタブ進行中ドットに加算し、`hm:open-live` イベントでも `LiveSheet` を開けるようにする。
  - `apps/web/src/features/LiveSheet.jsx`: Architect ジョブ欄を追加し、ランナー名・種要約・フェーズ・経過時間・停滞警告・1 タップ導線（Quick Review / タスク詳細 / 終了 dismiss）を描画する。
  - `apps/web/src/i18n/ja.json`・`en.json`: `live.architect*` キーを追加する。
- **受入条件（Verify）**:
  - `node --test apps/bridge/test/live.test.js apps/web/test/telemetry.test.js apps/web/test/i18n.test.js apps/web/test/i18nLeak.test.js apps/web/test/noHardcodedJapanese.test.js` が全件パスすること
  - `npm test` が全件パスすること

### Batch V9-B3: ArchitectJobBar のフェーズ可視化・停滞警告・明示ランナー切替と Tasks/Chat 導線統合
- **Execution Mode**: [Mode: Zero-Stop]
- **目的**: `TasksPane` / `ChatPane` のどちらから見ても進行中の Architect ジョブのフェーズ・停滞警告・1 タップ詳細モニター・明示的な「🔄 Hermes Native で再試行」を利用できるようにし、デモ API とも同期する（D43 後半）。
- **変更・新規ファイル**:
  - `apps/web/src/lib/specSeed.js`
  - `apps/web/src/components/ArchitectJobBar.jsx`
  - `apps/web/src/features/TasksPane.jsx`
  - `apps/web/src/features/ChatPane.jsx`
  - `apps/web/src/styles.css`
  - `apps/web/src/i18n/ja.json`
  - `apps/web/src/i18n/en.json`
  - `apps/web/src/demo/mockApi.js`
  - `apps/web/test/specSeed.test.js`
- **実装詳細**:
  - `apps/web/src/lib/specSeed.js`: `jobPhaseKey(job)`・`shouldOfferHermesRetry(job)`・`pickActiveArchitectJob(jobs, dismissedIds, preferredBoard)` を実装し、`specSeed.test.js` に単体テストを追加する。
  - `apps/web/src/components/ArchitectJobBar.jsx`: 現在フェーズ、`sheetPath`、`stalled` 警告表示、1 タップ「🔍 進捗詳細」（`onInspect` または `hm:open-task` / `hm:open-live`）、および `shouldOfferHermesRetry(job)` 時の明示「🔄 Hermes Native で再試行」（既存ジョブを dismiss してから Hermes で seed）を実装する。
  - `apps/web/src/features/TasksPane.jsx` / `ChatPane.jsx`: `ArchitectJobBar` へ `onInspect` を接続し、`taskId` ありならタスク詳細／WorkerFeed、無しなら `LiveSheet` を開けるようにする。`TasksPane` の `running` 統計や `ChatPane` のボード未選択時でもアクティブジョブを確実に表示する。
  - `apps/web/src/demo/mockApi.js`: `/api/live` の `architect` / `counts.architect` および `phase` / `stalled` フィールドを返すよう更新する。
- **受入条件（Verify）**:
  - `node --test apps/web/test/specSeed.test.js apps/web/test/i18n.test.js apps/web/test/i18nLeak.test.js apps/web/test/noHardcodedJapanese.test.js apps/web/test/demoMode.test.js` が全件パスすること
  - `npm test` および `npm run build` が成功すること

### Batch V9-B4: 旧 mobile-akapen-watch Cron 自動クリーンアップと全体統合検証・デモ同期
- **Execution Mode**: [Mode: Zero-Stop]
- **目的**: 移行スクリプトに旧 `mobile-akapen-watch` / `mobile-review-watch` 外部 cron の自動検出・削除機能を追加し（D44）、最後に V9 全変更の統合テスト・PWA チェック・OAuth 境界チェック・ビルド・レスポンシブ監査・デモビルドまで一括検証する。
- **変更・新規ファイル**:
  - `scripts/migrate-to-hermes-pilot.mjs`
  - `apps/bridge/test/migrate.test.js`
- **実装詳細**:
  - `scripts/migrate-to-hermes-pilot.mjs`: `cleanupLegacyCrons(hermesHome, { dryRun })` を実装・エクスポートし、`~/.hermes/cron/jobs.json` 等から `mobile-akapen-watch` / `mobile-review-watch` を安全に除去して他の cron ジョブを保持する。CLI 実行時のレポートに結果を表示する。
  - `apps/bridge/test/migrate.test.js`: `cleanupLegacyCrons` の単体テスト（一致エントリ除去＋他ジョブ保持、対象ファイル不在時の無害通過、dryRun 時非破壊）を追加する。
  - 全自動テストスイート、PWA チェック、OAuth 境界チェック、本番ビルド、レスポンシブ監査、Interactive Demo ビルドを実行して全件パスを確認する。
- **受入条件（Verify）**:
  - `node --test apps/bridge/test/migrate.test.js` が全件パスすること
  - `npm run verify`（`npm test && npm run check:pwa && npm run check:oauth && npm run build && npm run audit:responsive`）が終了コード 0 で完了すること
  - `npm run build:demo` が終了コード 0 で完了すること
