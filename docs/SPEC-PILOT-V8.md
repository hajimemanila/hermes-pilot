# SPEC-PILOT-V8: Hermes Pilot V8 — Quick Review ドロワー統合フォーム復旧・仕様策定（Hermes Native）高速化・タスク詳細ライブ進捗仕様書

- **Status**: archived
- **アーカイブ日**: 2026-11-21（COH-4・全バッチ完了済み。以後は参照用に保持し、新規起票の対象外）

- **状態**: 仕様確定（2026-11-15 実機検証監査 D38〜D40 合意済み）
- **前提**: `docs/SPEC-PILOT-V7.md`（commit `213c5b1`）まで実装済みであること
- **対象リポジトリ**: `hermes-mobile-pwa`（Bridge / Web PWA / Skills / Interactive Demo）
- **完了条件（全バッチ共通）**:
  - 既存テスト（`apps/bridge/test/*.test.js`・`apps/web/test/*.test.js`）が全件パスし、追加仕様に対する単体・統合テストが追加されていること
  - `noHardcodedJapanese.test.js` / `i18nLeak.test.js` / `i18n.test.js` / `scripts/check-oauth-boundary.mjs` / `scripts/audit-responsive.mjs` に違反しないこと
  - Interactive Demo（`apps/web/src/demo/`）および `npm run build:demo` の整合性が保たれていること

---

## 1. 実機検証（`spec-share280-01`）から特定した原因と設計方針

V7 完了後の実機テスト（種: `[ARCH] 完了レシート内のシェア文を…` → `spec-share280-01` / commit `4e8438c`）で確認された 2 つの課題について、Hermes Pilot 側の実装・スキル・イベント表示の 3 層で根本解消を行う。

1. **Quick Review でドロワー統合フォーム（`<StandardForm>`）ではなく生の HTML シート（`<IframeForm>`）が出るデグレの解消（D38）**:
   - **原因**: `skills/spec-architect/SKILL.md`（L58）および `skills/quick-review/SKILL.md`（L107・L114・L157）の起票フォーマットが `mode=sheet` と指示しているため、実体は構造化 `.json`（`"mode": "standard"`, 設問配列 `questions` 付き）が正しく生成されていても、`apps/bridge/src/review.js`（L594）が `item.review.mode = 'sheet'` を返す。結果、`apps/web/src/features/ReviewPane.jsx`（L898）の `openItem` にある早期リターン `if (ak.mode && ak.mode !== 'standard') return` が `/api/review/:id/data` の取得をスキップし、`data === null` のまま `<IframeForm>` へフォールバックしていた（あわせて `⚡ 推奨案で一括承認` ボタンや完了後の構造化回答履歴も消えていた）。
   - **方針**: `openItem` は `mode === 'annotation'` のときだけ `.json` 取得をスキップし、`'standard'`・`'sheet'`・未指定のすべてで `/api/review/:id/data` を取得する（完了後は `ReadOnlyDetail` の回答履歴にも反映）。同時に、ブリッジ側の `sheetHtml(id)` に `.json` からの HTML 動的フォールバック生成を追加し、手書き `.html` が無くても「シート全体を開く ↗」が常に動作するようにする。

2. **Hermes Native 仕様策定（Round 1）の約 10 分待ち解消（D39）**:
   - **原因**: Round 2（`docs/SPEC-SHARE280.md` 192 行の執筆〜コミット）は約 3 分半で完了しているのに対し、Round 1 が約 8〜9 分かかっていた主因は、`skills/spec-architect/SKILL.md`（L43 等）および `skills/quick-review/SKILL.md` が、1 行の軽量な種に対しても「UI 案の HTML/CSS モック作成＋ヘッドレスブラウザ（`browser_exec`）でのスクリーンショット撮影＋379 行・174KB の手書き HTML 生成」を強制しているためである。ドロワー統合フォーム（`<StandardForm>`）では `.json` だけで回答UI・推奨案一括承認が完結するため、通常のテキスト／ロジック系仕様策定ではこの処理がボトルネックになっていた。
   - **方針**: `spec-architect` / `quick-review` スキルと `apps/bridge/src/architect.js`（`buildSeedPrompt`・`buildArchitectTaskBody`）を **JSON ファースト（`sheets/<label>-<round>.json` 主体、`mode=standard`）** に改め、手書き `.html` およびヘッドレスブラウザでのモック撮影は「UI レイアウト／見た目の比較が主論点のとき」のみに限定する。「シート全体を開く ↗」用 HTML はブリッジ側の JSON→HTML フォールバックが自動補完する。

3. **タスク詳細シートの `heartbeat` 連続羅列解消とライブ作業フィード統合（D40）**:
   - **原因**: `apps/bridge/src/kanban.js`（L178-L228）の `task(slug, id)` が返す `events` は Kanban のライフサイクルイベント（`spawned`, `owner_admitted`, `worker_bound`, 1 分おきの `heartbeat`）のみであり、ワーカーが実際に実行しているツール呼び出しや思考ログ（Hermes `state.db`）を含まない。また `apps/web/src/features/TasksPane.jsx`（L951-L962）が `detail.events` を折りたたみなしでそのまま縦に並べるため、数分間の稼働中に `heartbeat` 行だけが並び、停止しているように見えていた（`ReviewPane.jsx` には `<WorkerFeed>` があるが、`TasksPane` にも、`mobile` 以外のボード（`hermes-pilot` 等）を直接参照するワーカー取得ルートにも繋がっていなかった）。
   - **方針**:
     1. 連続する `heartbeat` イベントを `heartbeat ×N`（最新時刻＋経過開始時刻）の 1 行に折りたたむ純粋関数 `collapseTaskEvents` を導入する。
     2. `kanban.task(slug, id)` と新設エンドポイント `GET /api/boards/:slug/tasks/:id/worker` により、**任意のボード**（`hermes-pilot` の `[ARCH]` タスクや実装バッチを含む）のタスクでも実行ワーカーの `sessionId`・`state.db`（全プロファイル DB 横断解決）を辿ってトランスクリプトを返せるようにする。
     3. `ReviewPane.jsx` の `<WorkerFeed>` を共通利用できるようエクスポートし、`TasksPane.jsx` のタスク詳細シート（イベントタイムライン直前）へ組み込む。

---

## 2. 合意決定表（D38〜D40）

| ID | 論点 | 採用方針 |
| :--- | :--- | :--- |
| **D38** | Quick Review の `mode=sheet` 判定不一致とシート表示 | フロント側は `mode === 'annotation'` 以外で `/api/review/:id/data` を取得し、`<StandardForm>`・`⚡ 推奨案で一括承認`・完了後の回答履歴を復活させる（`ItemRow` の不要な `sheet` チップは非表示）。取得中の瞬間的な `<IframeForm>` チラつきを防ぐため `dataLoading` 状態を持つ。ブリッジ側は `exists: Boolean(sheetAbs \|\| dataAbs)` とし、`sheetHtml(id)` は `.html` 不在時に `.json` から安全なスタンドアロン HTML を動的生成して返す。 |
| **D39** | Hermes Native `spec-architect` / `quick-review` Round 1 の高速化 | `buildSeedPrompt`・`buildArchitectTaskBody`・`skills/spec-architect/SKILL.md`・`skills/quick-review/SKILL.md` を JSON ファースト（`review/sheets/<label>-<round>.json` 主体、`mode=standard`）に更新する。`browser_exec` によるモック撮影・独自 `.html` 作成は UI 見た目比較が必須な場合のみ任意とし、通常の仕様策定 Round 1 を 1〜2 分台へ短縮する。 |
| **D40** | タスク詳細シートの `heartbeat` 折りたたみとライブ進捗表示 | `apps/web/src/lib/tasksView.js` の `collapseTaskEvents()` で連続 `heartbeat` を 1 行（回数・最新時刻）にまとめる。ブリッジ側に全ボード／全プロファイル対応の `GET /api/boards/:slug/tasks/:id/worker` を追加（既存の `/api/review/:id/worker` も全プロファイル `state.db` フォールバックを共有）。`TasksPane.jsx` 詳細シートに `<WorkerFeed>` を統合し、`running` 中は 5 秒ごとに最新ステップを表示する。 |

---

## 3. 詳細技術仕様

### 3.1 Quick Review ドロワー統合フォーム復旧と JSON→HTML フォールバック（D38）

1. **判定ロジックの切り出しと統一（`apps/web/src/lib/reviewView.js`・`apps/web/src/features/ReviewPane.jsx`）**:
   - `apps/web/src/lib/reviewView.js` に以下の純粋関数を追加する（`review-view.test.js` で単体テスト可能にする）:
     - `shouldFetchSheetData(review)`: `review?.mode === 'annotation'` のとき `false`、それ以外（`'standard'`・`'sheet'`・未指定）は `true` を返す。ただし `review?.sheet` も `review?.mode` も無い純画像タスク等への不要呼び出しを避けたい場合でも、`sheet` があるか `mode !== 'annotation'` であれば `true` とする（`openItem` の既存エラーハンドリングが非待ち状態の 409/404 を黙殺するため安全）。
     - `shouldShowModeChip(mode)`: `'annotation'` 等、`'standard'`・`'sheet'` 以外の特殊モードのときのみ `true` を返す（一覧行の不要な `sheet` バッジを抑止）。
   - `apps/web/src/features/ReviewPane.jsx`:
     - `openItem`（L891-L909）の `if (ak.mode && ak.mode !== 'standard') return` を `if (!shouldFetchSheetData(ak)) return` に置換する。
     - `dataLoading`（boolean）状態を追加し、`openItem` の `/api/review/${item.id}/data` 取得開始で `true`、`finally` で `false` に戻す。`dataLoading` 中かつ `!data` の間は `<Loader label={t('common.loading')} />` を出し、取得完了後に `data?.questions?.length` なら `<StandardForm>`、設問 JSON が無い素の HTML シートのときのみ `<IframeForm>` を描画する。
     - `ItemRow`（L109）を `{shouldShowModeChip(ak.mode) ? <span>{ak.mode}</span> : null}` に変更する。

2. **JSON 主体タスク対応と HTML 動的フォールバック（`apps/bridge/src/review.js`）**:
   - **一覧 `exists` 判定（L597）**: `exists: Boolean(sheetAbs || dataAbs)` とし、`.json` のみ生成されたレビュータスクでも `exists: true` になるようにする。
   - **JSON→HTML フォールバック生成 `renderSheetHtmlFromData(data, ak)`**:
     - `sheetHtml(id)`（L609-L617）で `resolveInside(ak.sheet)` が `null` の場合、`sheetPaths(ak.sheet).dataRel` の `.json` を探して読み取り、`data` が有効なら `renderSheetHtmlFromData(data, ak)` で完結したスタンドアロン HTML（文字コード UTF-8、モバイル幅レスポンシブ CSS、推奨バッジ、各設問・選択肢の要約、および `[Review Answer]` 生成／親ウィンドウ連携用の最小フォームまたは閲覧ビュー）を生成して返す。
     - XSS 対策として JSON 由来の文字列（`title`, `topic`, `label`, 設問文, 選択肢 `id`/`label`/`detail` 等）はすべて HTML エスケープ（`&`, `<`, `>`, `"`, `'`）する。
     - `.html` ファイルが実際に存在する場合は従来どおり `.html` をそのまま返す（後方互換維持）。

### 3.2 Hermes Native 仕様策定（Round 1）の JSON ファースト高速化（D39）

1. **`apps/bridge/src/architect.js` のプロンプト改善**:
   - `buildSeedPrompt`（L269-L309）の Round 1 指示を見直し、既存テストの検証正規表現（`spec-architect` / `Round 1` / `review/sheets/` / `Execution Mode` / `Zero-Stop | Fast-Track Review | Visual Gate` / `Do not file anything yet` / `file the batches automatically`）を維持しつつ、次の点を明確化する:
     - 主成果物は構造化 JSON `review/sheets/spec-<slug>-1.json`（各問 `recommended: true` 付き、2〜5問）であり、`[review]` タスク行は `mode=standard sheet=sheets/spec-<slug>-1.json` を基本とする。
     - 手書きの `.html` シート作成およびヘッドレスブラウザ（`browser_exec` 等）によるモック画像撮影は**必須ではない**（視覚的 UI レイアウト比較が主題で、言葉・構成だけでは判断できないときのみ例外的に使用する）。
   - `buildArchitectTaskBody`（L165-L185）の Round 1 行も同様に JSON ファースト（`write the Quick Review JSON sheet under review/sheets/ (skip bespoke HTML and browser mockups unless visual UI layout comparison is the core question)`）へ合わせる。

2. **バンドルスキルの更新（`skills/spec-architect/SKILL.md`・`skills/quick-review/SKILL.md`）**:
   - **`skills/spec-architect/SKILL.md`**:
     - Round 1 テンプレートの `[review]` 行を `mode=standard sheet=sheets/spec-<slug>-1.json`（`.json` だけでも PWA ネイティブフォームと「シート全体を開く ↗」の両方が動く旨を明記）へ更新する。
     - 「見た目の論点は両案を絵にする / 現行 UI を先に撮る」の必須ルールを「視覚的レイアウト・配色・情報密度の比較そのものが論点である場合のみに限定し、仕様・ロジック・文字列・API・データ設計の質問では `browser_exec` の起動や長大な手書き HTML の生成を行わず `.json` のみ出力して即座にブロックする」へ改める。
     - 1 つの軽量な種に対して過度なコード探索・モック構築を行わず、該当箇所の根拠（ファイルパス＋行数／最小確認）だけ確認したら速やかに Round 1 シートを出して人間の判断へ渡す指針を明記する。
   - **`skills/quick-review/SKILL.md`**:
     - 構造化シートの既定フォーマットとして `sheets/<label>-<round>.json`＋`mode=standard` を第一推奨とし、`.html` は「複数タブ比較や図解・スクショ並べが不可欠なときのみ」任意とする。
     - 既存の `mode=sheet` で `.html` を書く手順は「レガシー／カスタム HTML 拡張」として後方互換の位置づけに整理し、PWA 側はどちらの `mode` でも `.json` さえあれば `<StandardForm>` で回答できる前提に揃える。

### 3.3 タスク詳細シートの `heartbeat` 折りたたみとライブ進捗表示（D40）

1. **連続 `heartbeat` の折りたたみ純粋関数（`apps/web/src/lib/tasksView.js`）**:
   - `collapseTaskEvents(events)` を新規モジュール `apps/web/src/lib/tasksView.js` として作成する。
   - 入力は `detail.events`（降順＝最新が先頭、各要素 `{ kind, at, payload }`）。
   - **仕様**:
     - `events` を先頭から走査し、隣接する `e.kind === 'heartbeat'` を 1 つのエントリ `{ kind: 'heartbeat', at: newestAt, firstAt: oldestAt, count }` にまとめる（間に `worker_bound` 等別イベントが挟まったら別グループとして独立させる）。
     - `heartbeat` 以外のイベントはそのまま `{ ...e, count: 1 }` として保持する。
     - `count > 1` の `heartbeat` グループについて、UI 上は回数バッジ（例: `heartbeat ×8`）と最新時刻（必要に応じ範囲表示用の `firstAt`）が分かる形で描画できるようにする。
   - i18n キー（`apps/web/src/i18n/ja.json`・`apps/web/src/i18n/en.json`）に以下を追加し、ハードコード日本語を避ける:
     - `tasks.heartbeatCount`: JA `"{kind} ×{count}"` / EN `"{kind} ×{count}"`
     - `tasks.heartbeatRange`: JA `"最新 {latest} ・ 開始 {first}"` / EN `"latest {latest} · since {first}"`

2. **全ボード・全プロファイル対応のワーカー進捗取得（`apps/bridge/src/kanban.js`・`apps/bridge/src/review.js`・`apps/bridge/src/server.js`）**:
   - **`apps/bridge/src/kanban.js`**:
     - `resolveSessionInfo(db, row, taskId)` ヘルパーを用意し、`row?.session_id` と `task_events`（`owner_admitted` / `worker_bound` / `spawned` の `payload.session_id`・`payload.db`）の両方を参照して `{ sessionId, db }` を組み立てる（`row.session_id` がある場合でも `task_events` から `db` が拾えれば補完する）。
     - `task(slug, id)` の返却オブジェクトに `sessionId: info?.sessionId ?? null` を追加する。
     - `taskSession(slug, id)` メソッドを公開し、`{ sessionId, status: row.status, db: info?.db ?? null }`（タスク未存在時は `null`）を返す。
   - **`apps/bridge/src/review.js`**:
     - `sessionId(id)`（L498-L530）でも `r?.session_id` が存在する場合に即 `return` せず、`task_events` から `db` が取れる場合は `{ sessionId: String(r.session_id), status: r.status, db }` を返すように補強する。
   - **`apps/bridge/src/server.js`**:
     - `readWorkerFeed(sessionInfo, { limit })` 共通ヘルパーを作成する。解決順序:
       1. `sessionInfo.db` が指定されていればそれを先頭に、続いて `await listStateDbs()`（`profiles/mobile/state.db` や `default` の `state.db` など重複除去した全 DB パス）の候補リストを作る。
       2. 各候補 DB に対して `transcript.read(sessionInfo.sessionId, { dbPath, limit, includeTools: true })` を順に試し、`ok && messages.length > 0` が返った最初の結果を返す（すべて空なら最初の `ok: true` の空結果を返す）。
     - 既存の `GET /api/review/:id/worker` と、新設の **`GET /api/boards/:slug/tasks/:id/worker`** の両方がこの共通ヘルパーを呼ぶ（ルート順は `b && c === 'tasks' && d && e === 'worker'` を `b && c === 'tasks' && d` より前に置くこと）。セッション未割当時は `404 NO_SESSION` を返す。

3. **タスク詳細シートへの `<WorkerFeed>` 組み込みとライブ更新（`apps/web/src/features/ReviewPane.jsx`・`apps/web/src/features/TasksPane.jsx`・`apps/web/src/demo/mockApi.js`）**:
   - `ReviewPane.jsx` の `WorkerFeed`（L130）を `export function WorkerFeed({ taskId, open = false, endpoint = null })` に変更し、`endpoint || '/api/review/' + encodeURIComponent(taskId) + '/worker?limit=30'` を叩くようにする（既存の ReviewPane 呼び出しはそのまま後方互換）。
   - `TasksPane.jsx`:
     - `WorkerFeed` と `collapseTaskEvents` を import する。
     - `detailBody` 内、イベントセクション（L948）の直前に、`detail.sessionId` がある場合 `<WorkerFeed taskId={detail.id} open={detail.status === 'running'} endpoint={`/api/boards/${encodeURIComponent(board)}/tasks/${encodeURIComponent(detail.id)}/worker?limit=30`} />` を描画する。
     - `detailBody` のタイムライン（L951-L962）では `collapseTaskEvents(detail.events ?? [])` をマップし、`count > 1` の `heartbeat` グループは `t('tasks.heartbeatCount', { kind: e.kind, count: e.count })` と `t('tasks.heartbeatRange', ...)` で 1 行表示にする。
     - `detail` が開かれていて `detail.status === 'running' || detail.status === 'ready'` の間、バックグラウンドの 5〜10 秒ポーリングまたは `detail` 表示中タイマーで詳細を再取得しておくと、`ready` → `running` で `sessionId` が付与された瞬間や完了時にも詳細シートが自動更新される。
   - **Interactive Demo 同期（`apps/web/src/demo/mockApi.js`）**:
     - `route()` で `/api/boards/:slug/tasks/:id/worker` を認識して `board.task.worker` ケースへ通し、`case 'review.worker'` と共通のデモワーカーフィード（`tool` / `assistant` ステップ列）を返す。
     - デモタスクの `sessionId` および複数連続 `heartbeat` イベントを持たせ、デモ環境でも V8 の見た目・動作が検証できるようにする。

---

## 4. 実装バッチ構成（Spec Launchpad 用）

### Batch V8-B1: Quick Review ドロワー統合フォーム（StandardForm）復旧と JSON フォールバック HTML
- **Execution Mode**: [Mode: Zero-Stop]
- **目的**: `mode=sheet` で起票された全 Quick Review / Spec Seed タスクで、生の HTML 埋め込み（`<IframeForm>`）ではなくドロワー統合の簡易回答フォーム（`<StandardForm>`）・推奨案一括承認・完了後回答履歴が正常表示されるようにし、あわせて `.html` 不在時も `.json` から HTML シートを動的生成できるようにする。
- **変更・新規ファイル**:
  - `apps/web/src/lib/reviewView.js`
  - `apps/web/src/features/ReviewPane.jsx`
  - `apps/bridge/src/review.js`
  - `apps/web/test/review-view.test.js`
  - `apps/bridge/test/review.test.js`
- **実装詳細**:
  - `apps/web/src/lib/reviewView.js` に `shouldFetchSheetData(review)`（`review?.mode !== 'annotation'` で `true`）と `shouldShowModeChip(mode)`（`mode && mode !== 'standard' && mode !== 'sheet'` で `true`）を追加する。
  - `apps/web/src/features/ReviewPane.jsx` の `openItem`（L898）で `if (!shouldFetchSheetData(ak)) return` を用い、`dataLoading` 状態を追加して `.json` 取得中の `<IframeForm>` チラつきを防ぐ。`ItemRow`（L109）も `shouldShowModeChip(ak.mode)` に変更する。
  - `apps/bridge/src/review.js` の `list()`（L597）で `exists: Boolean(sheetAbs || dataAbs)` とし、`renderSheetHtmlFromData(data, ak)`（全文字列 HTML エスケープ必須）を実装して `sheetHtml(id)` が `.html` 不在かつ `.json` 存在時に動的生成 HTML を返すようにする。
  - `apps/web/test/review-view.test.js` と `apps/bridge/test/review.test.js` に、①`mode: 'sheet'` で `shouldFetchSheetData` が `true`・`'annotation'` で `false` となること、②`.json` のみ存在・`.html` 不在のタスクで `list()` が `exists: true` となり `sheetHtml(id)` がエスケープ済み HTML を返すこと、のテストを追加する。
- **受入条件（Verify）**:
  - `node --test apps/web/test/review-view.test.js apps/bridge/test/review.test.js` が全件パスすること
  - `npm test` および `npm run build` が成功すること

### Batch V8-B2: Hermes Native 仕様策定（spec-architect Round 1）の JSON ファースト高速化
- **Execution Mode**: [Mode: Zero-Stop]
- **目的**: 仕様策定ボタン（`Hermes Native`）の Round 1 で不要な 300 行級手書き HTML 生成とヘッドレスブラウザ（`browser_exec`）によるモック画像撮影を省略し、構造化 `.json`（`mode=standard`）主体の高速フローにしてインタビュー到達までの待ち時間を大幅に短縮する。
- **変更・新規ファイル**:
  - `apps/bridge/src/architect.js`
  - `skills/spec-architect/SKILL.md`
  - `skills/quick-review/SKILL.md`
  - `apps/bridge/test/architect.test.js`
- **実装詳細**:
  - `apps/bridge/src/architect.js` の `buildSeedPrompt`・`buildArchitectTaskBody` を更新し、Round 1 では `review/sheets/spec-<slug>-1.json` を生成して `mode=standard sheet=sheets/spec-<slug>-1.json` で `[review]` タスクを起票すること、および視覚的な UI レイアウト比較が主題でない限り手書き HTML とヘッドレスブラウザ撮影を行わないことを明記する（既存の `architect.test.js` 正規表現要件はすべて維持する）。
  - `skills/spec-architect/SKILL.md`（Round 1 手順・L43・L58 等）と `skills/quick-review/SKILL.md`（L107・L114・L157 等）を更新し、`.json`＋`mode=standard` を第一推奨、`.html` や `browser_exec` 撮影を「見た目の比較そのものが論点の場合のみ任意」と定義し直す。
  - `apps/bridge/test/architect.test.js` に、`buildSeedPrompt` / `buildArchitectTaskBody` が JSON ファーストかつ不要なブラウザ撮影・HTML 生成を抑制する指示を含みつつ既存契約を維持することを確認するテストを追加する。
- **受入条件（Verify）**:
  - `node --test apps/bridge/test/architect.test.js apps/bridge/test/pipelineOptimizer.test.js` が全件パスすること
  - `npm test` が全件パスすること

### Batch V8-B3: タスク詳細シートの heartbeat 折りたたみと WorkerFeed ライブ進捗統合
- **Execution Mode**: [Mode: Zero-Stop]
- **目的**: タスク詳細シートで連続する `heartbeat` を 1 行に折りたたみ、さらに `[ARCH]` や各バッチなど任意のボードの実行中タスクでもワーカーのリアルタイムツール実行・思考フィード（`<WorkerFeed>`）を確認できるようにする。
- **変更・新規ファイル**:
  - `apps/bridge/src/kanban.js`
  - `apps/bridge/src/review.js`
  - `apps/bridge/src/server.js`
  - `apps/web/src/lib/tasksView.js`
  - `apps/web/src/features/ReviewPane.jsx`
  - `apps/web/src/features/TasksPane.jsx`
  - `apps/web/src/i18n/ja.json`
  - `apps/web/src/i18n/en.json`
  - `apps/web/src/demo/mockApi.js`
  - `apps/web/test/tasksView.test.js`
  - `apps/bridge/test/review.test.js`
- **実装詳細**:
  - `apps/bridge/src/kanban.js`: `tasks.session_id` と `task_events`（`owner_admitted` / `worker_bound` / `spawned`）から `{ sessionId, db }` を引く `resolveSessionInfo` を実装し、`task(slug, id)` に `sessionId` を含めるとともに `taskSession(slug, id)` を公開する。
  - `apps/bridge/src/review.js`: `sessionId(id)` で `r?.session_id` がある場合も `task_events` の `db` 情報を補完する。
  - `apps/bridge/src/server.js`: `GET /api/review/:id/worker` と新設 `GET /api/boards/:slug/tasks/:id/worker` が共通ヘルパー `readWorkerFeed` を呼び、`info.db` 優先＋`listStateDbs()` 横断検索（`messages.length > 0` が見つかった DB を採用）でトランスクリプトを返すようにする。
  - `apps/web/src/lib/tasksView.js`: 純粋関数 `collapseTaskEvents(events)` を実装し、連続する `kind === 'heartbeat'` を `{ kind: 'heartbeat', count, at: newestAt, firstAt: oldestAt }` の 1 件へまとめる（別種イベントを跨いで合算しない）。
  - `apps/web/src/features/ReviewPane.jsx`: `WorkerFeed` を名前付きエクスポート（`export function WorkerFeed({ taskId, open = false, endpoint = null })`）に変更し、`endpoint` 差し替えを可能にする。
  - `apps/web/src/features/TasksPane.jsx`: `detail.sessionId` がある場合に `<WorkerFeed>` を詳細シートへ表示し、`detail.status === 'running' || detail.status === 'ready'` の間は詳細を再同期する。タイムライン描画は `collapseTaskEvents(detail.events ?? [])` を使い、`tasks.heartbeatCount` / `tasks.heartbeatRange`（`ja.json`・`en.json` に両定義）でレンダリングする。
  - `apps/web/src/demo/mockApi.js`: `/api/boards/:slug/tasks/:id/worker` と連続 `heartbeat`・`sessionId` デモデータを同期する。
  - `apps/web/test/tasksView.test.js`（`collapseTaskEvents` の連続・分断・空配列テスト）および `apps/bridge/test/review.test.js`（`db` 補完・マルチプロファイル検索テスト）を追加する。
- **受入条件（Verify）**:
  - `node --test apps/web/test/tasksView.test.js apps/bridge/test/review.test.js apps/web/test/i18n.test.js apps/web/test/i18nLeak.test.js apps/web/test/noHardcodedJapanese.test.js` が全件パスすること
  - `npm test` が全件パスすること

### Batch V8-B4: 全体統合検証・デモ同期・ビルド＆デプロイ確認
- **Execution Mode**: [Mode: Zero-Stop]
- **目的**: V8 全バッチの変更（Bridge・Web PWA・Skills・i18n・Interactive Demo）を通しで検証し、本番ビルド・レスポンシブ監査・デモビルドまで完了して再デプロイ可能な状態にする。
- **変更・新規ファイル**:
  - （必要に応じた結合微調整・ビルド成果物検証のみ）
- **実装詳細**:
  - 全自動テストスイート、PWA チェック、OAuth 境界チェック、本番ビルド、レスポンシブ監査、デモビルドを一括実行し、エラー・警告ゼロを確認する。
  - 実行後に `npm run deploy` を実行し（またはデプロイ可能状態を確認し）、実機ブラウザ／PWA での反映準備を整える。
- **受入条件（Verify）**:
  - `npm run verify`（`npm test && npm run check:pwa && npm run check:oauth && npm run build && npm run audit:responsive`）が終了コード 0 で完了すること
  - `npm run build:demo` が終了コード 0 で完了すること
