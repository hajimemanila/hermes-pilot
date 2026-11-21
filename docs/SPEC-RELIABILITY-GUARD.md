# SPEC: 信頼性ガード・緊急停止刷新・ゴミ整理・バグハント基盤仕様書 (`SPEC-RELIABILITY-GUARD`)

- **状態**: 仕様確定（2026-11-21・Q&A すり合わせ合意済み。Batch RG-1 〜 RG-5）
- **前提仕様**: [SPEC-COHERENCE.md](./SPEC-COHERENCE.md) / [SPEC-EN-ZERO-LEAK.md](./SPEC-EN-ZERO-LEAK.md) / [SPEC-ROLE-DELEGATION-ROUTING.md](./SPEC-ROLE-DELEGATION-ROUTING.md) / [SPEC-PILOT-V11.md](./SPEC-PILOT-V11.md)
- **対象リポジトリ**: `hermes-mobile-pwa`（プラグイン名: `hermes-pilot` / `Hermes Pilot`）
- **全バッチ共通の完了条件**:
  - `npm run verify`（`check:coherence` 含む）が exit 0 であること
  - 外部 AI CLI のサブプロセス起動禁止（`check:oauth` 通過・Hermes Native 完結）および D55 非干渉原則（Hermes 本体 SQLite / cron DB への直接書き込み禁止・ユーザー承認なき自動タスク起票禁止）を遵守すること
  - `SPEC-EN-ZERO-LEAK` 遵守（CLI / Bridge ログ・エラー `reason` / `scripts/check-coherence.mjs` 出力は英語単一言語、Web UI 追加文言は `en.json` / `ja.json` 同時追加・英語辞書 CJK / 全角記号ゼロ）
  - `themeTokens.test.js` 遵守（JSX inline style およびコンポーネント CSS への色直書き禁止・テーマトークンのみ使用）
  - UI / Demo Mock 変更を伴うバッチ（`RG-1` / `RG-2` / `RG-3` / `RG-4`）では `npm run deploy` および `npm run build:demo` ＋ `demo/index.html` 同期が exit 0 であること、および `Visual Gate` バッチ（`RG-2` / `RG-3` / `RG-4`）では実画面（390px モバイル幅＋デスクトップ幅、ライト／ダーク）を確認すること

---

## 1. 背景と解決する課題

実運用でのリファクタリングおよびトラブルシュートを通じて、既存の 1,100 本超の単体テストをすべて通過しながら発生していた **5 系統の実運用ギャップ** が判明した。これらはいずれも「単体テストがモックで飛ばす境界・状態遷移・運用ループ」に集中している：

1. **SPEC 横断のバッチ ID 重複による完了誤検知の残余穴**：`Spec:` スコープを導入した後も、`apps/web/src/demo/mockApi.js` の未スコープ照合、無印レガシータスクへの時刻無制限フォールバック、`architect.js` における汎用 ID（`C1`, `B1` 等）許容、および複数 SPEC 間の ID 重複検査欠如が残っている。また `archived`（破棄済み）タスクが完了扱い（`allDone`）に含まれ、誤破棄バッチの再起票導線が閉じられる。
2. **緊急操作（Emergency）メニューの責務混線とモバイル長押し脆弱性**：`TasksPane.jsx` の緊急操作シートはカンバン実行中件数を掲げながら、実際の操作が Gateway（`drain` / `restart` / `stop` / `start`）と ESTOP 新規停止（`hermes pause`）のみで、暴走中のカンバンワーカーを一括中断する手段が無い。さらに `ops.js` で失敗詳細を捨て、`server.js` の一部書き込み系ルートが非 OK を返しても HTTP 200 のまま返す箇所があるほか、`HoldButton` にコンテキストメニュー抑止が無くスマホ実機の長押しが途切れやすい。
3. **テスト起票ゴミ・不要 SPEC の整理手段不足**：`archived` タスクが通常タスク一覧に残り続け、不要タスクの一括アーカイブや、不要・テスト用 `docs/SPEC-*.md` を安全にアーカイブ退避する UI 導線が無い。
4. **一般的な不具合・抜け漏れを探索する専用スイープの不在**：`RefactorSheet` には構造整理向けの 5 プリセットはあるが、全ユーザー・全リポジトリ向けに「外部境界・サイレント失敗・契約漏れ・状態デッドエンド・ID 衝突」を系統立てて検査／修正する `bug-hunt` プリセットが無い。
5. **同種不具合の再発防止ガード不足**：CLI 呼出の引数順・パス解決、サイレント失敗、起票ルート間パリティ、状態×操作の到達性、実バイナリ＋稼働中 Bridge への非破壊ライブ検証が自動検査されていない。

---

## 2. 合意決定表（D90〜D95）

| ID | 決定事項 |
| :--- | :--- |
| **D90** | **緊急停止の責務分離と一括停止**: 緊急操作（Emergency）シート最上部に **「全タスク緊急停止（ESTOP＋実行中一括中断）」**（`POST /api/emergency/stop-all`、`confirm: 'STOP_ALL'`）を新設し、見出しで **「カンバン・タスク緊急停止」** と **「Hermes Gateway 操作」** を明確に分離する。`HoldButton` のスマホ長押し途切れ対策（`onContextMenu` 抑止＋`-webkit-touch-callout: none`＋内側 `pointer-events: none`）、`ops.js` のエラー詳細露出、および `server.js` 書き込み系ルートの非 OK 時 HTTP 200 抑止も同時実施する。 |
| **D91** | **バッチ ID 衝突の 4 層防御と無印レガシー照合規約**: ① `architect.js`（`buildArchitectTaskBody` / `buildSeedPrompt`）で `### Batch <SLUG>-1: <Title>` 形式を必須化し、Layer 1（`coherence.js`）に `duplicate-batch-id` ルールを追加する。② 照合優先順を **「`pipeline-runs.json` の `taskIds` → `Spec:` 行一致 → 無印タスク（`taskSpec === null`）は対象 SPEC の `mtime` 以降のタスクのみ許容」** に厳格化する。③ タスク本文の `Spec:` / `Batch:` 固定ヘッダを活用する。④ `mockApi.js` / `telemetry.js` も同一規約に統一する。 |
| **D92** | **`archived` の未完了扱いとゴミ整理 3 点セット**: Launchpad の `allDone`（全バッチ完了）は **全バッチが `done` のときのみ成立** とし、`archived`（破棄・取消済み）は未完了・再起票可能として扱う。併せてゴミ整理 3 点セットを導入する：① タスク一覧は既定で `archived` を非表示にし **「アーカイブ済み (N)」** トグルで開閉、② 複数選択で非実行タスクを一括アーカイブする **「整理モード」**（`POST /api/boards/:board/tasks/bulk-archive`）、③ 不要・テスト SPEC をヘッダ `- **Status**: archived` 追記で退避するボタン（`POST /api/specs/archive`・ファイル削除はしない＝D84 互換）。 |
| **D93** | **リファクタリング画面の汎用 `bug-hunt` プリセット**: `coherenceSweep.js` に 6 つ目の言語非依存プリセット `bug-hunt`（日本語「バグ・不具合ハント」／英語 `Bug & Failure-Mode Hunt`）を追加し、単体テストが見逃す 5 大盲点チェックリストを組み込む。既存の 2 起票ボタン（単発タスク起票／複数バッチ SPEC 作成）は維持し、`bug-hunt` 選択時のみ 1 つのチェックボックス **「再現テストで確認できた不具合まで自動修正する（既定 OFF＝調査レポート専念）」** を表示する。 |
| **D94** | **機械的再発防止ガードと非破壊スモーク**: Layer 2（`scripts/check-coherence.mjs`）へ `cli-invocation-guard`・`silent-failure-guard`・`create-route-parity` の 3 ルールを追加し、状態×操作マトリクステスト（`stateActionMatrix.test.js`）と非破壊ライブスモーク（`scripts/smoke-live.mjs` / `npm run smoke:live`）を整備する。 |
| **D95** | **実行モード基準**: 既定 `[Mode: Zero-Stop]`、UI 変更を含むバッチ（`RG-2` / `RG-3` / `RG-4`）は `[Mode: Visual Gate]` とする。 |

---

## 3. カンバンタスク分割（Batch `RG-1` 〜 `RG-5`）

### Batch RG-1: バッチ ID 衝突根絶の 4 層防御と厳格な進捗照合（D91・D92 前半）

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: SPEC 間のバッチ ID 衝突と無印レガシータスクによる完了誤検知を構造的に根絶し、`archived` タスクを完了扱い（`allDone`）から外して再起票可能にする。
- **変更・新規ファイル**:
  - `apps/bridge/src/architect.js`
  - `apps/bridge/src/coherence.js`
  - `apps/bridge/src/specs.js`
  - `apps/bridge/src/server.js`
  - `apps/bridge/src/telemetry.js`
  - `apps/web/src/lib/specProgress.js`
  - `apps/web/src/features/TasksPane.jsx`
  - `apps/web/src/demo/mockApi.js`
  - `apps/bridge/test/architect.test.js`, `apps/bridge/test/coherence.test.js`, `apps/bridge/test/specs.test.js`, `apps/bridge/test/telemetry.test.js`
  - `apps/web/test/specProgress.test.js`, `apps/web/test/demoMode.test.js`
  - `demo/index.html`（同期）
- **実装要点**:
  - `architect.js`（`buildArchitectTaskBody` / `buildSeedPrompt`）で `### Batch <SLUG>-1: <Title>` のような大文字スラッグ前置 ID を必須化し、既存アクティブ SPEC で使用済みのバッチ ID プレフィックスも渡して衝突を防ぐ。
  - `coherence.js` に Layer 1 汎用ルール `duplicate-batch-id` を追加し、非アーカイブ（アクティブ）な `docs/SPEC-*.md` 間で同じバッチ ID が重複したときシグナルを出す。
  - `specs.js` と `server.js` で `pipeline-runs.json`（`readRuns` / `runsPathFor`）から対象 SPEC に紐づく `taskIds` を集約して `GET /api/specs` 各要素へ `runTaskIds` として添付し、タスク本文の `Batch: <id> — ...` ヘッダを読む補助も整える。
  - `specProgress.js` の `specProgress(batches, tasks, specRelPath, opts = {})`（`opts: { specMtime, runTaskIds }`）を更新する：
    1. 紐づけ優先度を **`runTaskIds` 一致 ＞ `taskSpecOf(task) === wantSpec` ＞ 無印（`taskSpec === null`）** とし、無印タスクは `specMtime != null` のとき `createdAt / startedAt / completedAt` が `specMtime - 猶予（5000ms）` 以降のものだけを許可する（過去の無印 `[C1]` 等が新規 SPEC に誤マッチしない）。
    2. `allDone` は **全バッチのタスク状態が `'done'` のときのみ true**（`'archived'` は完了扱いにしない）。同じバッチ ID に複数タスクがある場合は `done` ＞ 非終了オープン状態 ＞ `archived` の順で `byId` に残す。
  - `specs.js`（`findOpenBatchTask`）と `architect.js`（`filedBatchIdsForSpec`）にも無印タスクの時刻ガードを適用し、`archived` タスクは再起票可能（起動・未起票判定を塞がない）として揃える。
  - `apps/web/src/demo/mockApi.js`（未スコープの `filedBatchIds()` → Spec スコープ済み判定）と `apps/bridge/src/telemetry.js`（`taskSpecOf` / `batchIdOf` の共通規約化）を統一し、`TasksPane.jsx` から `specProgress` へ `specMtime` と `runTaskIds` を渡す。
- **受入条件（Verify）**:
  - `apps/web/test/specProgress.test.js` で「別 SPEC 衝突除外」「無印タスクの時刻ガード」「`runTaskIds` 最優先」「`archived` ≠ `done` 再起票可」の全ケースがパスすること。
  - `apps/bridge/test/coherence.test.js` で `duplicate-batch-id` 検知テスト、および `architect.test.js` / `specs.test.js` / `demoMode.test.js` がパスすること。
  - `npm run verify` および `npm run build:demo` ＋ `demo/index.html` 同期が exit 0 であること。

---

### Batch RG-2: 緊急操作（Emergency）カンバン一括停止・Gateway 分離・HoldButton 強化（D90）

- **Execution Mode**: `[Mode: Visual Gate]`
- **Recommended Role**: `role:builder`
- **目的**: 暴走したカンバンワーカーをスマホ 1 操作で確実に止められる「全タスク緊急停止（ESTOP＋実行中一括中断）」を Emergency メニュー最上部へ新設し、Gateway 操作との責務分離・エラー可視化・長押し途切れ防止を実装する。
- **変更・新規ファイル**:
  - `apps/bridge/src/ops.js`
  - `apps/bridge/src/kanban.js`
  - `apps/bridge/src/server.js`
  - `apps/bridge/src/contracts/routes.js`
  - `apps/web/src/demo/mockApi.js`
  - `apps/web/src/components/Ui.jsx`
  - `apps/web/src/styles/lists.css`
  - `apps/web/src/features/TasksPane.jsx`
  - `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ja.json`
  - `apps/bridge/test/ops-pause.test.js`, `apps/bridge/test/routeContracts.test.js`, `apps/bridge/test/emergency.test.js`（新規）
  - `apps/web/test/demoMode.test.js`
  - `demo/index.html`（同期）
- **実装要点**:
  - `routes.js` に `{ method: 'POST', pattern: '/api/emergency/stop-all', demo: 'mocked' }` を登録し、`server.js` と `ops.js`（および `mockApi.js`）で実装する：
    - `confirm === 'STOP_ALL'` を検証（不一致は HTTP 400 `CONFIRM_MISMATCH`）。
    - `ops.pause(reason, by)` を実行しつつ（pause が失敗しても詳細を記録して中断処理を続行）、非アーカイブ全ボード（`kanban.boards()`）の `status === 'running'` タスクを順次 `kanban.abort(slug, id, reason, lang)` で停止し、`nudgeWatchers()` と `auth.audit({ kind: 'emergency.stop_all', ... })` を記録する。
    - すべて成功なら HTTP 200 `{ ok: true, paused, aborted, failed: [], remainingRunning, at }`、一部でも失敗があれば HTTP 502（`CLI_FAILED` / `PARTIAL_FAILURE`）＋失敗配列を返す。
  - `ops.js` の `gateway()`（未使用 `detail` の活用）と `pause()` / `resume()`（`res.out` の抜粋）で `ApiError` に失敗詳細を含めてクライアントへ届ける。また `server.js` の書き込み系ルート（`comment` / `close` / `unblock` / `gateway` / `memos DELETE` 等）を監査し、`ok === false` を HTTP 200 で返さないよう統一する。
  - `Ui.jsx`（`HoldButton`）と `lists.css` に `onContextMenu={(e) => e.preventDefault()}`、`-webkit-touch-callout: none`、子要素 `.hold-label` / `.hold-sub` / `.hold-hint` への `pointer-events: none` を入れ、モバイルブラウザでの 1.5 秒長押し途切れを防ぐ。
  - `TasksPane.jsx` の緊急操作シートを **(1) カンバン・タスク緊急停止（Kanban Workers）**（実行中件数・最優先 `HoldButton`「全タスク緊急停止（ESTOP＋実行中一括中断）」・ESTOP 状態と個別 pause/resume）と **(2) Hermes Gateway 操作（Bot / 通信）**（`drain` / `restart` / `stop` / `start`）の見出しへ分離し、`r?.ok === false` 時はエラー文言を明示通知する。
- **受入条件（Verify）**:
  - `POST /api/emergency/stop-all` の異常系（誤 `confirm` 400、部分失敗 502）・正常系（ESTOP＋全 running タスク `abort` 200）・Demo 同等動作の単体テストがパスすること。
  - `routeContracts.test.js`（Web / `server.js` / `mockApi.js` / `routes.js` 一致）および `npm run verify` が exit 0 であること。
  - `npm run deploy`・`npm run build:demo` ＋ `demo/index.html` 同期後、実画面（390px モバイル幅＋デスクトップ幅、ライト／ダーク）で Emergency シート 2 セクション分割と `HoldButton` 表示を確認すること。

---

### Batch RG-3: ゴミタスク整理（archived 非表示トグル・一括アーカイブ）と不要 SPEC 退避（D92 後半）

- **Execution Mode**: `[Mode: Visual Gate]`
- **Recommended Role**: `role:builder`
- **目的**: テスト起票などで溜まったゴミタスク・不要 SPEC を画面から迷わず片付けられるよう、① `archived` タスク既定非表示＋トグル、② 複数選択一括アーカイブ（整理モード）、③ SPEC アーカイブ退避ボタンの 3 点を実装する。
- **変更・新規ファイル**:
  - `apps/bridge/src/kanban.js`
  - `apps/bridge/src/specs.js`
  - `apps/bridge/src/server.js`
  - `apps/bridge/src/contracts/routes.js`
  - `apps/web/src/demo/mockApi.js`
  - `apps/web/src/lib/tasksView.js`
  - `apps/web/src/features/TasksPane.jsx`
  - `apps/web/src/components/SpecMarkdownSheet.jsx`
  - `apps/web/src/styles/lists.css`
  - `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ja.json`
  - `apps/bridge/test/specs.test.js`, `apps/bridge/test/specsArchive.test.js`, `apps/bridge/test/inbox.test.js`, `apps/bridge/test/routeContracts.test.js`
  - `apps/web/test/tasksView.test.js`, `apps/web/test/demoMode.test.js`
  - `demo/index.html`（同期）
- **実装要点**:
  - `GET /api/boards/:board/tasks` は `archivedCount` を併記して返し、Launchpad の `specProgress` 精度を保ったまま、表示一覧側（`TasksPane.jsx` + `tasksView.js` 純関数）で **既定は `status !== 'archived'` のみ表示** し、一覧下部に **`アーカイブ済み (N)`** トグルを設ける（`SpecPicker` の `Show archived (N)` と同一操作感）。
  - `routes.js` に `POST /api/boards/:board/tasks/bulk-archive`（`demo: 'mocked'`）を登録して実装する：`taskIds` 配列（1〜50 件）を受け取り、`running` 状態のタスクは安全にスキップして `skippedRunning` へ入れ、残りのオープン非アーカイブタスクを `inbox.close(board, id, 'cancel', reason, by, lang)` で一括アーカイブし、`nudgeWatchers()` と `auth.audit({ kind: 'kanban.bulk_archive', ... })` を記録する。
  - `routes.js` に `POST /api/specs/archive`（`demo: 'mocked'`）を登録して実装する：`resolveSpecPath` ＋ `SPEC_FILE_RE` でリポジトリ境界内 `SPEC*.md` を検証し、既アーカイブなら冪等 `{ ok: true, noop: true }`、未アーカイブなら先頭 40 行のメタデータ部へ `- **Status**: archived` をアトミック書き込み（`.tmp` → rename）で追記してファイルパスを維持したまま退避し、`auth.audit({ kind: 'specs.archive', ... })` を記録する。
  - `TasksPane.jsx` に **「整理」モード**（複数選択チェックボックス、開いている失敗/停止タスク一括選択補助、長押し `HoldButton` で一括アーカイブ）を追加し、Spec 履歴／Launchpad の各バッチ行に紐づいたタスク ID と状態（`done` / `archived` / オープン）を添える。さらに Spec 履歴および `SpecMarkdownSheet.jsx` にアクティブ SPEC 用の長押し **「この仕様書をアーカイブへ退避」** ボタン（`POST /api/specs/archive`）を追加する。
  - `apps/bridge/test/specsArchive.test.js` は全バッチ完了後の `SPEC-COHERENCE.md` アーカイブ化を妨げないよう、「アクティブ SPEC 数が `SPEC_SPRAWL_LIMIT` 以下」の検証へ整理する。
- **受入条件（Verify）**:
  - `bulk-archive`（`running` スキップ・件数上限・Demo 同等動作）と `specs/archive`（`../` 境界拒否 400・冪等 `noop`・先頭 40 行挿入）のテスト、`routeContracts.test.js`、`tasksView.test.js`、`demoMode.test.js` が全件パスすること。
  - `npm run verify`・`npm run deploy`・`npm run build:demo` ＋ `demo/index.html` 同期が exit 0 であること。
  - 実画面（390px モバイル幅＋デスクトップ幅、ライト／ダーク）でアーカイブ済みトグル、整理モード複数選択、`SpecMarkdownSheet` アーカイブボタンの表示崩れが無いこと。

---

### Batch RG-4: リファクタリング画面の汎用「バグ・不具合ハント（bug-hunt）」プリセット追加（D93）

- **Execution Mode**: `[Mode: Visual Gate]`
- **Recommended Role**: `role:builder`
- **目的**: 任意の言語・リポジトリで単体テストが見逃す実運用バグを発見／修正できるよう、`RefactorSheet` に 6 つ目の汎用プリセット `bug-hunt`（「バグ・不具合ハント」／`Bug & Failure-Mode Hunt`）と再現先行オプトインを追加する。
- **変更・新規ファイル**:
  - `apps/web/src/lib/coherenceSweep.js`
  - `apps/web/src/features/TaskToolSheets.jsx`
  - `apps/web/src/styles/coherence.css`
  - `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ja.json`
  - `apps/web/test/coherenceSweep.test.js`, `apps/web/test/demoMode.test.js`, `apps/web/test/noHardcodedJapanese.test.js`
  - `demo/index.html`（同期）
- **実装要点**:
  - `coherenceSweep.js` の `SWEEP_PRESETS` へ `'bug-hunt'` を追加し、`RULE_KEYWORDS` に `/cli|silent|parity|guard|bug|deadend|collision|duplicate-batch/` → `'bug-hunt'` を足し、`sweepCounts()` の初期値へ `'bug-hunt': 0` を加える。リポジトリ固有のリテラル（固有コマンド・パス・チェック名）は D82 / D85 どおり一切入れない。
  - `buildSweepPayload({ preset, report, target, mode, board, lang, autoFix = false })` を拡張し、`bug-hunt` 用の **5 大盲点チェックリスト**（① 外部境界・CLI/プロセス呼出、② サイレント失敗・HTTP 200 偽装、③ 兄弟経路の契約漏れ、④ 状態×操作のデッドエンド、⑤ ID/キャッシュ衝突と運用ループ）を `coherence.preset.bug-hunt.*` 辞書経由で組み立てる：
    - `mode === 'single'` かつ `autoFix === false`（既定）：読取専用の **調査レポート専念** 契約（コードを変更せず、重要度順の不具合リスト・`file:line`・再現条件・修正案を報告する）。
    - `mode === 'single'` かつ `autoFix === true`：**再現先行（Reproduce-First）＋実証済みのみ修正** 契約（まず失敗する再現テストまたは検証コマンドを書いてから修正し、再現確認できない疑いは報告に留める）。
    - `mode === 'spec'`：5 大盲点チェックリストと選択方針を Spec Architect への種として渡し、修正計画を複数バッチ SPEC 化する。
  - `TaskToolSheets.jsx`（`RefactorSheet`）と `coherence.css` は既存の 2 起票ボタン（単発タスク起票／複数バッチ SPEC 作成）の構図を保ったまま、**`preset === 'bug-hunt'` のときだけ** 1 個のアクセシブルなチェックボックス（`autoFix`・既定 `false`・開閉時リセット）「再現テストで確認できた不具合まで自動修正する（既定 OFF＝調査レポート専念）」を表示する。
- **受入条件（Verify）**:
  - `coherenceSweep.test.js` で既定（調査専念）・`autoFix: true`（再現先行）・`spec`（種生成）・リポジトリ固有リテラルゼロ・`en.json` / `ja.json` キー一致がパスすること。
  - `noHardcodedJapanese.test.js`・`demoMode.test.js`・`npm run verify`・`npm run deploy`・`npm run build:demo` ＋ `demo/index.html` 同期が exit 0 であること。
  - 実画面（390px モバイル幅＋デスクトップ幅、ライト／ダーク）で 6 プリセット配置と `bug-hunt` 選択時のみのチェックボックス出し分けを確認すること。

---

### Batch RG-5: 再発防止の静的ガード（check-coherence 拡張）・状態マトリクステスト・非破壊ライブスモーク（D94）

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: 実 CLI 境界・サイレント失敗・起票契約パリティ・状態×操作デッドエンドを `npm run verify` と非破壊ライブスモークで継続的に自動検出できるようにする。
- **変更・新規ファイル**:
  - `scripts/check-coherence.mjs`
  - `scripts/smoke-live.mjs`（新規）
  - `package.json`
  - `docs/OPERATIONS.md`
  - `apps/bridge/test/coherence.test.js`, `apps/bridge/test/emergency.test.js`
  - `apps/web/test/stateActionMatrix.test.js`（新規）
  - `scripts/coherence-baseline.json`（必要時のみ縮小時同期・方針確認）
- **実装要点**:
  - `scripts/check-coherence.mjs` の `RULES` に英語単一言語の 3 つの Hard Fail ルールを追加する：
    1. `cli-invocation-guard`: `apps/bridge/src/` で `hermes` CLI を `execFile` / `spawn` する全箇所が `resolveHermesBin()` と `buildAugmentedPath()` を使い、`'--board'` を `'kanban'` より前に置く誤順を使っていないか検査する。
    2. `silent-failure-guard`: `apps/bridge/src/server.js` の重要変更ルート（`abort` / `stop-all` / `close` / `unblock` / `bulk-archive` / `gateway`）で結果オブジェクト `!out?.ok` のまま HTTP 200 を返していないか、および `apps/bridge/src/ops.js` でエラー詳細変数を未使用破棄していないか検査する。
    3. `create-route-parity`: カンバン起票経路（`specs.js` / `server.js` クイック起票 / `architect.js` / `review.js`）で `--assignee` 付与と `nudgeWatchers()` 呼出が揃っているか検査する。
  - `apps/web/test/stateActionMatrix.test.js` を新設し、全タスク状態（`todo` / `ready` / `running` / `blocked` / `failed` / `done` / `archived`）× 操作（中断 / 完了・アーカイブ / 一括整理 / 再開 / Spec 再起票）の到達性を表駆動テストで固定する。
  - `scripts/smoke-live.mjs` と `package.json` `"smoke:live": "node scripts/smoke-live.mjs"` を新設し、`docs/OPERATIONS.md` に運用手順を追記する：
    - カンバンや実データを一切変更せず、① 実バイナリの `hermes --help` / `hermes kanban --help` サブコマンド確認、② 稼働中 Bridge の読取系 API（`/api/overview`, `/api/coherence/report`, `/api/specs`, `/api/snippets/term`）疎通、③ 破壊系エンドポイント（`POST /api/emergency/stop-all`, `POST /api/gateway/stop` 等）の異常 `confirm` による HTTP 400 バリデーション通過を検証する。
- **受入条件（Verify）**:
  - `apps/bridge/test/coherence.test.js` に上記 3 ルールの正常・違反フィクスチャテストを追加して全件パスすること。
  - `apps/web/test/stateActionMatrix.test.js` がパスすること。
  - `npm run check:coherence`（標準出力が ASCII 単一言語）および `npm run verify`（`docs-scripts-parity` が `smoke:live` を通すこと含む）が exit 0 であること。
