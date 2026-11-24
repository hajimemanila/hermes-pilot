# SPEC: 整合性スイープの分割バッチ（MRG-1〜MRG-5）

- 状態: **ドラフト（赤ペン回答済み・バッチ未起票）**
- 対象: `~/projects/hermes-mobile-pwa` @ `fbb9d59`（2026-11-24 実測。`npm run verify` は緑）
- 入力: `sheets/spec-coherence-split-batches-1.json` の Q1〜Q4
- 回答: **Q1〜Q4 すべて A**（`spec-coherence-split-batches-1.answer.json`）
- 起票: **しない**（「File batches & start」待ち）

## 0. この SPEC の前提（すべて実測値）

- `apps/bridge/src/pipeline-optimizer.js` = **719 行 / export 23**（シートの「18」は数え漏れ。実測は 23）
- このモジュールを import するのは **6 ファイル**
  - `apps/bridge/src/config.js:4`（2 シンボル）
  - `apps/bridge/src/server.js:42`（4 シンボル）
  - `bin/hermes-pilot.mjs:30`（5 シンボル）
  - `apps/bridge/test/pipelineOptimizer.test.js:37`（**19 シンボル**。シートの「12」は誤り）
  - `apps/bridge/test/routeContracts.test.js:30`（`A2B_RULES`）
  - `scripts/check-coherence.mjs:771`（allow 1 行だけ。import ではない）
  - `apps/bridge/test/coherence.rules.test.js:229` は**パス文字列のフィクスチャ**（import ではない）
- `apps/web/src/features/ReviewPane.jsx` = **1,489 行 / export 3**
  - `ReviewPane` `:930`（利用: `apps/web/src/App.jsx:19`）
  - `WorkerFeed` `:112`（利用: `apps/web/src/features/tasks/TaskDetailSheet.jsx:25`）
  - `parsePastedReply` `:38`（**参照ゼロの再エクスポート**。import 元はすべて `lib/reviewPaste.js` 直）
- ソース文字列を読むテストは **2 本**（`netRecovery.test.js:143` / `reviewRepoMemory.test.js:25`）
- `npm run check:coherence` = `14 rules, 0 hard fail(s), 2 soft signal(s)`
  - `baseline-ratchet` 7 ファイル縮小（`ChatPane.jsx` 2780→2776 / `TasksPane.jsx` 1911→1910 / `apps/dashboard/index.js` 2014→1991 / `review.js` 791→733 / `pilot_dashboard.py` 1448→1440 ×2 / `bin/hermes-pilot.mjs` 997→993）
  - `akapen-residual` 21 件（10 ファイル）
- `git-hotspot` は**スクリプト側の 14 ルールに入っていない**。ブリッジ層 `apps/bridge/src/coherence.js:220` `gitHotspots()` の判定で、`gitHotspots()` 実測はちょうど 2 件、**どちらも `touches=5`**（閾値 5・次点 4）。窓は直近の `(coherence):` コミットの 1 秒後から（`coherence.js:196`）
- ラチェット台帳 `scripts/coherence-baseline.json`: `maxLines: 800` / `ReviewPane.jsx`: 1489 / **`scripts/check-coherence.mjs`: 1590（現在の実測と完全一致＝1 行でも増やすと grow 判定）** / `pipeline-optimizer.js` は未登録（800 未満なので不要）
- `akapen` 21 件の内訳 = **コメント 13 / 実行時 8**（実行時 8 = データ互換 5 + プロトコル互換 3）
  - データ互換 5: `inbox.js:102` / `pipeline-watcher.js:53` / `review-watcher.js:111` / `review/boards.js:272` / `review/text.js:12`
  - プロトコル互換 3: `review/sheet-html.js:335` / `:451` / `ReviewPane.jsx:357`
- プロトコル互換の生産者は**もう存在しない**: シート HTML は常に `review:reply` を送る（`sheet-html.js:427`）。`~/.hermes/plugin-data/hermes-pilot/review/` 配下に `akapen:reply` を含む資産 **0 件**、`__akapenSubmit` を含む資産 **0 件**
- `[akapen]` タグを本文に持つタスクは全 21 ボードで **1 件だけ**（`hermes-pilot/t_5878c619`・done）。移行スクリプトは body を書き換えない仕様で固定されている（`apps/bridge/test/migrate.test.js:145-173`「rewriting [akapen] -> [review] is retired」）

## 1. 決定（Q1〜Q4 = A）

- **Q1**: `apps/bridge/src/pipeline/` に 3 分割＋共有 1。`pipeline-optimizer.js` は**再エクスポート専用のバレル**にし、公開契約（23 export・6 import 元・テストの 19 import）を 1 文字も変えない
- **Q2**: `ReviewPane.jsx` は**葉コンポーネントの抜き出しだけ**。`ReviewPane` / `WorkerFeed` / `ItemRow` / `TABS` は現ファイルに残す
- **Q3**: 「ゼロ参照 export」→「同一式の二重定義」の順で削る。ゼロ参照は 1 件実在（`parsePastedReply` の再エクスポート）ので、バッチは空にならない
- **Q4**: ソフト 4 件すべてを受入対象。`baseline-ratchet` と `akapen-residual` は **0 件**、`git-hotspot` は「分割後に再検出されない」を条件にする

### 回答 A からの差分（実測で判明したもの・すべて A の主旨の範囲内）

1. export は 18 ではなく **23**、テストの import は 12 ではなく **19**（数え直し）
2. `ReviewPane.jsx` の残行数は約 450 ではなく **約 748**（移動するのは `:189-929` の 741 行。`:1-188` と `:930-1489` が残る）
3. `reviewRepoMemory.test.js` は**無変更では通らない**。4 本のうち 2 本（`findTarget` と `rememberReviewRepo`）が抜き出す側の行を読むため、読み先を 2 ファイル連結に変える（アサーションは 1 文字も変えない）。`netRecovery.test.js` は無変更で通る
4. `akapen` の「hermes-pilot 表記へ移行」は**データ互換 5 件には適用できない**（移行スクリプトが body を書き換えない仕様のため、旧ボードは永久に `[akapen]` を持つ）。代わりに 1 ファイルへ閉じ込めて allowlist に 1 エントリだけ足す。**プロトコル互換 3 件は生産者が 0 なので削除**する

## 2. 分割後のかたち

```text
apps/bridge/src/
  pipeline-optimizer.js      ← バレル（23 export を再エクスポート・60 行未満）
  pipeline/
    paths.js                 ← REPO_ROOT / BUNDLED_SKILLS / DEFAULT_SKILLS_SRC（葉）
    soul.js                  ← A2B_* / backupStamp / mergeSoul / nextBackupPath /
                               applySoulFile† / inspectSoulFile† / profileSoulState† / optimizeHermesSoul
    profile.js               ← DEFAULT_PILOT_PROFILE / PROFILE_NAME_RE† / PROFILE_SOUL_CREATE_IF_MISSING /
                               sanitizePilotProfile / pilotProfileSkillsDir / listProfileNames /
                               ensurePilotProfile / optimizeProfileSouls
    skills.js                ← SKILL_TARGET_CANDIDATES / installSkill / optimizeAntigravitySkills /
                               optimizeAgentSkills / getOptimizeStatus
    review/legacy-tags.js    ← LEGACY_REVIEW_TAG（[akapen] の唯一の定義）

apps/web/src/features/
  ReviewPane.jsx             ← TABS / ItemRow / WorkerFeed / ReviewPane（約 748 行）
  review/Chip.jsx            ← Chip（ReviewPane と AnnotationCreate が共有）
  review/ReviewForms.jsx     ← toZoom / StandardForm / IframeForm / SheetLink
  review/ReviewDetail.jsx    ← ReadOnlyDetail
  review/AnnotationCreate.jsx← downscaleFile / prefetchAnnotationData / findTarget / NewAnnotationSheet
```

- † は「分割前は private だったが、モジュール境界を越えるので export する」もの。`pipeline/` 内の内部共有であることをコメントで明示する（公開契約には数えない）
- 依存は **DAG**（`skills → profile → soul → paths`）。`pipeline/` 内部は**直接 import**（バレル経由にしない＝循環を作らない）。バレルは外部の 6 か所専用

## 3. バッチ

すべて `[Mode: Zero-Stop]`。Verify は `npm run verify` を基本に、バッチ固有のコマンドを前に足す。
**1 バッチ 1 テーマ・1 コミット**（MRG-5 のみ `chore(coherence):` 接頭辞）。

### MRG-1 — bridge: `pipeline-optimizer.js` を 3 分割＋バレル化

触るファイル: `apps/bridge/src/pipeline/{paths,soul,profile,skills}.js`（新規） / `apps/bridge/src/pipeline-optimizer.js`（バレルへ置換） / `scripts/check-coherence.mjs:771`（allow へ 1 パス追加） / `docs/MODULES.md`（置き場所を追記）

手順:
1. `paths.js` を作る（他を import しない葉）
2. `soul.js` ← `:26-228` 相当（A2B 定数・`mergeSoul`・`backupStamp`・`nextBackupPath`・`applySoulFile`・`inspectSoulFile`・`profileSoulState`・`optimizeHermesSoul`）
3. `profile.js` ← `:230-512` 相当（プロファイル名・`sanitizePilotProfile`・`pilotProfileSkillsDir`・`listProfileNames`・`ensurePilotProfile`・`optimizeProfileSouls`）
4. `skills.js` ← `:513-719` 相当（`SKILL_TARGET_CANDIDATES`・`installSkill`・`optimizeAntigravitySkills`・`optimizeAgentSkills`・`getOptimizeStatus`）
5. `pipeline-optimizer.js` は**明示的な named re-export だけ**のバレルにする（`export *` は使わない＝契約を目で数えられるようにする）
6. `scripts/check-coherence.mjs:771` の `allow` を `['apps/bridge/src/pipeline-optimizer.js', 'apps/bridge/src/pipeline/skills.js']` にする。**同一行内で済ませ、この行を増やさない**
   （これを忘れると `optimizeAntigravitySkills` が `pipeline/skills.js` 側で `legacy-reentry` の **hard fail** になる）

受入条件:
- バレルの named export が **23 件**で、名前が分割前と一致する（`import * as m` のキーをソートして比較。記録済みの一覧は §5）
- `node --test apps/bridge/test/pipelineOptimizer.test.js apps/bridge/test/routeContracts.test.js apps/bridge/test/coherence.rules.test.js` が緑（テストは 1 行も変えない）
- 新ファイルはどれも 400 行未満、`pipeline-optimizer.js` は 60 行未満
- `node scripts/check-coherence.mjs --json` の `hardFails` が `[]`、`softSignals` の件数が増えていない
- `scripts/check-coherence.mjs` が **1590 行のまま**（増減させない）

Verify: `node --test apps/bridge/test/pipelineOptimizer.test.js apps/bridge/test/routeContracts.test.js apps/bridge/test/coherence.rules.test.js && npm run verify`

### MRG-2 — web: `ReviewPane.jsx` から葉コンポーネントを抜く

触るファイル: `apps/web/src/features/review/{Chip,ReviewForms,ReviewDetail,AnnotationCreate}.jsx`（新規） / `apps/web/src/features/ReviewPane.jsx`（置換） / `apps/web/test/reviewRepoMemory.test.js:25`（読み先だけ変更） / `docs/MODULES.md`

手順:
1. `Chip`（`:58-61`）を `review/Chip.jsx` へ（`ItemRow` と `NewAnnotationSheet` の両方が使うため共有）
2. `review/ReviewForms.jsx` ← `toZoom`（`:40-43`）＋ `StandardForm`（`:189-345`）＋ `IframeForm`（`:346-441`）＋ `SheetLink`（`:442-453`）
3. `review/ReviewDetail.jsx` ← `ReadOnlyDetail`（`:454-658`）
4. `review/AnnotationCreate.jsx` ← `downscaleFile`（`:659-686`）＋ `prefetchAnnotationData`（`:687-709`）＋ `findTarget`（`:710-720`）＋ `NewAnnotationSheet`（`:721-929`）
5. `ReviewPane.jsx` に残すのは `TABS`（`:51-57`）/ `ItemRow`（`:62-111`）/ `WorkerFeed`（`:112-188`）/ `ReviewPane`（`:930-1489`）
6. `reviewRepoMemory.test.js:25` を「2 ファイルを連結して読む」に変える（アサーションは変更しない）:
   ```js
   const pane = ['ReviewPane.jsx', 'review/AnnotationCreate.jsx']
     .map((rel) => fs.readFileSync(path.resolve(here, '../src/features', rel), 'utf8')).join('\n')
   ```
7. props は明示的に並べ直す（`notify` / `onSubmitted` / `onReopened` / `onOpenChat` / `onStartAnnotation`）。型が無いので、既存テスト＋目視でしか捕まらない点に注意

受入条件:
- `ReviewPane.jsx` ≤ 800 行（実測見込み 748）／新ファイルはどれも 300 行未満
- `node --test apps/web/test/reviewRepoMemory.test.js apps/web/test/netRecovery.test.js` が緑
- `netRecovery.test.js` は**1 文字も変えずに**通る（`items: prev.items` と `useWakeSync(() =>` が `ReviewPane` 側に残っている証明）
- `App.jsx` / `TaskDetailSheet.jsx` の import 行が無変更
- `npm run build` が通り、`npm run verify` が緑

Verify: `node --test apps/web/test/reviewRepoMemory.test.js apps/web/test/netRecovery.test.js && npm run verify`

### MRG-3 — 重複と死んだコードを削る

手順（判断はすべて `rg` の実測に基づく。結果はコミット前に comment へ貼る）:
1. `export { parsePastedReply }`（`ReviewPane.jsx:38`）を削除する。参照はゼロ（import 元は `App.jsx` / `TaskDetailSheet.jsx` / テストすべて `lib/reviewPaste.js` 直）。`IframeForm` が使う import は `review/ReviewForms.jsx` 側へ移す
2. 分割で生じた重複の統合: 新ファイルは `lib/reviewView.js` / `lib/reviewPaste.js` / `lib/repoPicker.js` を**直接** import（バレル経由禁止）、`Chip` は 1 箇所、`toZoom` は `ReviewForms` のみ
3. パス組み立ての重複: `path.resolve(import.meta.dirname, …)` が `pipeline/paths.js` の 1 箇所だけであることを `rg "import.meta.dirname, '" apps/bridge/src` で確認（現状 2 箇所。`config.js:138` の `web/dist` は別目的なので残す＝1 箇所に統合しない。判断理由を記録）
4. 未使用 import・`catch { return [] }`（`swallow-owner` の対象外ファイルに無いこと）を確認

受入条件:
- 削除は最低 1 件（`parsePastedReply` 再エクスポート）＝ バッチが空にならない
- `rg` の実行結果（コマンドと出力）をコミットメッセージかタスク comment に残す
- `npm run verify` が緑

Verify: `npm run verify`

### MRG-4 — ソフト 2 件を 0 にする（`akapen-residual` 21 → 0 / `baseline-ratchet` 7 → 0）

手順:
1. **コメント 13 箇所**を「旧名」表記へ書き換える（リテラルを消す）:
   `review.js:99`（2） / `pipeline-watcher.js:21`・`:110` / `review-watcher.js:11` / `review/media.js:350`（2） / `review/boards.js:264` / `review/text.js:9` / `review/sheet-html.js:334` / `ReviewPane.jsx:356` / `lib/reviewView.js:410`（2）
2. **データ互換 5 箇所**を `apps/bridge/src/review/legacy-tags.js` に集約する:
   `export const LEGACY_REVIEW_TAG = '[akapen]'` を作り、`inbox.js:102` / `pipeline-watcher.js:53` / `review-watcher.js:111` / `review/boards.js:272` / `review/text.js:12` がこれを参照する（SQL はテンプレート文字列、`LINE_RE` は `new RegExp` で組み立てる。**マッチ挙動は変更しない**）
3. **プロトコル互換 3 箇所を削除する**（生産者 0・旧資産 0 の実測つき）:
   `review/sheet-html.js:335`（`akapen:reply` の受け口） / `:451`（`window.__akapenSubmit` エイリアス） / `ReviewPane.jsx:357`（`akapen:reply` の受け口）
   あわせて `apps/bridge/test/review.test.js:724-725`（旧タグを読む）は**残す**・`:757-760`（エイリアス 2 本）と `:825`（受け口の文字列）は**現行のみ**を主張する形に更新する
4. `AKAPEN_ALLOWED`（`scripts/check-coherence.mjs`）に `apps/bridge/src/review/legacy-tags.js` を 1 行＋理由コメント 1 行で追加する。**このファイルは 1590 行ちょうどなので、同じファイル内で 2 行詰めて 1590 を維持する**（`--allow-grow` は使わない）
5. `node scripts/check-coherence.mjs --update-baseline` を実行し、縮小 7 ファイルを確定する（`ReviewPane.jsx` 1489 → 実測値、`review.js` 791 → 733 等）。`--allow-grow` は付けない

受入条件:
- `node scripts/check-coherence.mjs --json` が `hardFails: []` かつ `softSignals: []`
- `rg -i akapen apps/bridge/src apps/web/src` のヒットが `review/legacy-tags.js` の 1 行だけ（＋削除済みテスト更新分）
- `npm run verify` が緑
- 副作用の明示: `hermes-pilot/t_5878c619`（done・旧ラウンド）は `[akapen]` タグのまま履歴に残る。レビュー一覧からは外れるが、**データは書き換えない**（移行スクリプトの「body は書き換えない」仕様を維持）

Verify: `node scripts/check-coherence.mjs --json && npm run verify`

### MRG-5 — 結合検証と git-hotspot の再検出確認

手順:
1. `npm run verify` をフルで 1 回
2. `npm run check:coherence -- --json` → `hardFails: []` / `softSignals: []` を記録
3. `gitHotspots()` を直呼びして 2 ファイルの `touches` を記録（分割前の記録値は**両方 5**）
4. 最終コミットを `chore(coherence): split pipeline-optimizer and ReviewPane …` の形にする（`coherence.js:196` の窓がこのコミットの 1 秒後から再開する）
5. 同じプローブを再実行し、`pipeline-optimizer.js` と `ReviewPane.jsx` が**出ないこと**を確認（出る場合は `touches` が 5 未満であること）

受入条件:
- `npm run verify` 緑
- `--json` が 0 hard / 0 soft
- hotspot プローブの before/after 出力をタスクに添付
- `docs/MODULES.md` に `pipeline/` と `review/` の置き場所が書かれている（追記先を間違えると戻るため、§2 の表をそのまま載せる）

Verify: `npm run verify`

## 4. 全体の受入条件

- `npm run verify` が緑（`npm test` / `check:dashboard` / `check:pwa` / `check:oauth` / `build` / `audit:responsive` / `check:term-enter` / `check:coherence` / `check:cold-install`）
- `check:coherence`: 14 rules / **0 hard / 0 soft**
- `git-hotspot`: 対象 2 ファイルが分割後に再検出されない
- 公開契約は不変: bridge の 23 export・6 import 元・HTTP の口・JSX の出力・CSS のカスケード
- 新ファイルはすべて 800 行未満（`MODULES.md` の上限）。`scripts/check-coherence.mjs` は 1590 行のまま

## 5. 分割前の export 一覧（MRG-1 の照合に使う・23 件）

```text
REPO_ROOT BUNDLED_SKILLS DEFAULT_SKILLS_SRC A2B_START A2B_END A2B_RULES A2B_RULE_BLOCK
backupStamp mergeSoul nextBackupPath optimizeHermesSoul
DEFAULT_PILOT_PROFILE sanitizePilotProfile PROFILE_SOUL_CREATE_IF_MISSING
pilotProfileSkillsDir listProfileNames ensurePilotProfile optimizeProfileSouls
SKILL_TARGET_CANDIDATES installSkill optimizeAntigravitySkills optimizeAgentSkills getOptimizeStatus
```

## 6. 罠（ゼロストップで踏みやすい順）

1. **`check-coherence.mjs` は 1590 行ちょうど**。1 行足すと `baseline-ratchet` の grow（`fatal: true`。`--strict` でのみ hard に昇格するが、目標は soft 0 なので実質アウト）。触るときは同じファイル内で同数を詰める
2. **`LEGACY_SYMBOLS` の allow は MRG-1 と同じコミットで更新**。忘れると `legacy-reentry` が hard fail してゼロストップが止まる
3. **`--update-baseline` は新しいファイルを台帳に追加しない**（既存エントリを下げる／消えたものを落とすだけ）。分割で生まれた新ファイルは台帳に載らず、800 行ルールだけが効く
4. `reviewRepoMemory.test.js` は**無変更では通らない**（§1 の差分 3）。「テストが通った」を分割の根拠にするなら、読み先の変更を先に入れる
5. `Chip` / `toZoom` は移動先が 1 つに定まらないと循環 import になる（`Chip` は共有ファイル、`toZoom` は `ReviewForms` のみ）
6. `[akapen]` の**データ互換は消せない**（移行スクリプトが body を書き換えない仕様＋`migrate.test.js:145-173` が固定）。消すと旧ボードのレビューが消える

## 7. 次

- このドラフトで良ければ「File batches & start」→ MRG-1 から順に起票（1 バッチ 1 タスク・全部 `[Mode: Zero-Stop]`）
- 起票時の Verify は各バッチの `Verify:` 行をそのまま使う
