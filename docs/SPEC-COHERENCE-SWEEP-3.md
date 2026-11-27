# SPEC: 整合性スイープ第 3 弾 — 巨大 pane の分割・重複ヘルパーの単一定義化・未参照 export の機械検出 (`SPEC-COHERENCE-SWEEP-3`)

- **Status**: open
- **決定済状態**: decided（2026-11-27・Round 1 の 4 問はすべて推奨 A で確定）
- **決定の出所**: `~/.hermes/plugin-data/hermes-pilot/review/sheets/spec-coherence-sweep-3-1.answer.json`（`answers` 4 件すべて `choice: "A"` / `note: ""` / `global: ""`）
- **前提仕様**: [SPEC-spec-execution-mode-mode-zer.md](./SPEC-spec-execution-mode-mode-zer.md) / [SPEC-COHERENCE-AUTOPILOT-SPLIT.md](./SPEC-COHERENCE-AUTOPILOT-SPLIT.md)（SEMM-6〜10）/ [SPEC-coherence-split-batches.md](./SPEC-coherence-split-batches.md) / [SPEC-COHERENCE.md](./SPEC-COHERENCE.md)
- **対象リポジトリ**: `~/projects/hermes-mobile-pwa` @ `4a7dc54`（2026-11-27 実測・作業ツリーはクリーン）
- **バッチ**: `CSW3-1` 〜 `CSW3-9` の **9 本**（`COH` / `RG` / `SEMM` / `WJA` は使用済みのため接頭辞は `CSW3`）
- **起票**: **まだしない**（この SPEC を置いて止まる。起票は人の「File batches & start」待ち）
- **全バッチ共通の完了条件**:
  - `npm run verify` が exit 0（`npm test` / `check:dashboard` / `check:pwa` / `check:oauth` / `build` / `audit:responsive` / `check:term-enter` / `check:coherence` / `check:cold-install`）
  - `node scripts/check-coherence.mjs --json` の `hardFails` が `[]`（最終バッチは `softSignals` も `[]`）
  - `SPEC-EN-ZERO-LEAK` 遵守（CLI / Bridge のログ・`reason` は英語のみ。Web UI 文言を足すときは `en.json` / `ja.json` 同時）
  - **`[Mode: Zero-Stop]`**: 機械検証が落ちたら自分で直して再実行する。通った時点で `done`（人の赤を待たない）
  - **検証に `node -e` / `node -c` を使わない**（実測: ヘッドレス実行では承認待ちでブロックされ永久に止まる）。式の比較はテストファイル内の `assert` に落とす
  - 外部 AI CLI（`gemini -p` / `agy -p`）を起動しない。`git push` をしない（push は人の指示があったときだけ）
  - **コミットは明示パスで行う**（`git add -A` / `git commit -a` を使わない）。並走ワーカーが同じ作業ツリーに居る間は、自分が書いていない差分を巻き込まない
  - 行番号は **2026-11-27 時点の実測**。実装時は行番号ではなくシンボル名（`attachSheet` / `timelineNode` / `applyTasks` / `expandHome` / `deadExportProblems`）で探す

---

## 1. 背景（すべて実測・2026-11-27）

`node scripts/check-coherence.mjs --json` の現在地は **15 rules / `hardFails: []` / `softSignals: []`**（`pending: 0`）。`notices` は `sync-owner` が 120 ファイル走査・`board-tick-owner` が 77 ファイル走査（10 s）。つまり**機械で見つかる整合性の欠陥は 0** で、残っているのは「単位が大きすぎる」と「同じ処理が複数箇所にある」という構造の問題だけ。

| 対象 | 実測 | 制約 |
| :--- | :--- | :--- |
| `apps/web/src/features/ChatPane.jsx` | **2777 行 / export 1**（`ChatPane`）/ 直近 90 日 **65 コミット** | 上限 800。ラチェット baseline 登録済み（2777）＝**1 行も増やせない** |
| `apps/web/src/features/TasksPane.jsx` | **1962 行 / export 1**（`TasksPane`）/ 55 コミット | 同 baseline 1962 |
| `apps/dashboard/index.js` | 1991 行 / **7 コミット** | 触らない（変更頻度が低い＝痛みが小さい。Q1 の判断は「ChatPane → TasksPane」） |
| 同じ名前の定義 | **10 種**（§7.1） | `safeStorage` 3 定義 / `expandHome` 3 定義 ほか |
| 未参照 export | **66 件**（1356 export / 199 ファイルを全数走査。うち **63 件は同一ファイル内で使用＝`export` を外すだけ**、**3 件は完全未使用＝削除**） | `check-coherence` に判定ルールが無い（人手の `rg` のみ） |
| ソース文字列を読むテスト | **3 ファイル / 4 参照**（`apps/web/test/chatJumpPill.test.js:18`・`bannerOpenDraft.test.js:19`・`tasksView.test.js:234`・`:319`） | pane を分割するとパスが陳腐化する＝同じバッチで向け先を直す |
| 既存の同型前例 | `apps/bridge/src/architect.js`（バレル）＋`architect/{job-view,task,batch,labels,seed,autopilot}.js` / `apps/web/src/lib/autopilotDeck.js`（バレル）＋`lib/autopilot/*.js` / `features/chat/`（`ChatParts.jsx` 316 行・`ChatDrawer.jsx`・`useChatSessions.js`・`useChatReports.js`） | 新しい型を持ち込まず、この 3 つの型のどれかに合わせる |

### 1.1 なぜ「分割」だけで終わらせないのか

ChatPane の中身を実測すると、**ロジック（state + ハンドラ）が 40〜990 行、JSX の組み立てが 1552〜2287 行、`return` が 2288〜2777 行**に分かれている。3 つの継ぎ目（添付 `:992` / 送信 `:1083` / スニペット `:1403`）だけを切ると 2777 → 約 2400 行にしかならず、上限 800 には届かない。したがってこの SPEC は「継ぎ目 3 本で切り始め、**同じ切りの続き**で接続・通知・シート・描画まで抜いて 800 行以下に着地させる」ところまでを 1 つのスイープとして扱う（§3.3 の行範囲で算術を明示）。

---

## 2. 決定（Q1〜Q4 = すべて A）

| # | 論点 | 決定 | 根拠 |
| :--- | :--- | :--- | :--- |
| **Q1** | 最初に割るモジュール | **`ChatPane.jsx` を先に切る → 次に `TasksPane.jsx`**。ChatPane の継ぎ目は「添付 / 送信 / スニペット」の 3 本から入り、同じ切りの続きで 800 行以下まで落とす | 変更が最も集中するファイル（90 日 65 コミット）から縮めると、以後の衝突面が減る。`dashboard/index.js` は 7 コミットなので後回し（今回も触らない） |
| **Q2** | 公開契約の固定 | **既存パスは薄いシェルとして残し、export 名・props・DOM（`className`）を変えない＋契約テストで固定**（前例: `architect.js` / `autopilotDeck.js`） | `App.jsx` とソース文字列テスト 3 本を無変更で通せる。契約がテストで固定されるので、以後の分割でも同じ保証が効く |
| **Q3** | 重複の統合範囲 | **3 重複の 2 系統（`safeStorage` / `expandHome`）だけ 1 定義へ寄せ、他の 8 種は件数を SPEC に記録して触らない** | 副作用の差が小さい領域から確実に減らす。`toMs` / `toUi` / `resolveLang` は web と bridge で挙動が違い、畳むと Zero-Stop の検証が重くなる |
| **Q4** | 検査とラチェットの運用 | **`check-coherence` に未参照 export ルール（`dead-export`）を 1 本追加（除外は明示リスト）＋各バッチで縮小分だけ baseline を下げる＋最終バッチで 390px 実画面 1 枚** | 次回から機械で検出でき、行数は常に単調減少（grow 0）を保てる。除外リストの維持コストは 1 ファイルの配列で済む |

**採らなかった案（証跡）**: Q1-B（`TasksPane` を先に割ると痛みの順序と逆になる）／Q1-C（両方を交互に割ると 1 バッチ 1 テーマの粒度が薄まる）／Q2-B（呼び出し側も書き換えると `App.jsx` とソース文字列テストに差分が波及し、契約の担保がテストだけになる）／Q2-C（関数内フックの移動だけでは 2777 行が減らず `file-bloat` が残る）／Q3-B（10 種すべて統合は `toMs` / `toUi` の web / bridge 差を潰す）／Q3-C（重複を削らないと seed の目的を満たさない）／Q4-B（ルールが無いと今後また増える）／Q4-C（baseline を最後に一括更新すると途中の縮小が拾われず soft signal が出続ける）。

---

## 3. 詳細設計

### 3.1 `dead-export` ルール（CSW3-1）

- 実装は `scripts/lib/coherence-guards.mjs` に置く（このファイルはラチェット baseline 未登録なので、行が増えても grow にならない）。`scripts/check-coherence.mjs` 側は import 1 か所・`RULES` に `'dead-export'`・`analyzeRepo` のルール配列に `ruleDeadExport` の 3 点だけ足す（**約 20 行の増加＝この 1 回だけ `--allow-grow` を許す**。理由は commit message と本 SPEC に残す）。
- 判定: `deadExportDirs` 配下の各ファイルから `export (async )?(function|const|let|var|class) NAME` と `export { A, B as C }` を集め、`deadExportReaderDirs` 配下のどのファイルにも `\bNAME\b` が現れなければ未参照とする。
- **バレルは読み手に数えない**（`export {...} from` / `export * from` だけで構成されたファイルは reader から除外）。これで「バレルにだけ残った死んだ export」を検出できる。
- 除外は `.hermes-coherence.json` の **明示リスト** `deadExportIgnore: []`（要素は `"<path>#<name>"`、path は `globToRegExp` で照合）。初期値は空（実測 0 件を満たすため）。
- 出力は 1 件 1 hard fail（`dead-export` / `apps/web/src/lib/x.js exports 'foo' with no reader`）。初回だけ `checkerPending: { "dead-export": "CSW3-8" }` で **fatal soft** に落とし、CSW3-8 で 66 件を片付けたときに pending を外す。
- 単体テスト 4 本（`apps/bridge/test/coherence.rules.test.js`）: ①未参照を 1 件検出 ②import されていれば検出しない ③バレルは読み手に数えない ④`deadExportIgnore` で抑制できる。
- `RULES.length` は 15 → **16**、`ruleCount` も 16 になる（`coherence.rules.test.js` に件数の固定 assert があれば同じバッチで更新）。

### 3.2 契約テスト（CSW3-1 で先に置く）

新規 `apps/web/test/paneContract.test.js`（`node:test`。レンダリングはしない＝ソースと import だけで判定）:

1. `ChatPane.jsx` の export 名が `['ChatPane']`、`TasksPane.jsx` が `['TasksPane']` と一致する（動的 import で `Object.keys` をソート）。
2. props キー集合を凍結: ChatPane = `notify, chatReports, reviewItems, liveTurns, active, openRequest, onConsumedOpen, discussRequest, onConsumedDiscuss`（9）、TasksPane = `overview, refresh, notify, initialInbox, pendingInboxOpen, onConsumedPendingInboxOpen, focusBoard, onConsumedFocusBoard, taskToolRequest, onConsumedTaskTool, active`（11）。ソースから関数宣言の分割代入を正規表現で抽出し、ソート済み配列で比較する。
3. `className` の静的文字列集合（`className="..."` のみ・テンプレート式は除く）を pane ごとに凍結し、**現在の集合が凍結集合を包含していること**（欠落のみ fail、追加は許す）を assert する。走査対象は `ChatPane.jsx` ＋ `apps/web/src/features/chat/**`、`TasksPane.jsx` ＋ `apps/web/src/features/tasks/**`。実測の初期集合は ChatPane 側 **82 種**、TasksPane 側 **78 種**。

以後のバッチはこの 3 本を毎回の Verify に含める（分割で props か class が落ちたら、その場で赤になる）。

### 3.3 ChatPane の切り方（CSW3-2 〜 CSW3-5）

いずれも**移動のみ**（値・文字列・分岐・順序を変えない）。行範囲は現行ファイルの実測。

| バッチ | 抜く範囲（実測） | 置き場所 | 概算 |
| :--- | :--- | :--- | :--- |
| **CSW3-2**（添付・送信・スニペット） | `:992-1219`（添付の取り込み〜送信）・`:1403-1443`（スニペット）・`attachNode :2057-2090`・添付シート `:2356-2426`・スニペットシート `:2453-2478` | `features/chat/useChatComposer.js` / `features/chat/ChatComposer.jsx` / `features/chat/ChatAttachSheets.jsx` | 約 400 行 |
| **CSW3-3**（タイムライン・報告） | `bannerNode :1625-1700`・`timelineNode :1701-2052`・バブルメニューのシート `:2660-2773` | `features/chat/ChatTimeline.jsx` | 約 540 行 |
| **CSW3-4**（会話を開く・ヘッド） | `:1220-1551`（新規会話 / resume / 開く要求 / 更新 / ボード作成 / リポジトリ選択）・`chipsNode :1552-1576`・`chatHeadNode :1577-1624`・`minimalHeadNode :2229-2287` | `features/chat/useChatSession.js` / `features/chat/ChatHeadBar.jsx` | 約 480 行 |
| **CSW3-5**（接続・通知・残り） | `:395-990`（再接続 / `ready` / 通知処理 / worker feed / 検索スクロール / ドロワー / レポートカードの操作）・`:2091-2287` の残り（`jobBar` / `specBanner` / `actionBar`）・リポジトリシート `:2482-2640`・`ChatDrawer` 呼び出しとレシート | `features/chat/useChatConnection.js` / `features/chat/ChatChrome.jsx` / `features/chat/ChatSheets.jsx` | 約 800 行 |

算術: 2777 − 400 − 540 − 480 − 800 ≈ **557 行**（残るのは state 宣言・組み立て・`return` の骨）。**CSW3-5 の合格条件は `wc -l apps/web/src/features/ChatPane.jsx` ≤ 800** とし、通ったら `--update-baseline` で baseline を実測値へ下げる。

### 3.4 TasksPane の切り方（CSW3-6 〜 CSW3-7）

| バッチ | 抜く範囲（実測） | 置き場所 | 概算 |
| :--- | :--- | :--- | :--- |
| **CSW3-6**（データ層） | `:163-574`（`openInbox` / `applyBoards` / `loadBoards` / `applyTasks` / `loadTasks` / `applyUsage` / `applyLive` / `applyInbox` / `loadInbox` / `applyArchitectJobs` / `refreshAll`）と `:575-800` の memo 群 | `features/tasks/useTasksData.js`（取得と反映）／`features/tasks/useSpecLaunchpad.js`（`:942-1119` の SPEC 起票・履歴・選択） | 約 950 行 |
| **CSW3-7**（描画） | `:1120-1962`（一覧・フィルタ・行・空状態） | `features/tasks/TaskListView.jsx`＋（800 行を超える場合のみ）`features/tasks/TaskRows.jsx` | 約 840 行 |

**CSW3-7 の合格条件は `wc -l apps/web/src/features/TasksPane.jsx` ≤ 800**＋`--update-baseline`。既存の葉（`TaskDetailSheet.jsx` 406 / `SpecPicker.jsx` 142 / `BoardPickerSheet.jsx` 107）は動かさない。

### 3.5 重複の単一定義化（CSW3-8）

- `safeStorage` → 新規 `apps/web/src/lib/safeStorage.js` に **1 定義**（`apps/web/src/demo/frame.js:180` の実装＝`kind` と `win` を受け、書けない環境ではメモリ保存へ落ちる版が上位互換）。`demo/frame.js` は `export { safeStorage } from '../lib/safeStorage.js'` の 1 行再輸出にして**既存の import 元（`apps/web/test/demoEmbed.test.js:42`）を無変更**で通す。`lib/vibe.js:66` と `lib/soundFx.js:34` の private 版は import に置き換え、`storage` 未指定時の既定を新しい 1 定義へ寄せる（`getVibe(null)` = `'dopamine'` の既存テストはそのまま通る）。
- `expandHome` → 新規 `apps/bridge/src/lib/homePath.js` に **1 定義**。挙動は `apps/bridge/src/review/boards.js:16` の版（`~` / `~/` だけ展開し、相対パスはそのまま返す）を正とし、`repos.js:52` の「相対を home で解決する」挙動は `normalizePath` 側で明示的に行う（`path.resolve(home, expandHome(raw, home))`）。`review/boards.js` と `repos.js` は **`export { expandHome } from './lib/homePath.js'` の再輸出**を残す（`review.js:50` は `./review/boards.js` から import しているため、パスを変えない）。`gitinfo.js:82` の入れ子関数は import に置き換える（`home` が無いときの早期 return は `os.homedir()` 既定で吸収）。
- **触らない 8 種**は §7.1 に件数付きで記録する（次回の材料）。

### 3.6 未参照 export の片付け（CSW3-8）

- 63 件（同一ファイル内で使用）: `export` キーワードだけ外す（定数・関数は残す＝挙動不変）。
- 3 件（完全未使用・`apps/web/src/lib/syncSources.js`）: `syncRuntime` / `syncParams` / `resetSyncRuntime` を削除する。**削除前に `rg -n "syncRuntime|syncParams|resetSyncRuntime"` で 0 件を再確認**し、消した名前に依存する assert が無いことをテストで確かめる。
- 片付け後に `.hermes-coherence.json` の `checkerPending` から `"dead-export"` を外す（以降は hard fail）。

---

## 4. バッチ

### Batch CSW3-1: GUARD — `dead-export` ルールと pane 契約テストを先に置く

- **Execution Mode**: [Mode: Zero-Stop]
- **目的**: 以後の分割を機械で守るために、未参照 export の判定ルールと pane の公開契約テストを先に置く。ルールはこの時点では pending（fatal soft）で武装し、hard は 0 のまま保つ。
- **変更・新規ファイル**: 変更 `scripts/lib/coherence-guards.mjs`・`scripts/check-coherence.mjs`・`.hermes-coherence.json`・`apps/bridge/test/coherence.rules.test.js`・`scripts/coherence-baseline.json`（`--update-baseline --allow-grow` を 1 回だけ）／新規 `apps/web/test/paneContract.test.js`
- **受入条件（Verify）**: `node --test apps/bridge/test/coherence.rules.test.js apps/web/test/paneContract.test.js` が exit 0 かつ `npm run build` が exit 0 かつ `npm run check:coherence` が exit 0（`hardFails` 0・`dead-export` の 66 件は pending の soft として並ぶ）
- **実装要点**: `deadExportProblems()` はバレルを読み手から外す。`--allow-grow` の理由（ルール追加で `scripts/check-coherence.mjs` が約 20 行増える）を commit message と本 SPEC に残し、以後のバッチは shrink-only に戻す。

**実施記録（CSW3-1・実測）**:
- `--allow-grow` は 1 回だけ実行し、`scripts/check-coherence.mjs` の baseline を **1591 → 1638**（+47）へ上げた。内訳はルール 16 本目（`ruleDeadExport`）・`.hermes-coherence.json` の読み取り・対象/読み手モジュールの読み込み。その後 `process.exit` による出力切り詰め（下記）を直して **1636 行**になり、grow なしの `--update-baseline` で 1636 に締め直した（以後は shrink-only）。
- 実測値: `ruleCount` 16 / `pending` 1 / `hardFails` 0 / `dead-export` の soft 66 件（63 件は同一ファイル内使用・3 件は完全未使用）。走査は 199 モジュール、読み手は `apps/web/src` + `apps/bridge/src` + 両テスト + `apps/dashboard` + `scripts` + `bin`。
- 発見した不具合: 66 件を soft として並べると `--json` の出力が 8 KB を超え、末尾の `process.exit(code)` がパイプの書き込みを打ち切って JSON が壊れた（`apps/bridge/test/coherence.test.js` の 2 本が赤）。`process.exitCode = code` に変えて解消。**大量の指摘を出すルールは `process.exit` を使わない。**

### Batch CSW3-2: CHAT-COMPOSER — 添付・送信・スニペットを `features/chat/` へ

- **Execution Mode**: [Mode: Zero-Stop]
- **目的**: ChatPane の最初の継ぎ目（添付 `:992` / 送信 `:1083` / スニペット `:1403`）を切る。送信・添付・スニペットの state とハンドラを `useChatComposer.js`、JSX を `ChatComposer.jsx` と `ChatAttachSheets.jsx` へ移し、ChatPane はそれらを呼ぶだけにする。
- **変更・新規ファイル**: 変更 `apps/web/src/features/ChatPane.jsx`・`apps/web/test/chatJumpPill.test.js`・`apps/web/test/bannerOpenDraft.test.js`（読み先を新しい置き場所へ）／新規 `apps/web/src/features/chat/useChatComposer.js`・`apps/web/src/features/chat/ChatComposer.jsx`・`apps/web/src/features/chat/ChatAttachSheets.jsx`
- **受入条件（Verify）**: `node --test apps/web/test/chatJumpPill.test.js apps/web/test/bannerOpenDraft.test.js apps/web/test/paneContract.test.js` が exit 0 かつ `npm run build` が exit 0 かつ `npm run check:coherence` が exit 0 かつ `[ "$(wc -l < apps/web/src/features/ChatPane.jsx)" -le 2400 ]`
- **実装要点**: 移動のみ。`attachSheet` / `snippetSheet` の開閉 state は移した先へ持っていき、ChatPane には「開いているか」だけを残さない（二重管理を作らない）。baseline は `--update-baseline` で縮小分だけ下げる。

### Batch CSW3-3: CHAT-TIMELINE — タイムライン・報告バナー・バブルメニューを抜く

- **Execution Mode**: [Mode: Zero-Stop]
- **目的**: 発言の描画（`timelineNode :1701-2052`）、報告バナー（`:1625-1700`）、吹き出しメニューのシート（`:2660-2773`）を `ChatTimeline.jsx` に移す。ChatPane からは最も行数の大きい塊が消える。
- **変更・新規ファイル**: 変更 `apps/web/src/features/ChatPane.jsx`・`scripts/coherence-baseline.json`／新規 `apps/web/src/features/chat/ChatTimeline.jsx`
- **受入条件（Verify）**: `node --test apps/web/test/chatJumpPill.test.js apps/web/test/paneContract.test.js` が exit 0 かつ `npm run build` が exit 0 かつ `npm run check:coherence` が exit 0 かつ `[ "$(wc -l < apps/web/src/features/ChatPane.jsx)" -le 1850 ]`
- **実装要点**: スクロール位置の操作（ヒット発言への移動・`↓最新へ`）は ChatTimeline 側の ref に閉じる。`chatJumpPill.test.js` はソースを読むので、探索先を `ChatTimeline.jsx` へ向け直す（テストの期待値は変えない）。

### Batch CSW3-4: CHAT-SESSION — 会話を開く経路とヘッドを抜く

- **Execution Mode**: [Mode: Zero-Stop]
- **目的**: 新規会話・resume・`openRequest` の消費・更新・ボード作成・リポジトリ選択（`:1220-1551`）を `useChatSession.js` へ、チップ帯・ヘッド・最小ヘッド（`:1552-1624` / `:2229-2287`）を `ChatHeadBar.jsx` へ移す。
- **変更・新規ファイル**: 変更 `apps/web/src/features/ChatPane.jsx`・`scripts/coherence-baseline.json`／新規 `apps/web/src/features/chat/useChatSession.js`・`apps/web/src/features/chat/ChatHeadBar.jsx`
- **受入条件（Verify）**: `node --test apps/web/test/paneContract.test.js apps/web/test/chatJumpPill.test.js` が exit 0 かつ `npm run build` が exit 0 かつ `npm run check:coherence` が exit 0 かつ `[ "$(wc -l < apps/web/src/features/ChatPane.jsx)" -le 1400 ]`
- **実装要点**: `onConsumedOpen` / `onConsumedDiscuss` の呼び出し順序を変えない（props 契約テストがキー集合だけを見るので、順序は diff で担保する）。

### Batch CSW3-5: CHAT-CLOSE — 接続・通知・シートを抜いて ChatPane を 800 行以下へ

- **Execution Mode**: [Mode: Zero-Stop]
- **目的**: 残る最大の塊（接続と通知のハンドラ `:395-990`、進行バー・仕様バナー・操作バー `:2091-2287` の残り、リポジトリシート・ドロワー・レシート `:2482-2773`）を抜き、ChatPane を上限 800 行以下に着地させる。
- **変更・新規ファイル**: 変更 `apps/web/src/features/ChatPane.jsx`・`scripts/coherence-baseline.json`（`--update-baseline` で実測値へ）／新規 `apps/web/src/features/chat/useChatConnection.js`・`apps/web/src/features/chat/ChatChrome.jsx`・`apps/web/src/features/chat/ChatSheets.jsx`
- **受入条件（Verify）**: `node --test apps/web/test/paneContract.test.js apps/web/test/chatJumpPill.test.js apps/web/test/bannerOpenDraft.test.js` が exit 0 かつ `npm run build` が exit 0 かつ `node scripts/check-coherence.mjs --update-baseline` の後に `npm run check:coherence` が exit 0 かつ `[ "$(wc -l < apps/web/src/features/ChatPane.jsx)" -le 800 ]`
- **実装要点**: `useChatSocket` の購読解除が分割で二重にならないこと（接続は 1 本だけ）。`check:coherence` の `baseline-ratchet` に縮小シグナルが残らないよう、同じバッチ内で `--update-baseline` まで実行する。

### Batch CSW3-6: TASKS-DATA — TasksPane の取得・反映を 2 本のフックへ

- **Execution Mode**: [Mode: Zero-Stop]
- **目的**: TasksPane のデータ層（`:163-800` のローダ・反映・refreshAll・memo）を `useTasksData.js` と `useSpecLaunchpad.js` へ移す。描画はまだ動かさないので、この時点で挙動差が出たらデータ層の移し方が誤りだと切り分けられる。
- **変更・新規ファイル**: 変更 `apps/web/src/features/TasksPane.jsx`・`apps/web/test/tasksView.test.js`（読み先を新しい置き場所へ）／新規 `apps/web/src/features/tasks/useTasksData.js`・`apps/web/src/features/tasks/useSpecLaunchpad.js`
- **受入条件（Verify）**: `node --test apps/web/test/tasksView.test.js apps/web/test/paneContract.test.js` が exit 0 かつ `npm run build` が exit 0 かつ `npm run check:coherence` が exit 0 かつ `[ "$(wc -l < apps/web/src/features/TasksPane.jsx)" -le 1100 ]`
- **実装要点**: ポーリング表（`architectJobs` / `specs` / `inbox` / `coherence` / `specReports`）の `everyMsOf` は 1 か所にまとまっているので、表ごと移す（1 本ずつ書き写さない）。`tasksView.test.js:234` / `:319` のソース読みは新しいパスへ向ける。

### Batch CSW3-7: TASKS-VIEW — 描画を `TaskListView.jsx` へ、TasksPane を 800 行以下へ

- **Execution Mode**: [Mode: Zero-Stop]
- **目的**: `:1120-1962` の一覧描画（フィルタ・行・空状態・スクロール）を `TaskListView.jsx`（800 行を超える場合のみ `TaskRows.jsx` も）へ移し、TasksPane を上限 800 行以下にする。
- **変更・新規ファイル**: 変更 `apps/web/src/features/TasksPane.jsx`・`scripts/coherence-baseline.json`／新規 `apps/web/src/features/tasks/TaskListView.jsx`（必要なら `apps/web/src/features/tasks/TaskRows.jsx`）
- **受入条件（Verify）**: `node --test apps/web/test/tasksView.test.js apps/web/test/paneContract.test.js` が exit 0 かつ `npm run build` が exit 0 かつ `npm run check:coherence` が exit 0 かつ `[ "$(wc -l < apps/web/src/features/TasksPane.jsx)" -le 800 ]`
- **実装要点**: 行の key、スクロール復元、空状態の文言を変えない（`className` 集合テストが欠落を検出する）。`--update-baseline` をこのバッチでも実行する。

### Batch CSW3-8: DEDUPE + DEAD-EXPORT — 2 系統の単一定義化と未参照 66 件の片付け

- **Execution Mode**: [Mode: Zero-Stop]
- **目的**: `safeStorage` 3 定義と `expandHome` 3 定義を各 1 定義へ寄せ、未参照 export 66 件（63 件は `export` を外す・3 件は削除）を片付け、`checkerPending` から `dead-export` を外して常時 hard に戻す。
- **変更・新規ファイル**: 新規 `apps/web/src/lib/safeStorage.js`・`apps/bridge/src/lib/homePath.js`／変更 `apps/web/src/demo/frame.js`・`apps/web/src/lib/vibe.js`・`apps/web/src/lib/soundFx.js`・`apps/bridge/src/repos.js`・`apps/bridge/src/review/boards.js`・`apps/bridge/src/gitinfo.js`・`apps/web/src/lib/syncSources.js`・`.hermes-coherence.json`・`scripts/coherence-baseline.json`・§7.2 に挙がった 63 ファイル
- **受入条件（Verify）**: `node --test apps/web/test/vibe.test.js apps/web/test/demoEmbed.test.js apps/bridge/test/repos.test.js apps/bridge/test/coherence.rules.test.js` が exit 0 かつ `npm test` が exit 0 かつ `npm run check:coherence` が exit 0 かつ `node scripts/check-coherence.mjs --json` の `hardFails` が `[]` かつ `dead-export` の指摘が 0 件（`softSignals` にも出ない＝pending 解除済み）
- **実装要点**: `expandHome` の統一で相対パスの解決位置が変わるため、`normalizePath`（`repos.js`）側に `path.resolve(home, ...)` を明示して `apps/bridge/test/repos.test.js:51` の期待値を維持する。`syncRuntime` / `syncParams` / `resetSyncRuntime` は削除前に `rg` で参照 0 を再確認する。削除で `sync-owner` ルールの走査除外リストが陳腐化しないかも見る。

**実施記録（CSW3-8・実測）**:
- 片付け前の再測定: `dead-export` は **67 件**（§7.2 の 66 件 ＋ CSW3-3 で新設した `features/chat/ChatTimeline.jsx` の `scrollMessagesToEnd`）。内訳は「同一ファイル内でのみ使用 **64 件**（`export` を外す）」「完全未使用 **3 件**（`syncSources.js` の `syncRuntime` / `syncParams` / `resetSyncRuntime` を削除）」。
- `safeStorage` は `apps/web/src/lib/safeStorage.js` の 1 定義（`createMemoryStorage` も同居）。`demo/frame.js` は同ファイルから `import` したうえで `export { createMemoryStorage, safeStorage } from '../lib/safeStorage.js'` の再輸出を残し、`lib/vibe.js` / `lib/soundFx.js` の private 版は import に置き換えた（`storage` 未指定の既定が新しい 1 定義になる）。
- `expandHome` は `apps/bridge/src/lib/homePath.js` の 1 定義。`repos.js` の `normalizePath` は `path.resolve(home, expandHome(raw, home))` と明示し、絶対パスを前提にしていた他の呼び出し（スキャン・設定正規化・手動追加・ボード作成の親ディレクトリ）は private の `expandHomeAbs` に寄せて従来挙動を保った。`review/boards.js` と `repos.js` は再輸出を残し、`gitinfo.js` の入れ子関数は import に置き換えた（`home` 未設定は `os.homedir()`）。
- `sync-owner` の走査除外リスト（`syncScheduler.js` / `syncSources.js`）は陳腐化しない。削除したのは取得関数ではなく未使用のアクセサ 3 つで、走査対象は 133 ファイルに増えた。
- 片付け後: `ruleCount` 16 / `pending` 0 / `hardFails` `[]` / `softSignals` `[]`（`dead-export` は常時 hard に戻った）。`npm test` は 1416 pass / fail 0（片付け前と同数）。

### Batch CSW3-9: INTEGRITY + VISUAL GATE — `npm run verify`・0 hard / 0 soft・390px 実画面 1 枚

- **Execution Mode**: [Mode: Zero-Stop]
- **目的**: 分割と整理の後で全 9 ゲートを通し、`check-coherence` を 0 hard / 0 soft に戻し、見た目が動いていないことを 390×844 の実画面 1 枚で確定する。新しいモジュール地図と学びを docs に残す。
- **変更・新規ファイル**: 変更 `docs/MODULES.md`（`features/chat/*` と `features/tasks/*` の地図・`dead-export` ルールの 1 行）・`docs/PITFALLS.md`（「ソース文字列を読むテストは分割時にパスを直す」「バレルは読み手に数えない」の 2 行）・`scripts/coherence-baseline.json`（最終ラチェット）
- **受入条件（Verify）**: `npm run verify` が exit 0 かつ `node scripts/check-coherence.mjs --json` の `hardFails` が `[]` かつ `softSignals` が `[]` かつ `npm run build:demo` が exit 0 かつ 390×844 のスクリーンショット 1 枚を `annotation` 経路で受け取り赤を 1 往復する
- **実装要点**: `check:coherence` の JSON で `ruleCount` が 16・`pending` が 0 であることを確認する。スクショは Chat タブと Tasks タブの**どちらか 1 枚**（レイアウト差分が出たら `git revert` で該当バッチを戻し、切る位置を変える。見た目を直して合わせない）。

---

## 5. 検証コマンドの一覧（Zero-Stop が使うもの）

| 目的 | コマンド |
| :--- | :--- |
| 契約テスト | `node --test apps/web/test/paneContract.test.js` |
| ルールの単体 | `node --test apps/bridge/test/coherence.rules.test.js` |
| 触った pane のテスト | `node --test apps/web/test/chatJumpPill.test.js apps/web/test/bannerOpenDraft.test.js apps/web/test/tasksView.test.js` |
| 重複の系統テスト | `node --test apps/web/test/vibe.test.js apps/web/test/demoEmbed.test.js apps/bridge/test/repos.test.js` |
| 全テスト | `npm test` |
| ビルド | `npm run build` / `npm run build:demo` |
| 整合性 | `node scripts/check-coherence.mjs --json`（判定は `hardFails`） |
| ラチェット締め | `node scripts/check-coherence.mjs --update-baseline`（grow は CSW3-1 の 1 回だけ `--allow-grow`） |
| 行数上限 | `[ "$(wc -l < <path>)" -le 800 ]` |
| 参照の再確認 | `rg -n "<symbol>" apps/` |

**禁止**: `node -e` / `node -c`（ヘッドレスで承認待ちブロック）。外部 AI CLI の起動。`git add -A`。

---

## 6. リスクと戻し方

- **props の増殖**: 継ぎ目を切ると props が増えがち。増やすのは「移した先のフックが返す値」に限り、ChatPane / TasksPane の**外側 props は変えない**（契約テストが外側だけを見る）。
- **接続の二重購読**: `useChatSocket` と `useWakeSync` を移すとき、購読が 2 本になるとメッセージが二重に出る。CSW3-5 の Verify に `npm test` を含め、`chat` 系テストの件数が減っていないことを確認する。
- **行数の着地失敗**: CSW3-5 / CSW3-7 で 800 行を超えたら、**同じバッチ内でさらに 1 ファイル抜く**（新しいバッチを起票しない・D55）。抜き場所は「描画の葉」を優先する。
- **戻し方**: 各バッチは 1 コミット。軌道修正は `git revert <sha>` で 1 バッチ単位に戻し、切る位置を変えて再実行する（見た目を直して合わせない）。

---

## 7. 記録（実測・2026-11-27）

### 7.1 同名定義 10 種（Q3-A により 2 種だけ統合・8 種は記録のみ）

| 名前 | 定義数 | 場所 | 扱い |
| :--- | :--- | :--- | :--- |
| `safeStorage` | 3 | `apps/web/src/demo/frame.js:180` / `apps/web/src/lib/vibe.js:66` / `apps/web/src/lib/soundFx.js:34` | **CSW3-8 で 1 定義** |
| `expandHome` | 3 | `apps/bridge/src/repos.js:52` / `apps/bridge/src/review/boards.js:16` / `apps/bridge/src/gitinfo.js:82` | **CSW3-8 で 1 定義** |
| `normalizePath` | 2 | `apps/bridge/src/repos.js:38` / `apps/bridge/src/lib/session-db.js:25` | 記録のみ（前者は `~` 展開＋小文字化、後者は末尾スラッシュのみ） |
| `normPath` | 1 | `apps/bridge/src/review/boards.js:24` | 記録のみ（`normalizePath` と同系だが小文字化あり） |
| `oneLine` | 2 | `apps/bridge/src/pipeline-watcher.js:111` / `apps/bridge/src/review-watcher.js:52` | 記録のみ（切り詰め長が 220 / 180 で違う） |
| `toMs` | 3 | `apps/web/src/lib/specProgress.js:38` / `apps/web/src/lib/autopilot/studio.js:9` / `apps/bridge/src/telemetry.js:206` | 記録のみ（web と bridge で入力型が違う） |
| `toUi` | 2 | `apps/web/src/demo/snippets.js:199` / `apps/bridge/src/snippets.js:221` | 記録のみ（demo と bridge の表示規則が違う） |
| `resolveLang` | 2 | `apps/web/src/i18n/lang.js:53` / `apps/bridge/src/lang.js:58` | 記録のみ（引数の形が違う） |
| `langOf` | 2 | `apps/bridge/src/http/respond.js:73` / `apps/bridge/src/snippets.js:211` | 記録のみ（HTTP 要求とスニペット行で対象が違う） |
| `taskSpecOf` | 2 | `apps/web/src/lib/specProgress.js:56` / `apps/bridge/src/telemetry.js:243` | 記録のみ（web のタスクと bridge のジョブで対象が違う） |

### 7.2 未参照 export 66 件（CSW3-1 のルールが再測定する。ここは 2026-11-27 の写し）

完全未使用 **3 件**（削除）: `apps/web/src/lib/syncSources.js` の `syncRuntime` / `syncParams` / `resetSyncRuntime`。

同一ファイル内でのみ使用 **63 件**（`export` を外す）: `apps/web/src/demo/DemoStage.jsx` `initialVibe`／`demo/frame.js` `EMBED_FLAG` `applyDemoSettings`／`demo/snippets.js` `DEMO_TERM_BUILTIN`／`i18n/lang.js` `langOfTag`／`lib/chatReports.js` `PIPELINE_KEYS`／`lib/liveRadar.js` `ORBIT_RADIUS` `RING_RADII`／`lib/receiptCanvas.js` `KPI_COLUMNS`／`lib/reviewPaste.js` `PASTE_NOTE_MARKS` `PASTE_GLOBAL_MARKS` `PASTE_UNSELECTED_MARKS`／`lib/soundFx.js` `comboShift`／`lib/specProgress.js` `DONE_STATUS`／`lib/specSeed.js` `JOB_ACTIVE_STATUSES` `JOB_POLL_ACTIVE_MS` `JOB_POLL_IDLE_MS`／`lib/syncSources.js` `SYNC_PARAMS`／`lib/tasksView.js` `COHERENCE_THRESHOLDS`／`lib/theme.js` `RESOLVED` `readThemePref` `applyResolved`／`lib/transport.js` `sourceStateAt`／`lib/useSplitLayout.js` `isWideLayout`／`lib/vibe.js` `COMBO_MAX` `COMBO_KINDS` `SEROTONIN_HAPTIC` `comboTracker` `dispatchFx`／`apps/bridge/src/board-tick.js` `BOARD_ROW_LIMIT` `BOARD_TICK_INTERVAL_MS`／`capabilities.js` `toDirList`／`capture.js` `CAPTURE_STATE_MAX`／`coherence/allowlist.js` `readAllowlist`／`coherence.js` `IGNORE_DIRS` `SOURCE_EXT` `CHECKER_TIMEOUT_MS`／`contracts/verify.js` `VERIFY_SOURCE_HINTS` `VERIFY_COMMAND_NOUN_JA`／`http/login-page.js` `LOGIN_TEXT`／`kanban.js` `extractSpecFromBody`／`live.js` `detectToolError` `extractToolXray` `ARCHITECT_LIST_STATUSES` `ARCHITECT_RUNNING_STATUSES` `ARCHITECT_STALLED_MS` `phaseOfStatus`／`pipeline-watcher.js` `PIPELINE_KIND` `fmtDurationMin` `fmtTokenCount` `reviewRootFor`／`preview.js` `rewritePreviewHtml`／`qr.js` `bestTarget`／`repos.js` `normalizeReposConfig`／`review/boards.js` `normPath`／`review/text.js` `REOPEN_TEXT`／`review/transitions.js` `REOPEN_FALLBACK_REASON`／`server/ptyGate.js` `DEFAULT_COOLDOWN_MS`／`specs/wave-plan.js` `SHARED_HOTSPOT_FILES`／`specs.js` `SPEC_DIRS`／`telemetry.js` `DEFAULT_HOURS` `CACHE_SAVINGS_RATIO`／`term-snippets.js` `pairQrCommand`。

**注意**: この一覧は CSW3-2〜CSW3-7 の分割より前の写し。分割で新しいモジュールが増えるため、CSW3-8 では**必ずルールの出力を取り直して**から片付ける（写しをそのまま削らない）。
