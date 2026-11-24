# SPEC: 整合性監査 2 周目 — ガードの視野（同期・payload・遷移・ブリッジ中継）を広げる (`SPEC-COHERENCE-RESIDUAL-DRIFT`)

- **Status**: archived
- **状態**: 完了・アーカイブ済み（2026-11-25・Batch `DRF-1` 〜 `DRF-5` 全件完了 @ `cd173ed`）
- **決定の出所**: `~/.hermes/plugin-data/hermes-pilot/review/sheets/spec-coherence-residual-drift-1.answer.json`（4 問・選択 4 / お任せ 0）
- **前提仕様**: [SPEC-COHERENCE.md](./SPEC-COHERENCE.md) / [SPEC-coherence-audit-2.md](./SPEC-coherence-audit-2.md)（D101〜D105） / [SPEC-spec-execution-mode-mode-zer.md](./SPEC-spec-execution-mode-mode-zer.md)（D96〜D100） / [SPEC-RELIABILITY-GUARD.md](./SPEC-RELIABILITY-GUARD.md) / [SPEC-EN-ZERO-LEAK.md](./SPEC-EN-ZERO-LEAK.md)
- **対象リポジトリ**: `hermes-mobile-pwa`（プラグイン名: `hermes-pilot` / `Hermes Pilot`）
- **全バッチ共通の完了条件**:
  - `npm run verify`（`npm test` / `check:dashboard` / `check:pwa` / `check:oauth` / `build` / `audit:responsive` / `check:term-enter` / `check:coherence` / `check:cold-install` の全ゲート）が **exit 0**
  - **検出 0 を「直った」と書かない**: ガードを広げるバッチ（`DRF-2` / `DRF-3` / `DRF-4` / `DRF-5`）は、同じバッチ内で「わざと壊した入力で新ルールが RED になる」対照実験をテストに固定する
  - 外部 AI CLI のサブプロセス起動禁止（`check:oauth` 通過）・D55 非干渉原則（Hermes 本体のカンバン DB / cron DB への**書き込み禁止**・ユーザー承認なき自動タスク起票禁止）を遵守する
  - `SPEC-EN-ZERO-LEAK` 遵守（CLI / Bridge のログ・エラー `reason` は英語単一言語。Web UI の追加文言は `en.json` / `ja.json` 同時追加・英語辞書の CJK / 全角記号ゼロ）
  - `themeTokens.test.js` 遵守（JSX inline style およびコンポーネント CSS への色直書き禁止・テーマトークンのみ）
  - 行番号は **2026-11-24 時点の実測**。実装時は行番号ではなくシンボル名（`SYNC_TOPICS` / `createSyncScheduler` / `syncOwnerProblems` / `HM_EVENT_META` / `requiredKeys` / `TRANSITION_TABLE` / `apply` / `boardTick` / `createReviewWatcher`）で探すこと

---

## 1. 背景 — 「検出 0」の正体（実測 2026-11-24）

1 周目（`SEMM-1`〜`SEMM-5`）で接続状態・定期同期・イベント payload・タスク遷移の「正本」は作られ、`npm run check:coherence` は 0 hard / 0 soft で通っている。しかし 4 つのガードはいずれも**視野が実装より狭い**ため、正本の外側に残った写経を検出できない。

1. **同期のガードは 1 ファイルだけ**: `SYNC_OWNER_FILES = ['apps/web/src/App.jsx']`（`scripts/check-coherence.mjs`）。一方 `apps/web/src` の `setInterval(` は **18 箇所**（うち 1 秒時計 2 本: `ChatPane` の nowTick と `ArchitectJobBar` の now）。データ取得のタイマーは **16 本**で、`TasksPane.jsx` に 8 本（5 秒 tasks / 10 秒 live / 15 秒 inbox / 30 秒 reports / 60 秒 specs / 120 秒 coherence / 4〜20 秒 architectJobs / 5 秒 boards 再試行）が残る。同じ URL を 2 系統が叩いている実例: `/api/inbox` は `App.jsx` の `syncInbox`（15 秒）と `TasksPane` の `loadInbox`（15 秒）、`/api/live` は `App.jsx` の `syncLive`（15 秒）・`TasksPane`（10 秒）・`LiveSheet`（5 秒）、`/api/review` は `App.jsx` の `syncReviewWaiting`（15 秒）と `ReviewPane` の `load`（15 秒）。
2. **payload のガードは 26 分の 1**: `HM_EVENT_META` は 26 件、うち `required` の宣言は `LIVE_TURNS` の 1 件だけ（`detail` がオブジェクトのイベント 20 件・`null` 6 件）。`apps/web/test/contracts.test.js` の「required の無いイベントは従来どおり素通りする」が `requiredKeys(WAKE_SYNC) === []` を**仕様として固定**しているため、残り 19 件の payload 欠落は機械では止まらない。
3. **遷移のガードは 2 動詞だけ**: `TRANSITION_TABLE` は 8 遷移（approve / answer.fresh / answer.again / annotation.fresh / annotation.again / close.done / close.cancel / unblock）で、`reopen` が無い。`apps/bridge/src/review.js` の `reopen()` は `runKanban(['request-changes', …])` を直接呼び、ガードの対象動詞は `unblock` / `complete` の 2 語（`scripts/lib/coherence-guards.mjs` の `TRANSITION_VERBS`）。`apps/bridge/test/transitions.test.js` は表のキーを**完全一致**で固定しているので、追加は RED として現れる（＝直す順序が決まっている）。
4. **ブリッジ中継は同じ DB を 2 本で走査**: `createReviewWatcher` と `createPipelineWatcher` が同じ `dbPaths()` の写経を持ち、どちらも `intervalMs` 既定 10,000 で、同じ `kanban/boards/<slug>/kanban.db` を `readOnly` で開く。`readTasks()` の SQL だけが違う（review は `body LIKE '%[review]%'` の 500 件、pipeline は非 archived の 300 件）。「変わった」の判定は watcher ごとに別実装で、同じタスクの完了を 2 つの報告経路が別々に解釈している。

---

## 2. 合意決定表（D106〜D110）

| ID | 決定事項 |
| :--- | :--- |
| **D106** | **同期は「1 トピック 1 取得・購読者へ配る」**: `lib/syncScheduler.js` の表 `SYNC_TOPICS` が間隔・停止規則を持ち、**取得関数も 1 トピック 1 本**（`sources`）にする。購読者が 2 つでも fetch は 1 回。ペインは `setInterval` を 0 にし、マウント中だけ `subscribe(topic, fn)` する。`enabledWhen`（状況で走らせない）と `everyMsOf`（状況で間隔を変える）を表の列に足す。**1 秒時計（`setInterval(fn, 1000)` かつ `fn` が `Date.now()` を読む）だけ**は引き続き各コンポーネントに置いてよい。 |
| **D107** | **同期ガードの視野は `apps/web/src/**`**: `sync-owner` の対象を `SYNC_SCOPE_DIRS = ['apps/web/src']`（除外は `lib/syncScheduler.js` と `lib/syncSources.js`）へ広げる。例外は**ファイル許可リストではなく共通規則**で判定する（`setInterval` の間隔引数が `1000` かつコールバック本文に `Date.now(` を含むときだけ時計として許可）。 |
| **D108** | **payload のガードは全件**: `detail` が `{` で始まる 20 イベントすべてに `required` を宣言し、`contracts.test.js` を「オブジェクト detail に `required` が無ければ RED」へ反転する。`required` は宣言済み `detail` の部分集合であること（既存の検証）と、送信リテラルに全キーが存在すること（既存の静的走査）を全件に適用する。 |
| **D109** | **遷移表に `reopen` を足し、ガードの動詞を 4 語へ**: `TRANSITION_TABLE.reopen = { from: '*', noop: ['archived'], kind: 'request-changes' }`、`apply()` に `kind: 'request-changes'`（1 回だけ・`moved: 'review'`）、`review.js` の `reopen()` は `transitions.apply('reopen', …)` へ。`TRANSITION_VERBS` を `unblock` / `complete` / `request-changes` / `archive` に広げ、`transition-owner` が `runKanban(['request-changes'` も検出する。 |
| **D110** | **盤面走査は 1 本（`apps/bridge/src/board-tick.js`）**: 全ボードの `kanban.db` を 1 回だけ読み（`readOnly`）、行の和集合（`id, title, body, status, result, created_at, started_at, completed_at, session_id`）と**差分**（`[{ id, board, from, to }]`・新規は `from: null`・消滅は `to: null`）を購読者へ配る。`createReviewWatcher` / `createPipelineWatcher` は自前のタイマーと DB 走査を捨て、`boardTick.subscribe(fn)` の購読者になる（1 ティック 1 スナップショット・2 報告が同じ根拠を見る）。ガード `board-tick-owner` を足す（`*-watcher.js` に `setInterval(` / `new DatabaseSync(` が 0）。 |

**採らなかった案（証跡）**: Q1-B（数値だけ表へ寄せると停止規則を書く場所が残り、今回見つけた穴の種類が残る）／Q1-C（可視化のみは二重取得を直さない）／Q2-B（`detail` 文字列のパースは省略記法・ネストで静かに壊れる）／Q2-C（前方のみは既存 19 件の欠落が残る）／Q3-B（ガードだけ広げると「表が正本」の例外が 1 つ残る）／Q3-C（再開系の判断が呼び出し側に戻る）／Q4-B（述語の共通化だけでは走査が 2 倍のまま）／Q4-C（二重走査と判定の分散が残る）。

---

## 3. 正本の設計（実装前に読む 1 ページ）

### 3.1 `lib/syncScheduler.js` v2 と `lib/syncSources.js`（D106）

```js
// lib/syncScheduler.js — 純粋（fetch を持たない）。テストは時計を注入する。
export const CLOCK_INTERVAL_MS = 1000
export const SYNC_TOPICS = [
  { id: 'overview',     everyMs: 5_000 },                                  // 接続状態・稼働数（App）
  { id: 'reports',      everyMs: 15_000 },                                 // 完了報告（App）
  { id: 'reviewWaiting', everyMs: 15_000, pauseOnTabs: ['review'] },       // App + ReviewPane
  { id: 'reviewFeed',   everyMs: 15_000, pauseOnTabs: ['review'] },        // App + ReviewPane
  { id: 'usage',        everyMs: 60_000 },                                 // App
  { id: 'inbox',        everyMs: 15_000 },                                 // TasksPane + InboxSheet
  { id: 'live',         everyMs: 5_000 },                                  // TasksPane + LiveSheet
  { id: 'tasks',        everyMs: 5_000 },                                  // TasksPane
  { id: 'boards',       everyMs: 5_000,  enabledWhen: (s) => s.boardsFailed },     // TasksPane
  { id: 'specs',        everyMs: 60_000 },                                 // TasksPane
  { id: 'coherence',    everyMs: 120_000, enabledWhen: (s) => !s.workActive },     // TasksPane
  { id: 'specReports',  everyMs: 30_000 },                                 // TasksPane
  { id: 'architectJobs', everyMsOf: (s) => (s.architectBusy ? 4_000 : 20_000) },   // TasksPane + ChatPane
  { id: 'workerFeed',   everyMs: 4_000 },                                  // ChatPane
  { id: 'taskDetail',   everyMs: 5_000, enabledWhen: (s) => s.detailActive },      // TaskDetailSheet
  { id: 'reviewDetail', everyMs: 5_000 },                                  // ReviewPane（シートが開いている間だけ購読）
]

export function shouldRun(topic, { tab = null, visible = true, now = 0, state = {} } = {})
export function createSyncScheduler({ topics = SYNC_TOPICS, sources = {}, isVisible, currentTab, now, setIntervalFn, clearIntervalFn } = {})
//   sources: { [topicId]: () => Promise<any> }  — 1 トピック 1 取得（重複登録は throw）
//   subscribe(id, fn) -> off   // fn(value, { error, at }) を 1 tick 1 回
//   tick(id) -> Promise<{ ran, ok, value }>   // 取得は 1 回。購読者が 0 なら ran=false
//   forceAll({ skip }) / wake({ skip, minGapMs }) / tickVisible() / start() / stop()
```

- **1 トピック 1 取得**: `run(id)` は `sources[id]` を 1 回 await し、結果を購読者全員へ配る。これが無いと「購読 2 本 = 取得 2 回」で二重取得が戻る（今回の穴そのもの）。
- **`enabledWhen(state)`** は「状況で走らせない」だけを担う（破棄せず skip）。`state` はホストが `scheduler.setState({...})` で更新する（`boardsFailed` / `workActive` / `architectBusy` / `detailActive`）。
- **`everyMsOf(state)`** は adaptive 間隔。tick のたびに値を比べ、変わったときだけ張り直す（毎 tick 張り直すと位相がリセットされる）。
- **`pauseOnTabs` は残す**のはタブ跨ぎの重複を避けるため（ReviewPane が開いている間は App の `reviewWaiting` を止める）。ペイン自身の購読は「マウント中だけ」が停止規則なので二重停止を作らない。
- `lib/syncSources.js` は topic → 取得関数の唯一の置き場。`App.jsx` と各ペインは `api()` を直接「定期」には呼ばない（単発操作の呼び出しは対象外）。

**旧タイマー → トピックの対応（16 本すべて）**:

| 旧 | 旧の間隔 | 新 |
| :--- | :--- | :--- |
| `TasksPane` tasks（`loadTasks(board)`） | 5 秒 | `tasks` |
| `TasksPane` boards 再試行 | 5 秒（失敗時のみ） | `boards` + `enabledWhen` |
| `TasksPane` live（`/api/live`） | 10 秒 | `live`（5 秒へ統一） |
| `TasksPane` inbox（`loadInbox`） | 15 秒 | `inbox` |
| `TasksPane` specs | 60 秒 | `specs` |
| `TasksPane` coherence | 120 秒（作業中は skip） | `coherence` + `enabledWhen` |
| `TasksPane` reports（`/api/specs/reports`） | 30 秒 | `specReports` |
| `TasksPane` architectJobs | 4 秒 / 20 秒 | `architectJobs`（`everyMsOf`） |
| `ChatPane` specJobs | `jobPollMs` | `architectJobs` |
| `ChatPane` workerFeed | 4 秒 | `workerFeed` |
| `InboxSheet` | 15 秒 | `inbox` |
| `LiveSheet` | 5 秒 | `live` |
| `ReviewPane` 一覧 `load` | 15 秒 | `reviewWaiting` |
| `ReviewPane` feed | 15 秒 | `reviewFeed` |
| `ReviewPane` 進行中詳細 | 5 秒（開いている間） | `reviewDetail` |
| `TaskDetailSheet` 詳細 | 5 秒（running / ready のみ） | `taskDetail` + `enabledWhen` |

`App.jsx` の `syncInbox` / `syncLive` は**削除**する（バッジは `INBOX_ITEMS` / `LIVE_TURNS` イベントで既に届く）。残る `setInterval` は `ChatPane` の nowTick と `ArchitectJobBar` の now の 2 本だけ（どちらも 1 秒時計）。

### 3.2 `sync-owner` の視野（D107）

- `scripts/check-coherence.mjs`: `SYNC_OWNER_FILES` を `SYNC_SCOPE_DIRS = ['apps/web/src']` + `SYNC_SCOPE_EXCLUDE = ['apps/web/src/lib/syncScheduler.js', 'apps/web/src/lib/syncSources.js']` に置き換え、`walkCode(root, dir)` で列挙する（既存ヘルパを使う）。
- `scripts/lib/coherence-guards.mjs` の `syncOwnerProblems(text)` → `syncScopeProblems(rel, text)`:
  - `setInterval(` ごとに**間隔引数**（最後の引数）と**コールバック本文**を取り、`間隔 === 1000` かつ本文に `Date.now(` があれば時計として通す。
  - それ以外は `reason: 'periodic setInterval in <rel>; declare the topic in lib/syncScheduler.js'`。
  - **ファイル許可リストは作らない**（同じ規則を全ファイルへ）。新しい時計を足すときも同じ条件を満たせば通る。
- `.hermes-coherence.json` の `checkerPending` に `sync-owner` が残っていれば `DRF-2` の完了時に外す（既存の仕組み）。

### 3.3 `required` の全件宣言（D108）

- `apps/web/src/contracts/events.js`: `detail` が `'{'` で始まる 20 件に `required: [...]` を書く（既存 `LIVE_TURNS` の `['turns','items','architect']` を含む）。`detail: null` の 6 件は `required` を持たない。
- `apps/web/test/contracts.test.js`: 「required の無いイベントは従来どおり素通りする」を **「`detail` がオブジェクトなら `required` が必須」** に置き換える（`detail: null` は対象外・`emitHmEvent` の素通り挙動の検証は残す）。
  - 期待: `Object.entries(HM_EVENT_META).filter(([, e]) => String(e.detail).startsWith('{')).every(([, e]) => requiredKeys...)` が全件非空。
  - 対照実験: 1 件の `required` を消すと RED（フィクスチャで固定）。
- 既存の 2 つの検証（`required ⊂ detail` 宣言／送信リテラルに全キーが存在）はそのまま全件に効く。**送信リテラルが見つからないイベントは既に RED**（`detailLiterals` が 1 件も見つけられない場合）なので、宣言を足すと「送っていないイベント」も同時に露見する。露見したものは `emitHmEvent(HM_EVENTS.X, …)` に直すか、イベント自体を `HM_EVENT_META` から落とす（どちらも受入条件に含む）。

### 3.4 `reopen` を表へ（D109）

```js
// apps/bridge/src/review/transitions.js
export const TRANSITION_TABLE = {
  /* …既存 8 遷移… */
  reopen: { from: '*', noop: ['archived'], kind: 'request-changes' },
}

// apply(): kind === 'request-changes'
//   const out = await cli(['request-changes', id, reason || defaultReasonOf(lang)])
//   → { code, out, status: ok ? 'review' : status, moved: ok ? 'review' : null }
```

- `review.js` の `reopen(id, reason, lang)` は `transitions.apply('reopen', { id, reason })` を呼び、戻り値 `{ ok, status, output }` の互換形へ写す（呼び出し側は変えない）。`reopenTextOf(lang)` の既定理由は `apply` に渡す（英語既定・SPEC-EN-ZERO-LEAK）。
- `TRANSITION_VERBS` を `['unblock', 'complete', 'request-changes', 'archive']` に。`transitionOwnerProblems` の `directRe` は既に `archive` を見ているので、`runKanban(['request-changes'` を 4 語目として拾えるようにする。
- `transitions.test.js` のキー完全一致テストを 9 遷移へ更新（`reopen` の `from='*'` / `noop=['archived']` / `kind` を固定）。`review.test.js` の `reopen` ケース（`request-changes` が 1 回だけ・`archived` は CLI 0 回）を追加。

### 3.5 `apps/bridge/src/board-tick.js`（D110）

```js
export const BOARD_TICK_MS = 10_000
export const BOARD_ROW_COLUMNS = ['id','title','body','status','result','created_at','started_at','completed_at','session_id']

export function listBoardDbs(kanbanRoot)            // boards/<slug>/kanban.db（＋ルート kanban.db）。readOnly で開くだけ
export function readBoardSnapshot({ kanbanRoot, limit })   // 1 回の SELECT（非 archived・COALESCE(completed_at, created_at) DESC・limit）
export function diffSnapshots(prev, next)          // [{ id, board, from, to }]（新規 from:null / 消滅 to:null）
export function createBoardTick(cfg = {}, opts = {}) // { everyMs = BOARD_TICK_MS, snapshot(), tick(), subscribe(fn), start(), stop(), status() }
```

- `tick()` は 1 回だけ走査し、`{ at, rows, changes }` を**全購読者へ同期的に**配る（1 本の `setInterval`・`unref()`）。
- `subscribe(fn)` は即時 1 回 `fn(最新スナップショット)` を呼ばない（baseline は watcher 側の状態ファイルが持つ）。
- `createReviewWatcher(cfg, { boardTick })` / `createPipelineWatcher(cfg, { boardTick })` は、`boardTick` が渡されたら `start()` で独自タイマーを張らず `boardTick.subscribe(...)` で `tick()` を呼ぶ。`opts.dbPaths` / `opts.snapshot` の注入は board-tick 側へ移す（テストは `opts.snapshot` でフィクスチャを渡す）。
- `server.js` は両 watcher より先に `const boardTick = createBoardTick(cfg)` を作り、`reviewWatcher` / `pipelineWatcher` へ渡し、`boardTick.start()` は両者の `start()` 後に 1 回だけ呼ぶ。
- 「変わった」の判定は **board-tick の `changes` が唯一の根拠**。watcher 側に残すのは「既に報告したか」の印（`reportedDoneAt` / `knownTaskIds` / `reportedKeys`）だけで、状態の差分判定はしない。
- ガード `board-tick-owner`: `apps/bridge/src/**/*-watcher.js` に `setInterval(` と `new DatabaseSync(` が 0（コメントは無視・`stripComments` 経由）。`readOnly: true` 以外のオープンは既存の `write-owner` 系では拾えないため、`board-tick.js` 以外で `new DatabaseSync(` を検出したら violation（対象は `apps/bridge/src`）。

---

## 4. バッチ

すべて `[Mode: Zero-Stop]`・1 バッチ 1 テーマ。起票順は `DRF-1` → `DRF-2` → `DRF-3` → `DRF-4` → `DRF-5`（`DRF-2` は `DRF-1` の結果＝データ取得タイマー 0 を前提にする。`DRF-3` / `DRF-4` は独立。`DRF-5` は `DRF-4` の後に置くと `transition-owner` の対象が安定する）。**バッチはまだ起票しない**（「File batches & start」待ち）。

### Batch DRF-1: SYNC-PANES — ペインの定期取得を 1 本のスケジューラへ寄せる（D106）

- **Execution Mode**: `[Mode: Zero-Stop]`
- **目的**: 表はあるのに取得が 16 本のタイマーに散っている状態を、`SYNC_TOPICS` の 1 表＋1 本のスケジューラへ寄せる。同じ URL を 2 系統が叩いている実例（`/api/inbox` ×2・`/api/live` ×3・`/api/review` ×2）を、**1 トピック 1 取得**（`sources` を 1 回だけ呼び購読者へ配る）で解消する。
- **変更・新規ファイル**: Changed: `apps/web/src/lib/syncScheduler.js`（`sources` / `enabledWhen` / `everyMsOf` / `setState` / 1 tick 1 取得）、New: `apps/web/src/lib/syncSources.js`、Changed: `apps/web/src/App.jsx`（`syncInbox` / `syncLive` を削除・`setState` の供給）、Changed: `apps/web/src/features/TasksPane.jsx`（8 本のタイマー削除・表の購読へ）、`apps/web/src/features/ReviewPane.jsx`（3 本）、`apps/web/src/features/ChatPane.jsx`（2 本のうち 1 秒時計以外）、`apps/web/src/features/InboxSheet.jsx` / `LiveSheet.jsx` / `apps/web/src/features/tasks/TaskDetailSheet.jsx`（各 1 本）、Changed: `apps/web/test/syncScheduler.test.js`（1 tick 1 取得・`enabledWhen`・`everyMsOf` の張り直し・購読 2 本でも source 1 回）
- **受入条件（Verify）**: `npm run verify` が exit 0。加えて `apps/web/src` の `setInterval(` が **2 箇所だけ**（`ChatPane` の nowTick と `ArchitectJobBar` の now。どちらも `1000` かつ `Date.now(`）、`App.jsx` に `syncInbox` / `syncLive` が無い、`sources` の呼び出し回数が「購読 2 本のとき 1 回」であるテストが緑。
- **非対象**: `sync-owner` の対象拡大（`DRF-2`）。ペインの取得 URL の変更（現行のまま）。復帰時の `wake()` の挙動変更。

### Batch DRF-2: SYNC-SCOPE — 同期ガードを `apps/web/src/**` へ広げる（D107）

- **Execution Mode**: `[Mode: Zero-Stop]`
- **目的**: 「App.jsx だけ見る」ガードを全ソースへ広げ、時計の例外を**共通規則**（1000ms かつ `Date.now()`）で判定する。ペインに新しいタイマーが生えた瞬間に hard fail で止まる状態にする。
- **変更・新規ファイル**: Changed: `scripts/check-coherence.mjs`（`SYNC_SCOPE_DIRS` / `SYNC_SCOPE_EXCLUDE` / `walkCode` での列挙）、Changed: `scripts/lib/coherence-guards.mjs`（`syncScopeProblems(rel, text)`・`CLOCK_INTERVAL_MS`）、Changed: `apps/bridge/test/coherence.rules.test.js`（時計は通る／5 秒取得は落ちる／コメントは無視／`syncScheduler.js` は除外）、Changed: `.hermes-coherence.json`（`checkerPending` から `sync-owner` を外す）
- **受入条件（Verify）**: `npm run verify` が exit 0。`apps/web/src/features/TasksPane.jsx` に `setInterval(() => load(), 5_000)` を一時的に足すと `check:coherence` が **hard fail**（対照実験を `coherence.rules.test.js` に固定）、`ChatPane` の 1 秒時計は通る。`check:coherence` の出力で `sync-owner` の対象ファイル数が 1 → `apps/web/src/**` の実ファイル数になっている。
- **非対象**: 取得 URL の検査（定期取得の URL は `syncSources.js` に集約済みだが、静的検査はしない）。`setTimeout` の自己再帰ポーリング（曖昧さが残るため対象外・§5）。

### Batch DRF-3: PAYLOAD-REQUIRED — オブジェクト detail の全イベントに `required` を宣言（D108）

- **Execution Mode**: `[Mode: Zero-Stop]`
- **目的**: 「宣言なしは素通り」を仕様から外し、payload 欠落をテストで止める。`HM_EVENT_META` の 20 件（`detail` がオブジェクト）に `required` を書き、送信側リテラルと全件突き合わせる。
- **変更・新規ファイル**: Changed: `apps/web/src/contracts/events.js`（20 件の `required`・宣言と送信の不一致があれば送信側を `emitHmEvent` へ寄せる）、Changed: `apps/web/test/contracts.test.js`（「宣言なしは素通り」を「オブジェクト detail は required 必須」へ反転・対照実験 1 件）、Changed: 送信側の該当ファイル（`apps/web/src/features/**` で `new CustomEvent(HM_EVENTS.X, …)` を直接書いている箇所があれば `emitHmEvent` へ）
- **受入条件（Verify）**: `npm run verify` が exit 0。`apps/web/test/contracts.test.js` で「`detail` が `{` で始まる 20 件すべてに `required` がある」「`required` の全キーが送信リテラルに存在する」の 2 つが緑。1 件の `required` を消すフィクスチャで RED（対照実験）。`detail: null` の 6 件は `required` を持たず素通りが維持される。
- **非対象**: イベント名の追加・削除（`HM_EVENTS` の 26 件は変えない。ただし送信リテラルが存在しないイベントは「送る」か「メタから落とす」のどちらかにする）。`emitHmEvent` のシグネチャ変更。

### Batch DRF-4: TRANSITION-REOPEN — `reopen` を遷移表へ入れ、ガードの動詞を 4 語へ（D109）

- **Execution Mode**: `[Mode: Zero-Stop]`
- **目的**: `request-changes` の直叩き（`review.js` の `reopen()`）を表の 1 行へ入れ、「どの遷移がどこで起きるか」を 1 か所で説明できるようにする。ガードの動詞を広げ、同じ型の迂回が機械で止まるようにする。
- **変更・新規ファイル**: Changed: `apps/bridge/src/review/transitions.js`（`reopen` 行・`kind: 'request-changes'` の実行）、Changed: `apps/bridge/src/review.js`（`reopen()` を `transitions.apply('reopen', …)` へ・戻り値の互換シム）、Changed: `scripts/lib/coherence-guards.mjs`（`TRANSITION_VERBS` 4 語・`runKanban(['request-changes'` の検出）、Changed: `apps/bridge/test/transitions.test.js`（9 遷移のキー完全一致・`reopen` の `archived` は CLI 0 回・`request-changes` は 1 回）、Changed: `apps/bridge/test/coherence.rules.test.js`（`request-changes` 直叩きが violation）
- **受入条件（Verify）**: `npm run verify` が exit 0。`apps/bridge/src` に `runKanban(['request-changes'` が 0（`transition-owner` が緑）、`review.js` の `reopen()` が `apply('reopen')` を 1 回呼ぶ、`archived` のタスクは CLI 0 回で `skipped: 'noop'`、`done` は `review` へ戻る（`moved: 'review'`）。`runKanban(['request-changes'` を 1 行足すと `check:coherence` が RED（対照実験）。
- **非対象**: 新しい状態（`triage` 等）の追加。`request-changes` の CLI 出力の整形（`outputOf` のまま）。

### Batch DRF-5: BOARD-TICK — ブリッジの盤面走査を 1 本に統合（D110）

- **Execution Mode**: `[Mode: Zero-Stop]`
- **目的**: 同じ `kanban.db` を 10 秒間隔で 2 本が別々に走査している状態を、1 本の盤面ティック（1 回読んで購読者へ配る・差分つき）に統合する。完走報告とレビュー完了報告が同じ根拠（同じスナップショット・同じ差分）を見るようにする。
- **変更・新規ファイル**: New: `apps/bridge/src/board-tick.js` / `apps/bridge/test/boardTick.test.js`、Changed: `apps/bridge/src/review-watcher.js`（`dbPaths` / `readTasks` と独自タイマーを削除し `boardTick.subscribe` へ・`opts.snapshot` 注入へ）、Changed: `apps/bridge/src/pipeline-watcher.js`（同上・`readAllTasks` をスナップショット由来へ）、Changed: `apps/bridge/src/server.js`（`createBoardTick` を先に作り両 watcher へ注入・`start()` は 1 回）、Changed: `apps/bridge/test/reviewWatcher.test.js` / `apps/bridge/test/pipelineWatcher.test.js`（フィクスチャを `snapshot` 注入へ・タイマーが 1 本であること）、Changed: `scripts/lib/coherence-guards.mjs` + `scripts/check-coherence.mjs`（`board-tick-owner`）
- **受入条件（Verify）**: `npm run verify` が exit 0。`apps/bridge/src/**/*-watcher.js` に `setInterval(` と `new DatabaseSync(` が 0（`board-tick-owner`）、`server.js` 上の 10 秒タイマーが 1 本だけ、同じタスクの `running → blocked` で review の `⏸` と pipeline の完了判定が同じ `changes` を見る（`boardTick.test.js` のフィクスチャで 1 回の走査を 2 購読者が受け取る）、`snapshot` の行に `BOARD_ROW_COLUMNS` が全列そろう（review の `[review]` 判定と pipeline の group 判定が同じ行で成立）。watcher に `setInterval(` を戻すと `check:coherence` が RED（対照実験）。
- **非対象**: `state.db`（セッション）の走査（`pipeline-watcher` の `latestSessionForCwd` は別 DB・そのまま）。`kanban.db` への書き込み（D55・readOnly のみ）。ポーリング間隔の変更（10 秒のまま）。

---

## 5. 落とし穴（実装前に読む）

- **「検出 0」を根拠にしない**: ガードを広げる 4 バッチは、必ず「わざと壊した入力で RED」を同じバッチのテストに固定する。広げた瞬間に緑なのは「対象が 0 件」かもしれない（`check:coherence` の対象件数をログに出して確認する）。
- **購読 2 本で取得 2 回に戻さない**: スケジューラが `sources` を 1 回だけ呼ぶことをテストで数値固定する。`subscribe` のたびに fetch する実装に戻すと、`/api/inbox` の二重取得がそのまま残る。
- **`pauseOnTabs` とマウント条件を二重に使わない**: ペインの取得は「マウント中だけ購読」が停止規則。`active` 条件を `enabledWhen` にも書くと、タブを見ているのに止まる二重停止が戻る。
- **1 秒時計の許可は「時刻表示」だけ**: `setInterval(fn, 1000)` で `fn` が `Date.now()` を読むもの。1 秒間隔のデータ取得は許可しない（規則で通ってしまうため、`syncSources` 側へ移す）。
- **`transitions.test.js` のキー完全一致は先に直す**: 表に `reopen` を足すと RED になる。テストを 9 遷移へ更新してから実装する（Zero-Stop の自走で迷わないため）。
- **`request-changes` の `from` を狭めない**: 現行 `reopen()` は状態を見ずに実行する。`from: '*'` / `noop: ['archived']` で挙動を保存する（勝手に `from: ['review']` へ絞ると既存フローが静かに止まる）。
- **board-tick は readOnly のみ**: 走査が 1 本になると、書き込みを足したときの影響も 1 か所に集まる。`new DatabaseSync(..., { readOnly: true })` を board-tick の外に戻さない（`board-tick-owner`）。
- **`opts.dbPaths` の注入は board-tick へ移す**: watcher のテストが `dbPaths` を偽装している場合、そのままだと「タイマー 0 本」の検査だけ通って走査が 2 回に戻る。フィクスチャは `snapshot` 注入へ統一する。

---

## 6. 全体の完了条件

1. `npm run verify` が exit 0（`check:coherence` / `check:term-enter` を含む）
2. `apps/web/src` の `setInterval(` が 2 箇所（1 秒時計）だけ・`apps/bridge/src/**/*-watcher.js` の `setInterval(` が 0
3. `check:coherence` の `sync-owner` が `apps/web/src/**` を対象にし、`board-tick-owner` が追加されている（どちらも対照実験で RED を確認済み）
4. `HM_EVENT_META` のオブジェクト detail 20 件すべてに `required` があり、`contracts.test.js` が欠落を RED にする
5. `TRANSITION_TABLE` が 9 遷移（`reopen` を含む）で、`apps/bridge/src` に `runKanban(['request-changes'` が 0
6. `kanban.db` を 10 秒で読むタイマーが 1 本だけ（`board-tick.js`）で、review / pipeline の 2 報告が同じ `changes` を見ている
