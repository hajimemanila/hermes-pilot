# SPEC-PILOT-V7: Hermes Pilot V7 — Architect 安定化・実行方針選択・正確な稼働計測・表示トグル・用語統一

- **Status**: archived
- **アーカイブ日**: 2026-11-21（COH-4・全バッチ完了済み。以後は参照用に保持し、新規起票の対象外）

- **状態**: 仕様確定（2026-11-15 インタビュー D33〜D37 合意済み）
- **前提**: `docs/SPEC-PILOT-V6.md`（commit `fa84514`）まで実装済みであること
- **対象リポジトリ**: `hermes-mobile-pwa`（Bridge / Web PWA / Dashboard / Interactive Demo）
- **完了条件（全バッチ共通）**:
  - 既存テスト（`apps/bridge/test/`・`apps/web/test/`）が全件パスし、追加仕様に対する単体・統合テストが追加されていること
  - `noHardcodedJapanese.test.js` / `i18nLeak.test.js` / `i18n.test.js` / `scripts/check-oauth-boundary.mjs` / `scripts/audit-responsive.mjs` に違反しないこと
  - Interactive Demo（`apps/web/src/demo/`）および `npm run build:demo` の整合性が保たれていること

---

## 1. コンセプトと V6 実機検証からの課題解決

V6 の実機運用で確認されたパイプライン上の違和感・不具合を、場当たり的なパッチではなく設計単位で解消し、Architect（仕様策定）から Builder（自律実装）および完了計測・通知までの一貫性を高める。

1. **Architect（仕様策定）スタック解消と実行方針選択（`Zero-stop` / `Visual-gate`）**:
   - **原因の整理**: 進行バー確認等のテスト用（捨てる種）を含む仕様策定ジョブが 20 分以上 `awaiting_spec`（「仕様書を書いています…」）のまま抜けなくなる問題は、以下の 3 点が重なっていたために発生している。
     1. `apps/bridge/src/kanban.js` の `tasks()` SQL クエリに `body` 列が含まれておらず、`apps/bridge/src/architect.js` の `findJobReviewTask()` が本番 DB 上で Round 1 タスクの `[review]` / `[ARCH]` 本文を判定できていない。
     2. `architect.js` の `jobsFor()` が親 `[ARCH]` タスク自身の `status === 'done' || 'archived'` を終端として扱っておらず、完了済み・キャンセル済みタスクも `awaiting_spec` のまま進行バーに残り続ける。
     3. `ArchitectJobBar` の `×` ボタンがブラウザの一時状態しか持たず再読込で復活し、さらに `ready`（待機中／キュー待ち）と `running`（実行中）の表示・ポーリング区別が不十分。
   - **方針選択（Zero-stop / Visual-gate）**: 仕様策定シートに実行方針セレクターを追加する。**どちらの方針でも Round 1 の Quick Review インタビューは実施したうえで**、生成される `docs/SPEC-*.md` の各バッチに付す既定 `Execution Mode`（`[Mode: Zero-Stop]` 既定 / `[Mode: Visual Gate]`）を切り替える。
2. **完了レシート・完了報告レポートの所要時間整合性修正＋API コール数／トークン数追加**:
   - V5 完了レシートで実際数十分の作業が `14時間 15分` と表示された原因は、`apps/bridge/src/telemetry.js` が `summarizeTasks(input.tasks)` を呼ぶ際にボード上限 200 件の全タスクを `spec` スコープで絞り込まず集計し、別タスクの `startedAt`〜`completedAt` に引っ張られて 24h 上限窓付近まで拡大していたためである。
   - 対象 Spec／Run（`taskIds`・バッチ ID・`spec` 一致）に厳密に絞り込んだタスクの区間をソート・マージして**実稼働時間（Active Worker Duration）**を算出し、主要な `durationMin` とする（併せて経過時間 `wallDurationMin` も保持）。さらに `usage.js` 経由で当該 Spec Run に紐づくセッション群の `apiCalls` と `totalTokens` を集計し、完了レシート（`4×2` の 8 KPI）および `pipeline-watcher.js` 完了報告の両方へ統一ロジックから出力する。
3. **ブラウザ音声認識（Web Speech API）の削除と OS 音声入力への一本化**:
   - Tailscale HTTP（非 Secure Context）や Android Chrome での `continuous: true` 非互換により失敗するカスタム Web Speech API マイク入力を `SpecSeedSheet.jsx` と `CaptureSheet.jsx` から削除し、自動フォーカス＋OS キーボード標準音声入力＋テンプレートチップへ一本化する。
4. **スニペット／赤入れスタンプ帯の個別表示トグル（設定タブ）**:
   - 設定タブ内にチャット・Annotation 赤入れ・ターミナルそれぞれの下部スニペット／スタンプ帯を個別に表示／非表示にできるトグル（すべてデフォルト ON、`hm.snippetBars.v1` に保存）を追加する。非表示時でもシートやヘッダからの代替導線は維持し、画面表示領域を確保できるようにする。
5. **日本語表記の統一（「端末」→「ターミナル」／「仕様の種」→「仕様策定」）とデモ同期**:
   - 日本語 UI でターミナル機能を指す「端末」を「ターミナル」へ、「仕様の種」を「仕様策定」へ統一する（物理デバイスを意味する「端末」と英語 `"Spec Seed"` は維持）。PWA 本番・Dashboard・Builtin Snippets・Interactive Demo・テスト群を一括同期する。

---

## 2. 合意決定表（インタビュー D33〜D37）

| ID | 論点 | 合意内容 |
| :--- | :--- | :--- |
| **D33** | Architect スタック解消と音声認識扱い | `kanban.tasks` に `body` 列を追加し `done`/`archived` タスクの終端判定とサーバー永続 `dismiss` を実装する。ブラウザ独自 Web Speech API マイク入力は `SpecSeedSheet`・`CaptureSheet` 両方から削除し、OS 標準音声入力へ一本化する。 |
| **D34** | 完了レシート・報告の時間整合性＋API/トークン追加 | Spec / Run 単位のタスク絞り込みと重複区間マージによる実稼働時間（`activeDurationMin`）を主指標（`durationMin`）とし、経過時間（`wallDurationMin`）も併記可能にする。`usage.js` から `apiCalls`・`totalTokens` を追加し、レシートを 8 KPI（`4×2`）化する。 |
| **D35** | 仕様策定の実行方針選択 | `SpecSeedSheet` に `Zero-stop`（デフォルト）／`Visual-gate` の方針選択を設置する。両方針とも Quick Review インタビューは実施し、生成される SPEC バッチの既定 Execution Mode（`[Mode: Zero-Stop]` / `[Mode: Visual Gate]`）を切り替える。 |
| **D36** | スニペット／スタンプ帯の表示トグル | 設定タブ内に 3 箇所（チャット定型文帯・赤入れスタンプ帯・ターミナル定型コマンド帯）それぞれの**個別トグル**を追加する（デフォルト全 ON、永続化キー `hm.snippetBars.v1`）。非表示時はヘッダ／シート導線を残す。 |
| **D37** | 日本語表記統一とデモ同期 | ターミナル機能の意味の「端末」→「ターミナル」、また「仕様の種」→「仕様策定」へ統一（実デバイス「端末」および英語 `"Spec Seed"` は維持）。Dashboard・Builtin Snippets・Interactive Demo も同期する。 |

---

## 3. 詳細技術仕様

### 3.1 Architect 状態遷移修正・ジョブ破棄 API・実行方針伝播

1. **`apps/bridge/src/kanban.js` — `tasks()` への `body` 列追加**:
   - `tasks(slug, opts = {})` の `SELECT` 句に `body` 列を追加し、返却される各タスクオブジェクトに `body`（未設定時は `''` または `null`）を含める。
   - これにより `findJobReviewTask(job, tasks)` が Round 1 で生成された `[review]` タスクおよび関連本文を本番 SQLite から確実に検出できるようにする。

2. **`apps/bridge/src/architect.js` — 状態遷移・終端判定・破棄ストア**:
   - **親タスクの終端状態反映**: `jobsFor(query = {})` において、`findJobSpec` / `findJobReviewTask` に合致しない場合でも、該当ジョブに紐づく親タスク（`self`）の `status` が `'done'` または `'archived'` に遷移していれば、`'awaiting_spec'` として残さず終端状態（`'done'` / `'archived'`、アクティブジョブ一覧からは除外）として評価する。
   - **待機中と実行中の区別**: 親タスクの `status` が `'ready'`（着手中ではない待機状態）と `'in_progress'` 等（`'running'`）を `publicJob` 上で判別できるフィールドまたは状態（例: `queueState: 'queued' | 'running'` または既存ステータスとの整合表現）を返し、UI が「キュー待ち」と「実行中」を区別して表示できるようにする。
   - **サーバー側ジョブ破棄（`dismiss`）**:
     - `createArchitect` に `dismiss(jobId)` を追加する。破棄された `jobId` は再起動やリロードで復活しないよう Bridge データストア（永続 JSON ファイルまたはストア）に保存し、`jobsFor()` の通常レスポンスから除外する（監査・テスト用途向けに `includeDismissed` 相当の内部参照のみ許容）。
   - **実行方針（`executionPolicy`）の正規化とプロンプト反映**:
     - 有効値は `'zero-stop'`（既定）と `'visual-gate'` とし、不正値・未指定は `'zero-stop'` に正規化するヘルパー（`normalizeExecutionPolicy`）を用意する。
     - `buildArchitectTaskBody({ prompt, board, repoPath, jobId, executionPolicy })` および `buildSeedPrompt({ jobId, seedText, board, repoPath, autoStart = false, executionPolicy = 'zero-stop', lang = 'ja' })` が `executionPolicy` を受け取り、プロンプト内に次の明示指示を含める:
       - 両方針共通で Round 1 の Quick Review インタビューを実施して仕様を固めること
       - `'zero-stop'` の場合は生成する `docs/SPEC-*.md` 各バッチの既定 `Execution Mode` を `[Mode: Zero-Stop]` とすること（止まらず自律完走向け）
       - `'visual-gate'` の場合は生成する `docs/SPEC-*.md` 各バッチの既定 `Execution Mode` を `[Mode: Visual Gate]` とすること（要所で視覚確認・承認を挟む方針）
     - `createArchitect.seed(input)` と `publicJob(job)` は `executionPolicy` を保持・返却する。

3. **`apps/bridge/src/server.js` — ルーティング追加**:
   - `POST /api/architect/seed`: リクエストボディの `executionPolicy` を受け取り、`architect.seed(...)` へ渡す。
   - `POST /api/architect/jobs/:id/dismiss`: `architect.dismiss(req.params.id)` を呼び出し `{ ok: true, jobId }`（存在しないまたは空 ID は適切な 4xx）を返す。

### 3.2 Spec スコープ稼働時間・API コール数・トークン数集計と 8 KPI レシート

重複ロジックを避けるため、Spec スコープのタスクフィルタリング、区間マージ実稼働時間計算、およびセッション／時間窓ベースの `usage` 集計は共通ヘルパーとして整理し、`telemetry.js` と `pipeline-watcher.js` の双方から利用する。

1. **Spec / Run スコープ絞り込みと区間マージ実稼働時間（`apps/bridge/src/telemetry.js`）**:
   - `summarizeTasks(tasks, opts = {})`（および `createTelemetry.receipt(opts = {})`）が `opts.spec` または `opts.taskIds` を受け取った場合、無関係な他タスクを絶対に混ぜないよう対象タスクを厳密にフィルタリングする:
     - 優先 1: `specs.js` の `pipeline-runs.json` 等から取得できる対象 `spec` の最新または合致 `run.taskIds` による ID 一致
     - 優先 2: 対象 SPEC 内のパース済みバッチ ID との一致および `sameSpec(task, opts.spec)` 一致
     - 該当タスクが 0 件の場合は `0` 分・`0` 件を返し、ボード上の別タスクで補完しない。
   - **時間区間マージ（Active Duration vs Wall Duration）**:
     - 各該当タスクから有効な `[start, end]` 区間を抽出する（`startedAt` があり `completedAt` がある完了区間、または実行中のみ `now`、負区間・極端な不正値は除外）。
     - 区間を開始時刻で昇順ソートし、重なる区間 `[a1, b1]`・`[a2, b2]`（`a2 <= b1`）を `[a1, max(b1, b2)]` へマージして合計ミリ秒を求める。これを分丸めした値を `activeDurationMin` とし、KPI の **`durationMin`** として出力する。
     - 参考値として `min(startedAt)`〜`max(completedAt)` の単純経過時間を `wallDurationMin` として返却する（`durationCapped` 等既存フラグとの整合を維持）。

2. **API コール数・トークン数の集計（`apps/bridge/src/usage.js`・`telemetry.js`・`pipeline-watcher.js`）**:
   - `usage.js` は `state.db` の `sessions` および `session_model_usage` テーブルから `api_call_count`・`input_tokens`・`output_tokens`・`cache_read_tokens`・`cache_write_tokens` を読み取れる構造を持っているため、対象セッション ID 配列（`sessionIds`）または時間範囲（`sinceMs` / `untilMs`）でスコープ集計できるメソッド（または既存取得メソッドへのフィルタオプション）を追加する。
   - 対象 `spec` のタスク／Run に紐づく `session_id` 群が特定できる場合はそのセッション群のみで合算し、紐づく `session_id` が取れない場合のみ Run の有効時間範囲内のセッションで安全にフォールバックする（テーブル不在・`db` 未存在時は安全に `0`）。
   - `buildReceipt(input = {})` の `kpi` に以下を追加する:
     - `apiCalls`: スコープ合計 API コール数（整数）
     - `totalTokens`: `inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens` のスコープ合計トークン数（整数）
     - `wallDurationMin`: 単純経過時間（分）
     - （`durationMin` はマージ済み実稼働時間 `activeDurationMin` とする）
   - `apps/bridge/src/pipeline-watcher.js` の `buildPipelineReport` でも同じ共通算出を用い、完了報告テキストへ所要時間（実稼働／経過）、API コール数、トークン数を出力する。

3. **完了レシート Canvas & シート拡張（`apps/web/src/lib/receiptCanvas.js`・`apps/web/src/features/MissionReceiptSheet.jsx`）**:
   - `KPI_KEYS` を 6 項目（`3×2`）から 8 項目（`4×2`）へ拡張する:
     - `['cost', 'cache', 'saved', 'zeroTyping', 'tests', 'duration', 'apiCalls', 'totalTokens']`
   - `kpiValue` に `apiCalls` と `totalTokens` のフォーマット（例: トークンは `1.2M` / `480K` / `950`、API コールは数値＋単位）を追加する。
   - `drawReceipt` の `4×2` タイル配置・余白・フォントサイズを調整し、1200px 幅 Canvas 上で文字切れ・重なりなく鮮明に描画されるようにする。
   - `buildShareText` および `MissionReceiptSheet.jsx` 内のライブサマリー表示にも API コール数・トークン数・正確な所要時間を反映し、`apps/web/test/receipt.test.js` の `KPI_KEYS` 長・行数・`fillText` 呼び出し数の期待値を更新する。

### 3.3 Seed 実行方針 UI・ArchitectJobBar 改善・Web Speech 削除

1. **Web Speech API 音声ボタン削除（`SpecSeedSheet.jsx`・`CaptureSheet.jsx`・`specSeed.js`）**:
   - `apps/web/src/features/SpecSeedSheet.jsx`:
     - カスタム音声認識マイクボタン、録音中アニメーション、`not-allowed` 等の認識エラーフォールバック UI を削除する。
     - モーダル展開時にテキストエリアへ自動フォーカスし、短いヒント文（OS キーボードのマイク機能で音声入力できる旨）とテンプレートチップを残す。
   - `apps/web/src/features/CaptureSheet.jsx`:
     - `toggleMic`・`speechSupported`・マイクボタンと録音用状態管理を削除し、シンプルなテキスト入力＋ボード選択起票 UI とする。
   - `apps/web/src/lib/specSeed.js`:
     - Web Speech API 専用ヘルパー（`recognitionCtor`・`speechLocale`・`mergeTranscript`）および不要な音声関連 CSS・i18n キーを削除し、`apps/web/test/specSeed.test.js` を同期更新する。

2. **実行方針セレクター追加（`SpecSeedSheet.jsx`・`specSeed.js`）**:
   - `apps/web/src/lib/specSeed.js` に `EXECUTION_POLICIES = ['zero-stop', 'visual-gate']`（既定 `'zero-stop'`）を追加し、`buildSeedPayload({ seedText, autoStart, executionPolicy = 'zero-stop', runner, board, repo, chat, lang })` が正規化された `executionPolicy` をペイロードに含めるようにする。
   - `apps/web/src/features/SpecSeedSheet.jsx` の設定オプション部に 2 択のポリシーピル／セグメント（`Zero-stop` [既定] / `Visual-gate`）を配置し、選択中の説明（両方針とも Quick Review インタビューを行い、生成バッチを自律完走させるか・実機確認ゲートを挟むか）を表示する。タップ領域は 44px 以上を確保する。

3. **`ArchitectJobBar` 改善（`apps/web/src/components/ArchitectJobBar.jsx`・`ChatPane.jsx`）**:
   - `×` ボタン押下時、ローカル状態更新に加えて `POST /api/architect/jobs/:id/dismiss` を送信し、サーバー側でも破棄を永続化する。
   - `queued`（待機中／キュー待ち）と `running`（仕様書執筆中）の状態表示を明確に分け、ポーリング（`jobPollMs`）と経過時間表示が実際のジョブ状態と整合するようにする。

### 3.4 スニペット／スタンプ帯の個別表示トグル（設定＋3 画面）

1. **状態管理モジュール（新規 `apps/web/src/lib/snippetBars.js`）**:
   - `localStorage` キー `hm.snippetBars.v1` を用いる純粋ヘルパー `DEFAULT_SNIPPET_BARS`（`{ chat: true, annotation: true, term: true }`）・`loadSnippetBars()`・`saveSnippetBars(next)`（部分更新および不正 JSON フォールバック対応）およびカスタムイベント通知ヘルパーを提供する。
2. **設定タブトグル（`apps/web/src/features/SettingsPane.jsx`）**:
   - スニペット管理セクション（`sec-snippets`）内に表示設定グループを設け、以下 3 項目の個別オン・オフスイッチを配置する（初期値すべて ON）:
     - チャット画面のスニペット帯（`chat`）
     - Annotation 赤入れのスタンプ帯（`annotation`）
     - ターミナル画面のスニペット帯（`term`）
3. **3 画面での条件分岐と導線保持**:
   - `apps/web/src/features/ChatPane.jsx`: `snippetBars.chat` が `false` のとき下部 `.action-bar` のスニペット帯を描画しない（入力欄の `＋` 添付・その他操作導線は維持）。
   - `apps/web/src/features/AnnotationEditor.jsx`: `snippetBars.annotation` が `false` のとき `.ak-anno-bar` のスタンプチップ帯を描画しない（ツール群・テキスト入力等、赤入れの主機能導線は維持）。
   - `apps/web/src/features/TermPane.jsx`: `snippetBars.term` が `false` のとき下部 `.action-bar` のホットスニペットチップ列を描画しない（ヘッダ内の `term.snippets`＝定型ボタンからのシート導線は維持）。

### 3.5 日本語表記統一（「端末」→「ターミナル」／「仕様の種」→「仕様策定」）とデモ同期

1. **「端末」→「ターミナル」置換対象と非置換対象**:
   - **置換対象（ターミナル機能の意味）**:
     - `apps/web/src/i18n/ja.json`:
       - `nav.term`: `"端末"` → `"ターミナル"`
       - `settings.secAppearance`: `"外観・端末"` → `"外観・操作"`
       - `settings.audit`: `"監査ログ（緊急操作・端末）"` → `"監査ログ（緊急操作・ターミナル）"`
       - `settings.snippetTerm`: `"端末"` → `"ターミナル"`
       - `app.termLoading`: `"端末を読み込み中…"` → `"ターミナルを読み込み中…"`
     - `apps/dashboard/index.js`:
       - `snippetsLead`: `"チャットと端末の定型文。Hot にすると PWA のクイックバーに出ます。"` → `"チャットとターミナルの定型文。Hot にすると PWA のクイックバーに出ます。"`
       - `tabTerm`: `"端末"` → `"ターミナル"`
   - **非置換対象（物理デバイスの意味）**:
     - `review.pickFromDevice`・`settings.themeSystem`・`settings.pairing` 系・`chat.thisDeviceDefault` など物理デバイスを指す「端末」は変更しない。
2. **「仕様の種」→「仕様策定」置換対象（英語 `"Spec Seed"` は維持）**:
   - `apps/web/src/i18n/ja.json`: `seed.title`（`"仕様の種"` → `"仕様策定"`）および `seed.*`・ガイド文言内の「仕様の種」を「仕様策定」へ統一（関連キーの変更時は `en.json` とキーセット一致を維持）。
   - `apps/bridge/src/snippets.js`: `spec-seed` の `ja.label` `'🎙️ 仕様の種'` → `'📝 仕様策定'`（音声ボタン廃止に伴い絵文字を整理。`en.label` は `'📝 Spec Seed'` として英語 `"Spec Seed"` 表記を維持）。
   - `apps/web/src/demo/snippets.js`・`apps/web/src/demo/mockApi.js` の定型文およびデモ応答・デモ用 8 KPI レシートデータ・デモ内 `SpecSeed` / `snippetBars` を本番と完全同期させる。

---

## 4. カンバンタスク分割（Batch V7-1 〜 V7-5）

### Batch V7-1: Bridge Architect 状態遷移修正・ジョブ破棄 API・実行方針受付
- **Execution Mode**: `[Mode: Zero-Stop]`
- **目的**: `kanban.tasks` の `body` 欠落と `architect.jobsFor` の終端未判定による「仕様書を書いています…」スタックを解消し、ジョブ破棄のサーバー永続化および `executionPolicy`（`zero-stop` / `visual-gate`）受付を Bridge に実装する。
- **変更・新規ファイル**:
  - `apps/bridge/src/kanban.js`
  - `apps/bridge/src/architect.js`
  - `apps/bridge/src/server.js`
  - `apps/bridge/test/architect.test.js`
- **受入条件（Verify）**:
  - `kanban.tasks(slug)` の戻り値各要素に SQLite の `body` 列が含まれ、`findJobReviewTask` が `[review]` 本文を検出できる。
  - 親 `[ARCH]` タスクの `status` が `'done'` または `'archived'` のとき、`jobsFor()` が `'awaiting_spec'` として残留させない。
  - `self.status === 'ready'` と実行中の区別が返却ジョブに反映される。
  - `POST /api/architect/jobs/:id/dismiss` で破棄したジョブが再取得後もアクティブ一覧に出ない。
  - `POST /api/architect/seed` が `executionPolicy`（`'zero-stop'` 既定 / `'visual-gate'`）を受け取り、`buildSeedPrompt` が Quick Review インタビュー維持＋バッチ既定 Execution Mode 指定を出力する。
  - `node --test apps/bridge/test/architect.test.js` および Bridge 全テストが 0 failure でパスする。

### Batch V7-2: Spec スコープ稼働時間・API コール・トークン集計と 8 KPI 完了レシート
- **Execution Mode**: `[Mode: Zero-Stop]`
- **目的**: 完了レシートおよび完了報告の異常な時間計上（他タスク混入・単純差分）を解消し、Spec スコープのマージ済み実稼働時間・経過時間および API コール数・トークン数を 8 KPI（`4×2`）レシートとレポートへ統合する。
- **変更・新規ファイル**:
  - `apps/bridge/src/usage.js`
  - `apps/bridge/src/telemetry.js`
  - `apps/bridge/src/pipeline-watcher.js`
  - `apps/bridge/src/server.js`
  - `apps/web/src/lib/receiptCanvas.js`
  - `apps/web/src/features/MissionReceiptSheet.jsx`
  - `apps/web/src/i18n/en.json`
  - `apps/web/src/i18n/ja.json`
  - `apps/bridge/test/telemetry.test.js`
  - `apps/web/test/receipt.test.js`
- **受入条件（Verify）**:
  - `telemetry.receipt({ spec, board })` が対象 Spec / Run 以外のボードタスクを時間・バッチ計算から除外し、並列タスクの重複区間をマージした `durationMin`（実稼働時間）と `wallDurationMin`（経過時間）を返す。
  - `usage.js` 経由で対象 Spec セッション群（または時間窓フォールバック）の `apiCalls`・`totalTokens` が算出され、`telemetry.js` と `pipeline-watcher.js` の双方に反映される（二重実装なく共通関数を共有）。
  - `receiptCanvas.js` の `KPI_KEYS` が 8 項目（`4×2`）になり、1200px Canvas および共有テキスト・`MissionReceiptSheet` で欠けずに描画される。
  - `apps/bridge/test/telemetry.test.js`・`apps/web/test/receipt.test.js` および `npm test` がパスし、`i18n.test.js`・`noHardcodedJapanese.test.js` に違反しない。

### Batch V7-3: Seed 実行方針 UI・ArchitectJobBar 改善・Web Speech 削除
- **Execution Mode**: `[Mode: Visual Gate]`
- **目的**: `SpecSeedSheet` に `Zero-stop` / `Visual-gate` 実行方針選択を追加し、`ArchitectJobBar` の破棄永続化と待機・実行状態表示を改善し、失敗するブラウザ独自音声認識ボタンを `SpecSeedSheet`・`CaptureSheet` から削除する。
- **変更・新規ファイル**:
  - `apps/web/src/lib/specSeed.js`
  - `apps/web/src/features/SpecSeedSheet.jsx`
  - `apps/web/src/features/CaptureSheet.jsx`
  - `apps/web/src/components/ArchitectJobBar.jsx`
  - `apps/web/src/features/ChatPane.jsx`
  - `apps/web/src/i18n/en.json`
  - `apps/web/src/i18n/ja.json`
  - 関連スタイルファイル（CSS）
  - `apps/web/test/specSeed.test.js`
- **受入条件（Verify）**:
  - `SpecSeedSheet` と `CaptureSheet` からカスタム Web Speech API マイクボタン・認識フォールバック表示が削除され、自動フォーカス入力と OS 標準音声入力ヒントが整備されている。
  - `SpecSeedSheet` に `Zero-stop`（既定）と `Visual-gate` の選択 UI があり、`buildSeedPayload` 経由で `POST /api/architect/seed` に `executionPolicy` が送信される。
  - `ArchitectJobBar` の `×` 押下で `POST /api/architect/jobs/:id/dismiss` が呼ばれリロードしても再出現せず、待機中（`ready`）と実行中（`running`）の表示が識別できる。
  - `apps/web/test/specSeed.test.js`・`npm test`・`scripts/audit-responsive.mjs` がパスし、モバイル実画面幅（`390×844`）でタップ領域・はみ出しがない。

### Batch V7-4: スニペット／スタンプ帯の 3 個別表示トグル（設定＋チャット／赤入れ／ターミナル）
- **Execution Mode**: `[Mode: Visual Gate]`
- **目的**: チャット下部スニペット帯、Annotation 赤入れスタンプ帯、ターミナルスニペット帯の 3 箇所を、設定タブから個別に表示／非表示切り替えできるようにする（既定全 ON、永続化あり）。
- **変更・新規ファイル**:
  - `apps/web/src/lib/snippetBars.js`（新規）
  - `apps/web/src/features/SettingsPane.jsx`
  - `apps/web/src/features/ChatPane.jsx`
  - `apps/web/src/features/AnnotationEditor.jsx`
  - `apps/web/src/features/TermPane.jsx`
  - `apps/web/src/i18n/en.json`
  - `apps/web/src/i18n/ja.json`
  - `apps/web/test/snippetBars.test.js`（新規）
- **受入条件（Verify）**:
  - `hm.snippetBars.v1` に `{ chat, annotation, term }` が保存され、未設定時は 3 項目とも `true` となる。
  - 設定タブで各トグルを切り替えるとリロードなしで該当画面の帯だけが即座に表示／非表示になる。
  - 非表示状態でもチャット入力の `＋` 操作・赤入れの基本描画／テキスト注釈ツール・ターミナルヘッダの定型ボタン（`term.snippets`）から各機能へアクセスできる。
  - `apps/web/test/snippetBars.test.js`・`npm test`・`scripts/audit-responsive.mjs` が全件パスする。

### Batch V7-5: 日本語表記統一・Interactive Demo 同期・全体回帰検証
- **Execution Mode**: `[Mode: Visual Gate]`
- **目的**: 日本語 UI 内の「端末」（ターミナルの意）→「ターミナル」および「仕様の種」→「仕様策定」の表記統一を完了し、Interactive Demo の新仕様同期とリポジトリ全体ビルド・セキュリティ／レスポンシブ監査を完走させる。
- **変更・新規ファイル**:
  - `apps/web/src/i18n/ja.json`
  - `apps/web/src/i18n/en.json`
  - `apps/bridge/src/snippets.js`
  - `apps/dashboard/index.js`
  - `apps/web/src/demo/snippets.js`
  - `apps/web/src/demo/mockApi.js`
  - `apps/bridge/test/snippets.test.js`
  - `apps/bridge/test/snippets-i18n.test.js`
  - `apps/bridge/test/dashboard-plugin.test.js`
  - `apps/web/test/demoMode.test.js`
- **受入条件（Verify）**:
  - `ja.json`（`nav.term`・`settings.secAppearance`・`settings.audit`・`settings.snippetTerm`・`app.termLoading`・`seed.title`）・`apps/dashboard/index.js`（`tabTerm`・`snippetsLead`）・`apps/bridge/src/snippets.js`（`spec-seed` 日本語ラベル）・`apps/web/src/demo/` が新表記に統一され、物理デバイスの「端末」および英語 `"Spec Seed"` は維持されている。
  - Interactive Demo（`mockApi.js`）でも `executionPolicy` 付き `seed`・`dismiss`・8 KPI レシート・3 個別バー表示トグルが破綻なく動作する。
  - `npm test`・`npm run verify`・`npm run build:demo`・`scripts/check-oauth-boundary.mjs`・`scripts/audit-responsive.mjs` の全チェックがエラー 0 で完了する。

---

## 5. 横断ガードレール（全バッチ共通）

1. **既存テスト・公開品質境界の維持**: `.gemini`・`oauth_creds`・`keychain-antigravity` 等のローカル個人認証境界をランタイムコードから参照しないこと（`scripts/check-oauth-boundary.mjs` で担保）。
2. **i18n 整合と日本語直書き禁止**: `apps/web/src/**/*.{js,jsx}`（`demo/` とコメントを除く）への日本語直書きを行わず、全 UI 文字列を `en.json` と `ja.json` の対称キーで定義すること。エラーメッセージも英語キー／英語メッセージとすること（`i18nLeak.test.js` で担保）。
3. **非機能・モバイル操作性**: 新設するセグメント・トグル・シート要素はすべて最小タップ領域 44px 以上・横はみ出し 0px を満たすこと（`scripts/audit-responsive.mjs` で担保）。
4. **重複回避**: 時間区間マージ・Spec スコープ絞り込み・ローカル設定永続化は専用関数／ヘルパーに集約し、サーバー側とクライアント側それぞれで同じ計算ロジックを複数箇所に重複実装しないこと。
