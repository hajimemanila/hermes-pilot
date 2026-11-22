# SPEC: 実行モード整合性監査 — 接続状態・定期同期・イベント payload・タスク遷移の「正本」 (`SPEC-EXECUTION-MODE-INTEGRITY`)

- **状態**: 仕様確定（2026-11-22・赤ペン Q1〜Q4 すべて **A** で確定。Batch `SEMM-1` 〜 `SEMM-5`）
- **決定の出所**: `~/.hermes/plugin-data/hermes-pilot/review/sheets/spec-spec-execution-mode-mode-zer-1.answer.json`（4 問・選択 4 / お任せ 0）
- **前提仕様**: [SPEC-COHERENCE.md](./SPEC-COHERENCE.md) / [SPEC-RELIABILITY-GUARD.md](./SPEC-RELIABILITY-GUARD.md) / [SPEC-EN-ZERO-LEAK.md](./SPEC-EN-ZERO-LEAK.md) / [SPEC-ROLE-DELEGATION-ROUTING.md](./SPEC-ROLE-DELEGATION-ROUTING.md) / [SPEC-PILOT-V11.md](./SPEC-PILOT-V11.md)
- **対象リポジトリ**: `hermes-mobile-pwa`（プラグイン名: `hermes-pilot` / `Hermes Pilot`）
- **全バッチ共通の完了条件**:
  - `npm run verify`（`check:coherence` / `check:term-enter` を含む全ゲート）が exit 0 であること
  - 外部 AI CLI のサブプロセス起動禁止（`check:oauth` 通過・Hermes Native 完結）および D55 非干渉原則（Hermes 本体の SQLite / cron DB への直接書き込み禁止・ユーザー承認なき自動タスク起票禁止）を遵守すること
  - `SPEC-EN-ZERO-LEAK` 遵守（CLI / Bridge ログ・エラー `reason` は英語単一言語、Web UI 追加文言は `en.json` / `ja.json` 同時追加・英語辞書の CJK / 全角記号ゼロ）
  - `themeTokens.test.js` 遵守（JSX inline style およびコンポーネント CSS への色直書き禁止・テーマトークンのみ使用）
  - 表示が変わるバッチ（`SEMM-1` / `SEMM-2` / `SEMM-3`）では `npm run deploy` と `npm run build:demo` ＋ `demo/index.html` 同期が exit 0 であること。**新しい色・新しい帯は作らない**（既存の丸・既存の帯の判定元を差し替えるだけ）
  - 行番号は **2026-11-22 時点の実測**。実装時は行番号ではなくシンボル名（`approveAdvance` / `offlineSince` / `LIVE_TURNS`）で探すこと

---

## 1. 背景 — 呼び出し側で辻褄を合わせている 4 点（実測）

いずれも「動いてはいるが、同じ事実を 2 か所以上が別々に決めている」型で、片方だけ直すと静かにずれる。

1. **接続状態が 2 系統（端末を入れると 4 系統）**: 画面の丸は HTTP ポーリングの `conn`（`apps/web/src/App.jsx:190`、更新は `:548-571`、5 秒間隔 `:587-590`）、赤帯はソケット独自の `offlineSince`（`apps/web/src/lib/useChatSocket.js:45-51`、状態語彙 `connecting|ready|closed|error` は `:20`）。端末は `open` / `reconnecting`（`apps/web/src/features/TermPane.jsx:125` / `:159`）で、バックオフは `apps/web/src/lib/termReconnect.js:20-23`、チャット側は同じ式を手書き（`useChatSocket.js:142`）。
2. **定期同期が 7 本の独立タイマー**: `App.jsx:485`（完了報告 15 秒）/ `:587`（概要 5 秒）/ `:639`（レビュー 15 秒）/ `:678`（フィード 15 秒）/ `:707`（承認待ち 15 秒）/ `:744`（ライブ 15 秒）/ `:770`（使用量 60 秒）。停止規則も不揃い（`:640` `:679` は `review`、`:708` は `tasks` を除外、`:745` は無条件）。復帰時の一括再取得は `registerSyncer`（`App.jsx:328`）が別系統。
3. **イベント payload が足りず、購読側が二重ポーリングで埋めている**: `LIVE_TURNS` の契約は `{ turns }` だけ（`apps/web/src/contracts/events.js:91`）だが、送信側は既に `{ turns, items }` を流している（`apps/web/src/features/TasksPane.jsx:379-390`）。購読側は `architect` を受け取れないため、`App.jsx:742-743` に「ターン数しか運ばないので、ここを省くと Architect が数えられない（実測）」という**呼び出し側パッチ**が残り、`/api/live` を 5 秒・10 秒・15 秒の 3 経路で叩いている。
4. **blocked からの遷移判断が 5 か所に散在**: `apps/bridge/src/review.js:606-617` の `approveAdvance` は complete を試して失敗時だけ unblock、`review.js:494-500`（回答の再送）と `:548-552`（回答）も個別に unblock、`apps/bridge/src/review/media.js:120-124`・`:152-156`（注釈）も同じ分岐を写している。「どの遷移がどこで起きるか」を 1 か所で説明できない。

---

## 2. 合意決定表（D96〜D100）

| ID | 決定事項 |
| :--- | :--- |
| **D96** | **接続状態の正本は `apps/web/src/lib/transport.js` 1 つ**: chat / term / HTTP の 3 系統が**イベントを報告**し、集約状態を 1 か所で決める。状態語彙は `connecting \| ready \| recovering \| offline \| auth` に統一（`open` / `closed` / `error` は報告イベント名としてのみ残す）。丸・赤帯・`gwState`・`data-transport` は同じ集約値を見る。バックオフ式も `transport.js` に移し、`termReconnect.js` は再エクスポートのみ。 |
| **D97** | **定期同期の正本は `apps/web/src/lib/syncScheduler.js` の宣言表 + 1 本のスケジューラ**: 7 本の `setInterval` と `registerSyncer` を置き換える。「何秒で・どのタブで止めるか」を表に書き、追加時に規則を書き忘れない。復帰時は `forceAll()` で表を 1 周する（旧 `syncAllBadges({force:true})` の置き換え）。 |
| **D98** | **イベント payload は契約側を全量に広げ、機械で欠落を検出する**: `LIVE_TURNS.detail = { turns, items, architect }` を `HM_EVENT_META.required` に書き、`contracts.test.js` が**送信側の実リテラル**と突き合わせる。購読側の追加取得（`App.jsx` の `/api/live` タイマー）は削除し、`live` トピックを `pauseOnTabs: ['tasks']` にする。 |
| **D99** | **タスク遷移の正本は `apps/bridge/src/review/transitions.js` の遷移表 + 単一実行関数**: 5 か所の「complete を試し、失敗時だけ unblock」を表に集約する。`apply(name, …)` は **from に無ければ CLI を呼ばない**（no-op）、complete 成功で unblock を呼ばない、unblock は最大 1 回。既存の戻り値形 `{ code, out, status, moved }` は変えない。 |
| **D100** | **再発防止は `check:coherence` の 3 ルールで機械化**: `sync-owner`（`App.jsx` に `setInterval(`）、`transport-owner`（`lib/transport.js` 以外の `offlineSince` / 指数バックオフ式）、`transition-owner`（`review.js` / `review/media.js` の `runKanban(['unblock'` / `['complete'`）。 |

**採らなかった案（証跡）**: Q1-C（HTTP の `conn` を唯一の正本にすると切断反映が最大 5 秒遅れ、赤帯の 2 秒体験が消え、端末切断が HTTP 生存中は見えない）／Q2-C（`/api/sync` 集約はブリッジ API・契約レジストリ・demo モックの同時更新が必要で 1 バッチを超える）／Q3-C（イベント廃止・props 降下はペイン単体で開けなくなる）／Q4-C（判断を API 応答に載せると実行側が `next` を無視して静かに壊れる）。

---

## 3. 正本の設計（実装前に読む 1 ページ）

### 3.1 `lib/transport.js`（D96）

```js
export const TRANSPORT_SOURCES = ['http', 'chat', 'term']
export const TRANSPORT_STATES = ['ready', 'connecting', 'recovering', 'offline', 'auth']
export const GRACE_MS = { http: 8000, chat: 2000, term: 2000 }
export function reconnectDelay(attempt, { base = 1000, max = 15000 } = {}) // n 回目 → min(max, base*2**(n-1))
export function createTransportHub({ now = () => Date.now(), graceMs = GRACE_MS } = {})
//   → { report(source, type), state(), sourceState(source), subscribe(fn) → off, reset() }
export function aggregate(sources, nowMs) // 純関数。下の優先順で 1 語を返す
export function severity(state)           // auth 4 / offline 3 / recovering 2 / connecting 1 / ready 0
```

**報告イベント → 状態**（報告名は系統ごとに現行語を残す）:

| 系統 | 報告イベント | 内部状態 |
| :--- | :--- | :--- |
| `http` | `ok` / `timeout` / `error` / `auth` | `ok` → `ready`、`timeout`・`error` → **`brokenAt` から `graceMs.http` 以内は `recovering`、超えたら `offline`**、`auth` → `auth`（`ok` が来るまで固定） |
| `chat` | `connecting` / `ready` / `closed` / `error` | `ready` → `ready`、`connecting` → 一度でも ready していれば `recovering` さもなくば `connecting`、`closed`・`error` → 同上（`graceMs.chat`） |
| `term` | `connecting` / `open` / `closed` / `error` | `open` → `ready`、他は chat と同じ（`graceMs.term`） |

**集約の優先順**（`aggregate`）: `auth` > `offline` > `recovering` > `connecting` > `ready`。
`graceMs.http = 8000` は「`/api/overview` のタイムアウト 8 秒（`netRecovery.js` の `OVERVIEW_TIMEOUT_MS`）＋ 1 ポーリング」で、1 回の失敗で赤帯を出さないための値。`chat` / `term` の 2000ms は現行の 2 秒猶予（`useChatSocket.js:48`）をそのまま移す。

**表示の対応（この表が受け入れ条件）**:

| 面 | 現在の判定元 | 変更後 |
| :--- | :--- | :--- |
| App の丸 `span.conn`（`App.jsx:858`） | HTTP `conn` | 集約値。`ready` = `●`、他は `○`。title は `app.connected` / `app.disconnected` / 新規 `app.connRecovering`（recovering・connecting） |
| App の赤帯（`App.jsx:925`） | `conn !== 'ok'` | 集約値 ∈ {`offline`, `auth`} |
| GW ピル `gwState`（`App.jsx:779` / `lib/telemetry.js`） | `conn` | 集約値。`ready`→`ok`、`offline`→`offline`、`connecting` / `recovering` / `auth`→`error`（既存の 3 値は変えない） |
| チャットの帯（`ChatPane.jsx:1633`） | 自前 `offlineSince` | hub の `sourceState('chat')` ∈ {`recovering`, `offline`} |
| チャットのローダー（`ChatPane.jsx:1722-1723`） | `connState === 'connecting'` | 変更なし（`useChatSocket().state` は chat 系統の状態を返す） |
| `data-conn`（`ChatPane.jsx:2294`） | chat 状態 | **据え置き**（chat 系統の語彙）。集約値は App ルートの `data-transport` に出す |
| 端末の状態（`TermPane.jsx:125` / `:159`） | `open` / `reconnecting` | hub の `sourceState('term')` を `term.state.*` へ写像: `ready`→`open`、`connecting`→`connecting`、`recovering`→`reconnecting`、`offline`→`closed`、`error`/`auth`→`error` |

`ChatPane` の `connRef.current === 'ready'` ゲート（`:813` / `:1346` / `:1452`）は **`ready` の語を変えない**ので無修正で通る。

### 3.2 `lib/syncScheduler.js`（D97）

```js
export const SYNC_TOPICS = [
  { id: 'overview',      everyMs: 5_000,  pauseOnTabs: [] },          // 接続状態の供給元
  { id: 'reports',       everyMs: 15_000, pauseOnTabs: [] },          // 完了報告（HM_EVENTS.REFRESH_REPORTS で即時）
  { id: 'reviewWaiting', everyMs: 15_000, pauseOnTabs: ['review'] },
  { id: 'reviewFeed',    everyMs: 15_000, pauseOnTabs: ['review'] },
  { id: 'inbox',         everyMs: 15_000, pauseOnTabs: ['tasks'] },
  { id: 'live',          everyMs: 15_000, pauseOnTabs: [] },          // SEMM-3 で ['tasks'] へ
  { id: 'usage',         everyMs: 60_000, pauseOnTabs: [] },
]
export function shouldRun(topic, { tab, visible })
export function createSyncScheduler({ topics = SYNC_TOPICS, isVisible, currentTab, now })
//   → { subscribe(topicId, fn) → off, start(), stop(), forceAll({ skip } = {}), tick(topicId) }
```

- `tick` は「`isVisible()` かつ `pauseOnTabs` に `currentTab()` が含まれない」ときだけ `fn()` を呼ぶ（**間隔は止めない**。位相を保つため。現行も timer 内で判定している）
- `forceAll({ skip })` は**可視・タブ・スロットルを無視して全トピックを 1 回**走らせる（旧 `syncAllBadges({force:true, skip: refreshRef.current})` の置き換え）。`skip` はトピック id
- 旧 `registerSyncer` / `syncersRef` / `lastWakeAtRef` / `WAKE_THROTTLE_MS` は削除（購読はトピック id と結びつく）
- `HM_EVENTS.REFRESH_REPORTS` の手動同期は `scheduler.tick('reports')` に置き換える（イベント自体は残す）

### 3.3 `LIVE_TURNS` の payload（D98）

| 項目 | 変更前 | 変更後 |
| :--- | :--- | :--- |
| `contracts/events.js:91` の meta | `{ detail: '{ turns }' }` | `{ detail: '{ turns, items, architect }', required: ['turns', 'items', 'architect'] }` |
| 送信側 `TasksPane.jsx:379-390` | `{ turns, items }` | `{ turns, items, architect: Number(d?.counts?.architect ?? 0) }` |
| 購読側 `App.jsx:735-749` | 15 秒タイマー + イベント | イベント + `syncScheduler` の `live` トピック（`pauseOnTabs: ['tasks']`） |
| `App.jsx:742-743` の呼び出し側パッチ | 「ターン数しか運ばないので省けない」 | 削除し、「TasksPane が全量を運ぶ（`required` で機械検査）」の 1 行に置き換え |

`/api/live` を叩く経路は 3 つ（`LiveSheet.jsx:67` 5 秒 / `TasksPane.jsx:378` 10 秒 / `App.jsx:726` 15 秒）。**`LiveSheet` の 5 秒は残す**（モーダルで開いている間だけの短命な購読で、タブ常駐の同期とは性質が違う）。削除対象は `App.jsx` の 15 秒タイマーだけ。

`contracts.test.js` の新検査: `HM_EVENT_META[name].required` の各キーが、`apps/web/src/**` の `new CustomEvent(HM_EVENTS.<name>, { detail: { … } })` リテラルに現れること（静的走査。送信箇所が複数あれば全部）。`architect` を落とすと RED になることをテストで固定する。

### 3.4 `review/transitions.js`（D99）

```js
export const TRANSITION_TABLE = {
  approve:            { from: ['blocked'], kind: 'complete-then-unblock', result: 'Visual check passed' },
  'answer.fresh':     { from: ['blocked'], kind: 'unblock' },
  'answer.again':     { from: ['blocked'], kind: 'unblock' },   // 冪等: 回答は保存済み、遷移だけ未了
  'annotation.fresh': { from: ['blocked'], kind: 'unblock' },
  'annotation.again': { from: ['blocked'], kind: 'unblock' },
}
export function createReviewTransitions(ctx = {}) // ctx: { runKanban, bodyOf, now }
//   → { table: TRANSITION_TABLE, canApply(name, status), apply(name, { id, reason, metadata }) }
```

`apply` の規則（この 4 つがテスト対象）:

1. `bodyOf(id)` の status が `from` に無ければ **CLI を 1 回も呼ばず** `{ code: 0, out: '', status, moved: null, skipped: 'not-in-from' }`
2. `kind: 'unblock'` → `runKanban(['unblock', id, '--reason', reason])` を **1 回だけ**
3. `kind: 'complete-then-unblock'` → `complete`（`--result <result>` ＋ `--metadata {closed_from:'review', approved_by:'mobile', approved_at:<now>}`）を試し、**失敗したときだけ** `unblock` を 1 回。complete 成功で unblock は呼ばない
4. 戻り値は `{ code, out, status, moved }`（`moved` は `'done'` / `'ready'` / `null`）。呼び出し側の既存分岐を壊さない

呼び出し側の差し替え（`review.js` の公開契約と `surfaceCtx` の形は変えない）:

| 箇所 | 変更後 |
| :--- | :--- |
| `review.js:494-500`（回答の再送） | `transitions.apply('answer.again', { id, reason: ops.answeredAgain })` |
| `review.js:548-552`（回答） | `transitions.apply('answer.fresh', { id, reason: ops.answered })` |
| `review.js:606-617` `approveAdvance` | `(id, b, reason) => transitions.apply('approve', { id, reason })` の互換シム（`:656` / `:705` / `:746` の呼び出しは触らない） |
| `review/media.js:120-124` | `transitions.apply('annotation.again', { id, reason: ops.annotationReceivedAgain })` |
| `review/media.js:152-156` | `transitions.apply('annotation.fresh', { id, reason: ops.annotationReceived })` |

`createReviewTransitions({ runKanban, bodyOf, now })` は `review.js` で 1 つ作り、`surfaceCtx` に `transitions` として渡す（`createReviewMedia` / `createReviewFeeds` と同じ分割ファクトリ規約）。

---

## 4. カンバンタスク分割（Batch `SEMM-1` 〜 `SEMM-5`）

### Batch SEMM-1: TRANSPORT-OWNER — 接続状態の正本 `lib/transport.js` と 3 系統の報告統一

- **Execution Mode**: `[Mode: Visual Gate]`
- **Recommended Role**: `role:builder`
- **目的**: 丸・赤帯・`gwState`・チャット帯・端末状態の判定元を 1 つの集約状態にし、バックオフ式を 1 実装にする。
- **変更・新規ファイル**:
  - 新規: `apps/web/src/lib/transport.js`, `apps/web/test/transport.test.js`
  - 変更: `apps/web/src/lib/useChatSocket.js`, `apps/web/src/lib/termReconnect.js`（再エクスポート化）, `apps/web/src/lib/telemetry.js`（`gwState` の語彙追加）, `apps/web/src/App.jsx`, `apps/web/src/features/TermPane.jsx`, `apps/web/src/features/ChatPane.jsx`, `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ja.json`, `apps/web/test/telemetry.test.js`
- **実装要点**: §3.1 の表をそのまま実装する。`useChatSocket` は `offlineSince` と 400ms タイマーと手書きバックオフ（`:45-51` / `:142`）を捨て、hub へ `connecting` / `ready` / `closed` / `error` を報告し、`state` は `sourceState('chat')` を返す。`showBanner` は `sourceState('chat') ∈ {recovering, offline}`。`TermPane` は `setState('open'|'reconnecting'|…)` をやめ、hub 報告 + `term.state.*` 写像にする（表示文言は増やさない）。i18n 追加は `app.connRecovering` の 1 キーだけ（en は ASCII のみ、ja は「接続を回復しています…」）。**JSX/CSS の見た目は変えない**。
- **テスト**: `transport.test.js` — ① `reconnectDelay` の刻み（1→1000, 2→2000, 4→8000, 6→15000 上限）② chat の close から 2000ms 未満は集約 `recovering`、超えたら `offline` ③ http の 1 回失敗（8 秒以内）では `offline` にしない ④ `auth` は他系統が ready でも集約 `auth` ⑤ 全系統 ready で `ready`、回復で `ready` に戻る ⑥ `severity` の順序。`telemetry.test.js` — `gwState({conn:'recovering'})` = `'error'`、`{conn:'auth'}` = `'error'`、`{conn:'offline'}` = `'offline'`、`{conn:'ready'}` = `'ok'`。
- **検証**: `npm test` / `npm run build` / `npm run audit:responsive` / `npm run build:demo` / `npm run deploy`。実画面（390×844・ライト / ダーク）で「ブリッジを止める → 2 秒で帯、戻すと消える」「端末タブを開いたまま止めると `reconnecting` 表示」を人間が 1 回見る。

### Batch SEMM-2: SYNC-OWNER — 7 本のタイマーを宣言表 + 1 本のスケジューラへ

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: 「何秒で・どのタブで止めるか」を 1 つの表にし、停止規則の不揃い（`:640` `:679` `:708` `:745`）を無くす。
- **変更・新規ファイル**:
  - 新規: `apps/web/src/lib/syncScheduler.js`, `apps/web/test/syncScheduler.test.js`
  - 変更: `apps/web/src/App.jsx`（`useEffect` 7 本 → 購読 1 本、`registerSyncer` / `syncersRef` / `lastWakeAtRef` / `WAKE_THROTTLE_MS` 削除）
- **実装要点**: §3.2 の表と API をそのまま実装。各トピックの `fn` は現行 `sync` の中身を移すだけ（取得 URL・state 更新・`catch` の握り方は変えない）。復帰（`isConnectivityRecovery`）と `HM_EVENTS.WAKE_SYNC` は `forceAll({ skip: 'overview' })` に集約。`live` の `pauseOnTabs` はこの段では `[]`（`SEMM-3` で `['tasks']` にする）。
- **テスト**: `syncScheduler.test.js` — ① 表どおりの間隔で呼ばれる（mock timers）② 表示中タブでは該当トピックが呼ばれない ③ `document.hidden` 相当（`isVisible() === false`）で呼ばれない ④ `forceAll` は可視・タブ・スロットルを無視して全トピック 1 回、`skip` を尊重 ⑤ `subscribe` の解除後は呼ばれない ⑥ 表の `everyMs` が 7 トピックぶん重複なく揃っている。
- **検証**: `npm test` / `npm run check:coherence` / `npm run build` / `npm run build:demo` / `npm run deploy`。

### Batch SEMM-3: EVENT-PAYLOAD — `LIVE_TURNS` を全量にし、二重ポーリングを削除

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: 契約を送信側の実態に合わせ、購読側が「足りないから取りに行く」構造を消す。
- **変更・新規ファイル**: `apps/web/src/contracts/events.js`, `apps/web/src/features/TasksPane.jsx`, `apps/web/src/App.jsx`, `apps/web/src/lib/syncScheduler.js`（`live.pauseOnTabs: ['tasks']`）, `apps/web/test/contracts.test.js`
- **実装要点**: §3.3 の表どおり。`required` は meta の任意フィールドとして追加し、`requiredKeys(name)` ヘルパを契約側に置く。`App.jsx` から `/api/live` の独立タイマーと「ターン数しか運ばない」コメントを削除し、購読は `LIVE_TURNS` イベント + `live` トピック（タスクタブ表示中は休止）。
- **テスト**: `contracts.test.js` — ① `required` の全キーが送信リテラルに存在 ② `architect` を送信から落とすと RED（フィクスチャで固定）③ `required` の無いイベントは従来どおり素通り。`live.test.js`（bridge）— `/api/live` の `counts.architect` が返ることを既存テストで確認（API 変更なし）。
- **検証**: `npm test` / `npm run build` / `npm run deploy` / `npm run smoke:live`。実画面: タスクタブを開いたまま ⚡ の数字が 15 秒以内に追随すること（`architect` が 0 に落ちないこと）。

### Batch SEMM-4: TRANSITION-OWNER — `review/transitions.js` に遷移表と単一実行関数

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: blocked からの遷移判断を 1 か所に集め、冪等（同じ回答の再送は no-op）を 1 実装にする。
- **変更・新規ファイル**:
  - 新規: `apps/bridge/src/review/transitions.js`, `apps/bridge/test/transitions.test.js`
  - 変更: `apps/bridge/src/review.js`, `apps/bridge/src/review/media.js`, 必要に応じて `apps/bridge/test/review.test.js` の期待値
- **実装要点**: §3.4 の表と規則。`ops.*` の文言選択は呼び出し側に残す（遷移モジュールは `reason` 文字列を受け取るだけ＝i18n を持たない）。`approveAdvance` はシムにして公開契約（`review.js:746` の戻り値に載る）を保つ。
- **テスト**: `transitions.test.js` — ① blocked + `approve` で complete 成功 → `moved: 'done'`、unblock は 0 回 ② complete 失敗 → unblock 1 回・`moved: 'ready'` ③ `from` に無い status → CLI 呼び出し 0 回・`skipped: 'not-in-from'` ④ `answer.again` は complete を試さない ⑤ `annotation.*` も同じ ⑥ `now()` 注入で `approved_at` が固定できる。
- **検証**: `npm test`（`review.test.js` / `reviewWatcher.test.js` を含む）/ `node bin/hermes-pilot.mjs service restart` 後に `npm run smoke:live`。**bridge を再起動しないと API は旧コードのまま**（実測済みの罠）。

### Batch SEMM-5: INTEGRITY-GUARD — 再発防止 3 ルール・ライブ結合検証・ドキュメント

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: 4 つの正本が再び呼び出し側へ漏れないよう機械で止め、結合状態を実測する。
- **変更・新規ファイル**: `scripts/check-coherence.mjs`（ルール 3 本を登録）, `apps/bridge/test/coherence.test.js`, `docs/OPERATIONS.md`（「整合性の正本」節・10 行程度）, `docs/PITFALLS.md`（1 項）
- **実装要点**:
  - `sync-owner`: `apps/web/src/App.jsx` に `setInterval(` が 0 件
  - `transport-owner`: `apps/web/src/lib/transport.js` 以外に `offlineSince` と `1000 * 2 **` が 0 件（`termReconnect.js` の再エクスポートは許可）
  - `transition-owner`: `apps/bridge/src/review.js` と `apps/bridge/src/review/media.js` に `runKanban(['unblock'` / `runKanban(['complete'` が 0 件
  - ルールは既存の `findings.violation(rule, message, { value, files })` 形式で、`docs/OPERATIONS.md` には「正本の場所 4 つ」を箇条書きで残す
- **テスト**: `coherence.test.js` — 3 ルールそれぞれ「違反フィクスチャで violation」「準拠フィクスチャで 0 件」。
- **検証**: `npm run verify`（全ゲート）/ `npm run deploy` / `npm run build:demo` / `npm run smoke:live`。最後に 4 点を実測で確認: ① 丸と赤帯が同じ値で動く（集約）② App のタイマーが 0 本 ③ `architect` がタスクタブでも数えられる ④ blocked からの 5 経路がすべて `transitions.apply` を通る（`grep` で 0 件を確認）。

---

## 5. 検証の対応表（誰が何で確かめるか）

| 主張 | 検証手段 |
| :--- | :--- |
| 接続状態が 1 か所で決まる | `apps/web/test/transport.test.js` ＋ `data-transport` の実画面確認 |
| タイマーが 1 本になった | `check:coherence` の `sync-owner` ＋ `syncScheduler.test.js` |
| イベント payload が契約を満たす | `contracts.test.js` の `required` 検査（送信リテラル走査） |
| 遷移判断が 1 か所 | `transition-owner` ルール ＋ `transitions.test.js` |
| 画面が壊れていない | `npm run verify`（`audit:responsive` 含む）＋ 390×844 / デスクトップ × ライト / ダーク |

## 6. 非スコープ

- `/api/sync` のような集約エンドポイントの新設（Q2-C）
- 接続状態の API 契約変更（`/api/overview` の形は変えない）
- 端末ソケット（PTY）のプロトコル変更 — 変えるのは状態の報告先だけ
- 通知経路（`mobile-akapen-watch` / `chat-reports.jsonl`）とカンバン DB スキーマ
