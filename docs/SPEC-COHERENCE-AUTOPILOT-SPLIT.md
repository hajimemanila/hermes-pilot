# SPEC: 整合性スイープ第 2 弾 — autopilot の分割・葉の抜き出し・テスト分割 (`SPEC-COHERENCE-AUTOPILOT-SPLIT`)

- **Status**: decided（2026-11-27・Round 1 の 4 問はすべて「お任せ」＝推奨 A を採用して確定）
- **決定の出所**: `~/.hermes/plugin-data/hermes-pilot/review/sheets/spec-coherence-autopilot-split-1.answer.json`（`answers` 4 件すべて `choice: null` / `note: ""` / `global: ""`）
- **対象リポジトリ**: `~/projects/hermes-mobile-pwa` @ `0b90f66`（2026-11-27 実測）
- **前提仕様**: [SPEC-spec-execution-mode-mode-zer.md](./SPEC-spec-execution-mode-mode-zer.md)（SEMM-1〜5）/ [SPEC-coherence-audit-2.md](./SPEC-coherence-audit-2.md)（COA2-1〜5）/ [SPEC-coherence-split-batches.md](./SPEC-coherence-split-batches.md)（MRG-1〜5）/ [SPEC-COHERENCE.md](./SPEC-COHERENCE.md)
- **バッチ**: `SEMM-6` 〜 `SEMM-10` の **5 本**（`SEMM-1`〜`SEMM-5` は実装済み・決定を差し替えない。COA2 / MRG も不変更）
- **起票**: **まだしない**（この SPEC を置いて止まる。起票は人の「File batches」待ち）
- **全バッチ共通の完了条件**:
  - `npm run verify` が exit 0（`npm test` / `check:dashboard` / `check:pwa` / `check:oauth` / `build` / `audit:responsive` / `check:term-enter` / `check:coherence` / `check:cold-install`）
  - `node scripts/check-coherence.mjs --json` が `"hardFails":[]`
  - 外部 AI CLI（`gemini -p` / `agy -p`）を起動しない（`check:oauth` が境界）。D55 非干渉（Hermes 本体の SQLite / cron DB へ直接書かない・承認なしにタスクを起票しない）
  - `SPEC-EN-ZERO-LEAK` 遵守（CLI / Bridge のログ・`reason` は英語のみ。Web UI 文言を足すときは `en.json` / `ja.json` 同時）
  - **`[Mode: Zero-Stop]`**: 機械検証が落ちたら自分で直して再実行する。通った時点で `done`
  - **検証コマンドに `node -e` / `node -c` を使わない**（実測: ヘッドレス実行では `-e` / `-c` フラグが承認待ちでブロックされ、ワーカーが永久に止まる）。式の比較はテストファイル内で行うか `diff` / `rg` / `npm run` で組む
  - 行番号は **2026-11-27 時点の実測**。実装時は行番号ではなくシンボル名（`classifySwipe` / `ap-remix-bar` / `ap-card-front` / `file-bloat`）で探す

---

## 1. 背景（すべて実測）

`npm run check:coherence` の現在地は **15 rules / 0 hard fail / 1 soft signal**（`baseline-ratchet` が 4 ファイルの縮小を検出: `TasksPane.jsx` 1966→1962 / `ReviewPane.jsx` 749→742 / `architect.js` 732→702 / `App.jsx` 1075→1070）。ハードは既に 0 で、**残っているのは「大きすぎるままの単位」**だけ。

| 対象 | 実測 | 制約 |
| :--- | :--- | :--- |
| `apps/web/src/lib/autopilotDeck.js` | **492 行 / 27 export / import 元 6 ファイル** | 上限 800。ラチェット未登録 |
| `apps/web/src/features/autopilot/AutopilotDeck.jsx` | **489 行 / export 1**（`AutopilotDeck`） | `AutopilotView.jsx` は 360 行で対象外 |
| `apps/web/src/styles/autopilot.css` | **657 行 / `var(--)` 142 / 生の色 4 種 6 行** | 上限 800。**`styles.css` は 31 行でラチェット登録済み＝1 行も増やせない** |
| 旧 `architectJob` テスト（分割前の 1 本） | **811 行 / test 28 本 / describe 0**（→ `file-bloat` 対象） | 上限 800。ラチェット未登録 |
| 死んだコード | **未参照 export 0 件**（autopilotDeck 27・`features/autopilot/*.jsx` 12・`bridge/src/architect/*.js` 24 を全数 `rg`）／**未参照 `.ap-*` クラス 0 件**（133 クラス中） | 削る対象が存在しない |

import 元 6 ファイル（**この 6 本を 1 行も変えないことが公開契約**）:

- `apps/web/src/features/autopilot/AutopilotDeck.jsx:14`（9 シンボル）
- `apps/web/src/features/autopilot/AutopilotView.jsx:11`
- `apps/web/src/features/autopilot/MockCompareStage.jsx:2`（3 シンボル）
- `apps/web/src/features/autopilot/StyleGachaBar.jsx:2`（2 シンボル）
- `apps/web/test/autopilotDeck.test.js:24`（**20 シンボル**）
- `apps/web/test/autopilotStorySandbox.test.js:17`

既存の同型前例: `apps/bridge/src/architect.js`（**702 行のバレル**＋`apps/bridge/src/architect/{job-view,task,batch,labels,seed,autopilot}.js`）と、`apps/web/src/styles.css`（manifest 31 行＋`styles/*.css`）。本 SPEC はこの 2 つの型を autopilot 側へ広げるだけで、新しい型を持ち込まない。

## 2. 決定（Q1〜Q4 = A）

| # | 論点 | 決定 | 根拠 |
| :--- | :--- | :--- | :--- |
| **Q1** | `autopilotDeck.js` の分割方式 | **純関数を 3 分割＋既存パスは再エクスポート専用バレル** | import 元 6 ファイルとテスト 20 シンボルを無変更にでき、`architect.js` と同じ型。衝突面が最小 |
| **Q2** | 見た目を動かさない保証 | **規則・JSX の移動のみ。画面確認は最終バッチで 1 回だけ**（`build:demo` ＋ `audit:responsive` ＋ 390×844 スクショ 1 枚 ＋ `annotation`） | 値も順序も変えないので、途中バッチは `diff` と `npm run build` で機械的に担保できる。生の色 4 種の正規化（Q2-C）は**見た目が動く**のでこの SPEC では**やらない** |
| **Q3** | 旧 `architectJob` テスト（811 行 / 28 本）の分割粒度 | **3 分割（job-view / task / batch）＋既存ヘルパー再利用**（`test/helpers/architectFixtures.js` は既にある） | ファイル先頭コメントが既に対象 3 モジュールを名指ししている。test 28 本を維持したまま `file-bloat` が消える。新規ヘルパーは作らない |
| **Q4** | バッチ接頭辞 | **`SEMM-6` から継続**（`### Batch SEMM-<n>: <Title>`） | 委譲契約の見出し規約に一致。`duplicate-batch-id` は ID 全体比較なので `SEMM-6` は衝突しない（`SEMM-1`〜`5` は使用中） |

## 3. 詳細設計

### 3.1 `lib/autopilotDeck.js` → `lib/autopilot/{deck-core,deck-flow,studio}.js` ＋ バレル

Targets: `apps/web/src/lib/autopilotDeck.js`

27 export の振り分け（行範囲は現ファイルの実測。**移動のみ・ロジック変更なし**）:

| 新ファイル | 現行の行 | 持つもの（export 数） |
| :--- | :--- | :--- |
| `apps/web/src/lib/autopilot/deck-core.js` | `:6-128` | 定数 5（`EDGE_DEAD_ZONE_PX` / `SWIPE_THRESHOLD_PX` / `UNDO_WINDOW_MS` / `REMIX_CHIP_WINDOW_MS` / `MAX_STYLE_GACHA`）＋ データ 4（`STYLE_GACHA_PRESETS` / `SWIPE_STAMPS` / `REMIX_CHIPS` / `AUTOPILOT_RECIPES`）＋ ジェスチャ 4（`resolveStoryTapZone` / `nextOptionIndex` / `isInEdgeDeadZone` / `classifySwipe`）= **13** |
| `apps/web/src/lib/autopilot/deck-flow.js` | `:130-329` | `buildDeckFromSheet` / `currentOptionCard` / `resolveOptionSwipe` / `buildAnswerPayload` / `createUndoEntry` / `isUndoActive` / `resolveHoldOutcome` / `createRemixPending` / `buildRemixPayload`（＋ private の `normalizeQuestionOptions`）= **9 export ＋ private 1** |
| `apps/web/src/lib/autopilot/studio.js` | `:331-492` | `translateActivity` / `isSameOriginPreviewUrl` / `isReachablePublicUrl` / `extractDeliverable` / `projectStudioStage`（＋ private の正規表現 4 本と `OPEN_STATUSES`）= **5** |
| `apps/web/src/lib/autopilotDeck.js`（既存パス） | — | **バレル専用**: 3 本からの `export { … } from` だけで 27 名を再輸出（40 行以下） |

- 13 + 9 + 5 = **27**。
- 依存は一方向: `deck-flow.js` は `deck-core.js` の定数のみ参照し、`studio.js` は現行どおり自己完結（private の `OPEN_STATUSES` と正規表現 4 本を一緒に持っていく）。値・文字列・分岐は 1 文字も変えない。
- `apps/web/test/autopilotDeck.test.js` に**契約テストを 1 本だけ追加**: バレルの `Object.keys()` をソートした配列が下記 27 名と一致すること。

```text
AUTOPILOT_RECIPES, EDGE_DEAD_ZONE_PX, MAX_STYLE_GACHA, REMIX_CHIPS, REMIX_CHIP_WINDOW_MS,
STYLE_GACHA_PRESETS, SWIPE_STAMPS, SWIPE_THRESHOLD_PX, UNDO_WINDOW_MS, buildAnswerPayload,
buildDeckFromSheet, buildRemixPayload, classifySwipe, createRemixPending, createUndoEntry,
currentOptionCard, extractDeliverable, isInEdgeDeadZone, isReachablePublicUrl, isSameOriginPreviewUrl,
isUndoActive, nextOptionIndex, projectStudioStage, resolveHoldOutcome, resolveOptionSwipe,
resolveStoryTapZone, translateActivity
```

（この一覧が**公開契約そのもの**。増減させる変更は意図的な契約変更としてテストを直す＝差分が見える。`node -e` は使わず、`node --test` の中の `assert.deepEqual` で比較する。）

### 3.2 `AutopilotDeck.jsx` から提示専用の葉を 2 つ抜く

Targets: `apps/web/src/features/autopilot/AutopilotDeck.jsx`（489 行）

| 新ファイル | 移す範囲 | 受け取る props |
| :--- | :--- | :--- |
| `apps/web/src/features/autopilot/DeckRemixBar.jsx` | `{remixPending && <div className="ap-remix-bar" …>}` ブロック全体（注記フォーム `ap-remix-note-row` ＋ `ap-remix-chips` ＋ `StyleGachaBar`） | `pending` / `noteMode` / `noteText` / `onNoteText` / `onBackToFirst` / `onChip` / `onSubmitNote` / `onRollStyle` / `gachaCount` / `t` |
| `apps/web/src/features/autopilot/DeckActionBar.jsx` | `isUndoActive(undo) && <div className="ap-undo-pill">` と `<footer className="ap-action-bar">` の 2 ブロック | `undo` / `undoLabel` / `undoActionLabel` / `isLastOption` / `labels` / `onOutcome(direction, rect)` / `onUndo` / `t` |

- **DOM を変えない**: 子コンポーネント境界は DOM 要素を増やさない。クラス名・`aria-*`・`role`・i18n キー・文言・ボタン順（✕ ⏸ 🖍 ♥）は現行のまま。
- 状態と副作用（`drag` / `flying` / `undo` / `gachaCountByCard` / `sendRemix` / `applyOutcome` / `FLY_MS` / `shotUrlFor`）は `AutopilotDeck.jsx` に残す。`REMIX_CHIPS` と `StyleGachaBar` の import は `DeckRemixBar.jsx` へ移す。
- 目標: `AutopilotDeck.jsx` を 489 → 約 330 行、新 2 ファイルはどちらも 110 行以下。

### 3.3 `styles/autopilot.css` を 2 枚＋2 行 manifest に分ける

Targets: `apps/web/src/styles/autopilot.css`（657 行）/ `apps/web/src/styles.css`（**31 行・変更禁止**）

- 節コメント `/* --- AP2-4: Story Flick Compare, Live Sandbox & Style Gacha --- */`（`:480`）が自然な境界。`@media (max-width: 430px)`（`:409-479`）は**前半に残す**（基底デッキの調整なので）。
  - 新規 `apps/web/src/styles/autopilot-deck.css` … `:1-479`
  - 新規 `apps/web/src/styles/autopilot-story.css` … `:480-657`
  - 変更 `apps/web/src/styles/autopilot.css` … **3 行だけ**（先頭コメント＋`@import './autopilot-deck.css';`＋`@import './autopilot-story.css';`）
- `apps/web/src/styles.css:31` は**触らない**（31 行のラチェットを 1 行も増やさないため。`@import` は先頭にしか書けないので末尾追記は不可）。
- **入れ子 manifest は既存テストの範囲内**: `apps/web/test/stylesManifest.test.js` は「`styles.css` が manifest であること」「直接 import した先が実在し ≤800 行」「`:root` は `tokens.css` だけ」を見る。`readStyles()`（`test/helpers/styles.js`）は `@import` を再帰展開するので、入れ子 manifest でも全規則は 1 本に展開される。`autopilot.css` は 3 行 manifest になり `:root` を持たない。
- 宣言・セレクタ・空白・コメントは 1 文字も変えない（生の色 4 種 6 行も**この SPEC では触らない**）。

### 3.4 旧 `architectJob` テスト（811 行 / 28 本）→ 3 本

Targets: `apps/bridge/test/architectJobView.test.js` / `apps/bridge/test/architectTask.test.js` / `apps/bridge/test/architectBatch.test.js`（分割元の 1 本は削除）

振り分け（先頭コメントが名指ししている 3 モジュールに合わせる。**テスト名・アサーション・アサート順は 1 文字も変えない**）:

| 新ファイル | 入るテスト（対象 export） | 本数 / 想定行数 |
| :--- | :--- | :--- |
| `apps/bridge/test/architectJobView.test.js` | `jobsFor`（D28 / 親 `[ARCH]` done / ボード横断）/ `findJobReviewTask` / `findJobSpec` / `publicJob`（機密 400 字 / phase・stalled・sheetPath）/ `computePhase` / `isJobStalled` / `findRecentSheet` / `dismiss` / ランナー設定の保存 / 実行コードが OAuth に触れない境界 / 別ボードの `[review]` 検出 | **16 / 約 540** |
| `apps/bridge/test/architectTask.test.js` | `buildArchitectTaskTitle` / `buildKanbanCreateArgs` / `buildArchitectTaskBody`（Round 1 JSON ファースト §3.1①）/ `buildSeedPrompt`（言語規則・使用済み接頭辞 D91）/ `executionPolicy`（zero-stop 正規化 §3.1③）/ `[ARCH]` 本文の Round 2 見出し切替 | **6 / 約 220** |
| `apps/bridge/test/architectBatch.test.js` | `batchIdPrefixForSlug` / `batchIdPrefixOf` / `usedBatchIdPrefixes`（D91）/ `filedBatchIdsForSpec`（D91/D92）/ `pendingSpecs`（archived 除外）/ `queueStateOf` / `reviewBoardsFor`（D42）/ `spec-architect` SKILL.md の文言検査 | **6 / 約 140** |

- 既存の `apps/bridge/test/helpers/architectFixtures.js`（`SPEC_TEXT` / `makeKanbanBoard` / `makeRepo` / `seedInput` / `settle` / `writeSpec`）をそのまま使う。**新しいヘルパーは作らない**。
- 各ファイルに `const here = path.dirname(fileURLToPath(import.meta.url))` と `SRC` の 2 行を複製する（`here` は `helpers/` ではなく各テストの位置を指す必要があるため、`SRC` の解決は `..`/`src` のまま）。
- 28 本の合計を保つ（1 本も落とさない・増やさない）。分割元の旧 1 本は削除する（`npm test` の glob `apps/bridge/test/*.test.js` が新 3 本を拾う）。

### 3.5 死んだコードの扱い（実測 0 件なので削らない）

- `rg` 参照ゼロの export: **0 件**。`autopilotDeck.js` 27 export の最小参照数は 2（定義＋1 参照）、`features/autopilot/*.jsx` 12 export も最小 3、`bridge/src/architect/*.js` 24 export も最小 2。
- 未参照の `.ap-*` クラス: **0 件**（`autopilot.css` の 133 クラスすべてが CSS 以外のソースから参照されている）。
- したがって「削る」バッチは作らない。**最終バッチで再測定して記録する**だけにする（1 件でも出たらその場で削除・ただし参照ゼロのみ）。
- `apps/web/src/styles/autopilot-radar.css` は未 import に見えるが `LiveRadarCard.jsx:5` / `BeforeAfterTimelapse.jsx:3` が JSX から直接 import している（**生きている**。触らない）。

## 4. カンバンタスク分割（Batch `SEMM-6` 〜 `SEMM-10`）

### Batch SEMM-6: DECK-SPLIT — `lib/autopilotDeck.js` を 3 分割し、公開契約をバレルで固定

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: 492 行 / 27 export の純関数ライブラリを責務 3 つ（定数・ジェスチャ / デッキ進行 / 成果物・ステージ判定）に分ける。既存パス `lib/autopilotDeck.js` は再エクスポート専用バレルにして、import 元 6 ファイルとテスト 20 シンボルを**1 行も変えない**。
- **変更・新規ファイル**:
  - 新規: `apps/web/src/lib/autopilot/deck-core.js`（13 export）, `apps/web/src/lib/autopilot/deck-flow.js`（9 export ＋ private 1）, `apps/web/src/lib/autopilot/studio.js`（5 export）
  - 変更: `apps/web/src/lib/autopilotDeck.js`（バレル化・40 行以下）, `apps/web/test/autopilotDeck.test.js`（契約テスト 1 本追加）
- **実装要点**: §3.1 の表どおりに**移動のみ**。`normalizeQuestionOptions` は private のまま `deck-flow.js` へ。`studio.js` は `deck-core.js` の定数を参照しない（現行どおり自己完結）。バレルは 3 本の `export { … } from './autopilot/…js'` だけ書き、ロジックを書かない。
- **受入条件（Verify）**:
  - `node --test apps/web/test/autopilotDeck.test.js apps/web/test/autopilotStorySandbox.test.js` → **tests 15 / pass 15 / fail 0**（現行 14 ＋ 新規 1）
  - 新規テスト「バレルは 27 名の公開契約を維持する」が通る（`assert.deepEqual(Object.keys(m).sort(), [ …27 名… ])`。`node -e` は使わない）
  - `wc -l apps/web/src/lib/autopilot/*.js` → それぞれ **200 行以下**、`wc -l apps/web/src/lib/autopilotDeck.js` → **40 行以下**
  - `npm run build` exit 0
  - `npm run check:coherence` → hard fail 0 / `file-bloat` 0 件
  - import 元 6 ファイルの差分が **0 行**（`git diff --stat HEAD -- apps/web/src/features/autopilot apps/web/test/autopilotStorySandbox.test.js` が空。`autopilotDeck.test.js` の追加分だけが差分）

### Batch SEMM-7: DECK-LEAVES — `AutopilotDeck.jsx` から提示専用の葉を 2 つ抜く

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: 489 行のうち、状態を持たない 3 ブロック（remix バー / undo ピル / アクションバー）を子コンポーネントへ移す。状態・副作用・i18n キーは親に残し、**描画結果の DOM を 1 要素も変えない**。
- **変更・新規ファイル**:
  - 新規: `apps/web/src/features/autopilot/DeckRemixBar.jsx`, `apps/web/src/features/autopilot/DeckActionBar.jsx`
  - 変更: `apps/web/src/features/autopilot/AutopilotDeck.jsx`（3 ブロックを子に置換し、props を渡す。`REMIX_CHIPS` / `StyleGachaBar` の import を `DeckRemixBar.jsx` へ移す）
- **実装要点**: §3.2 の表。クラス名・`aria-*`・`role`・ボタン順・文言・`onClick` の引数（`e.currentTarget.getBoundingClientRect()` を渡す形）を変えない。`FLY_MS` / `shotUrlFor` / `applyOutcome` / `sendRemix` / `handlePointer*` は親に残す。**新しい CSS は足さない**（既存クラスを使うだけ）。
- **受入条件（Verify）**:
  - `node --test apps/web/test/autopilotDeck.test.js apps/web/test/autopilotStorySandbox.test.js` → tests 15 / fail 0
  - クラス名の出現回数が不変: `rg -o --no-filename 'ap-[a-z0-9-]+' <実装前 HEAD の AutopilotDeck.jsx>` と `rg -o --no-filename 'ap-[a-z0-9-]+' AutopilotDeck.jsx DeckRemixBar.jsx DeckActionBar.jsx` の `sort | uniq -c` が一致（`diff` が無出力）
  - `npm run build` exit 0 / `npm run check:coherence` hard 0
  - `wc -l` で `AutopilotDeck.jsx` が **350 行以下**、新 2 ファイルが各 **110 行以下**
  - 画面確認はこのバッチでは撮らない（Q2-A。SEMM-10 で 1 回だけ）

### Batch SEMM-8: CSS-SPLIT — `styles/autopilot.css` を 2 枚 + 2 行 manifest へ

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: 657 行を節コメント境界で 2 枚に分ける。`apps/web/src/styles.css` の 31 行ラチェットを 1 行も増やさず、読み込み順（＝カスケード順）を保つ。
- **変更・新規ファイル**:
  - 新規: `apps/web/src/styles/autopilot-deck.css`（`:1-479`）, `apps/web/src/styles/autopilot-story.css`（`:480-657`）
  - 変更: `apps/web/src/styles/autopilot.css`（先頭コメント＋`@import './autopilot-deck.css';`＋`@import './autopilot-story.css';` の 3 行のみ）
  - **不変更**: `apps/web/src/styles.css`（31 行のまま）
- **実装要点**: §3.3。行の移動だけで、セレクタ・値・プロパティ順・`@media` の入れ子・コメントを 1 文字も変えない。生の色 4 種 6 行（`rgba(255,255,255,.35)` / `rgba(0,0,0,.25)` / `#ffffff` ほか）は**触らない**。
- **受入条件（Verify）**:
  - 字面不変: `diff <(git show HEAD:apps/web/src/styles/autopilot.css) <(cat apps/web/src/styles/autopilot-deck.css apps/web/src/styles/autopilot-story.css)` が**無出力**（exit 0）
  - `wc -l apps/web/src/styles.css` が **31**（不変）
  - `npm run build` exit 0（Vite が入れ子 `@import` を展開する）
  - `node --test apps/web/test/stylesManifest.test.js` → pass / fail 0（直接 import の上限、`:root` の単一性、展開順）
  - `npm run check:coherence` → hard 0（`baseline-ratchet` が `styles.css` の grow を出さない）

### Batch SEMM-9: ARCH-TEST-SPLIT — 811 行の旧 `architectJob` テストを 3 本へ割る

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: 上限 800 を超えている唯一のテストを、対象モジュール（`job-view` / `task` / `batch`）の 3 本に割る。test 28 本を 1 本も落とさず、`file-bloat` を消す。
- **変更・新規ファイル**:
  - 新規: `apps/bridge/test/architectJobView.test.js`, `apps/bridge/test/architectTask.test.js`, `apps/bridge/test/architectBatch.test.js`
  - 削除: 分割元の旧 1 本（中身は 3 本へ移設）
  - **不変更**: `apps/bridge/test/helpers/architectFixtures.js`（既存を再利用。新規ヘルパーを作らない）
- **実装要点**: §3.4 の振り分け表。テスト名・アサーション・順序を 1 文字も変えない（`assert` の引数も同じ）。各ファイルに `here` / `SRC` の 2 行を複製する。
- **受入条件（Verify）**:
  - `node --test apps/bridge/test/architectJobView.test.js apps/bridge/test/architectTask.test.js apps/bridge/test/architectBatch.test.js` → **tests 28 / pass 28 / fail 0**
  - `npm test` exit 0（総件数は変化なし。新 3 本が glob で拾われる）
  - `wc -l` が 3 本とも **800 行以下**（`architectJobView` は約 540）
  - `npm run check:coherence --json` の `hardFails` に `file-bloat` が無い
  - 旧パス（`architectJob` + `.test.js`）への参照が `git grep` で 0 件（古いパスを参照する設定・文書が残っていない）

### Batch SEMM-10: INTEGRITY + VISUAL GATE — ラチェット締め・0 hard / 0 soft・390px 実画面 1 枚

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:visual-reviewer`
- **目的**: 分割後のリポジトリで整合性を **0 hard / 0 soft** に戻し、見た目が動いていないことを 390×844 の実画面 1 枚で確定する。死んだコードの再測定結果と分割後の置き場所を docs に残す。
- **変更・新規ファイル**:
  - 変更: `scripts/coherence-baseline.json`（`node scripts/check-coherence.mjs --update-baseline` で縮小を反映。**grow はしない**＝`--allow-grow` を使わない）, `docs/MODULES.md`（autopilot の新モジュール地図と「autopilot.css は 2 行 manifest」を追記）, `docs/PITFALLS.md`（「`node -e` はヘッドレスでブロックされる」「分割は移動のみ・契約はバレル」の 2 行）
- **実装要点**: `--update-baseline` の差分を目視し、`styles.css`（31）が上がっていないことを確認する。`docs/MODULES.md` の CSS 節に「`styles/autopilot.css` は入れ子 manifest。規則は `autopilot-deck.css` / `autopilot-story.css`」を追記し、`apps/web/src/lib/autopilot/` の 3 本を JS 節へ追記する。
- **受入条件（Verify）**:
  - `npm run verify` exit 0（全 9 ゲート）
  - `node scripts/check-coherence.mjs --json` → `"hardFails":[]` かつ **`"softSignals":[]`**（`baseline-ratchet` の縮小シグナルも 0 になること）
  - 死んだコード再測定: `rg` 参照ゼロ export **0 件**・未参照 `.ap-*` クラス **0 件**（133 クラス中）。結果を `docs/MODULES.md` に 1 行で記録（1 件でも出たらその場で削除して再実行）
  - Visual Gate: `npm run build:demo` exit 0 → **390×844（ライト / ダーク）で Autopilot デッキを 1 枚ずつ撮影**し、`annotation` スキルの経路で赤を 1 往復受け取る。レイアウト差分が出たら `git revert` で SEMM-7 / SEMM-8 の該当コミットを戻し、分割の切り口を変えてやり直す（見た目を直して合わせない）
  - このバッチだけは**画面確認の 1 往復でいったん止まる**（機械検証は Zero-Stop で自走、赤の取り込み後に `done`）

---

## 5. 検証コマンドの一覧（Zero-Stop が使うもの）

| 目的 | コマンド |
| :--- | :--- |
| Web の単体（autopilot 2 本） | `node --test apps/web/test/autopilotDeck.test.js apps/web/test/autopilotStorySandbox.test.js` |
| スタイル manifest | `node --test apps/web/test/stylesManifest.test.js` |
| Bridge の分割後テスト | `node --test apps/bridge/test/architectJobView.test.js apps/bridge/test/architectTask.test.js apps/bridge/test/architectBatch.test.js` |
| 全テスト | `npm test` |
| ビルド | `npm run build` / `npm run build:demo` |
| 整合性 | `node scripts/check-coherence.mjs --json`（判定は `hardFails`） |
| ラチェット締め | `node scripts/check-coherence.mjs --update-baseline` |
| 字面不変の比較 | `diff <(git show HEAD:<path>) <(cat <new files>)` |

**禁止**: `node -e` / `node -c`（ヘッドレスで承認待ちブロック）。式の比較が要るときはテストファイル内の `assert.deepEqual` に落とす。
