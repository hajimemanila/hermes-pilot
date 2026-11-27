# モジュール分割の置き場所（COHERENCE / HOTSPOTS）

大きくなったファイルは「意味の単位」で切り出してある。**追記先を間違えると元に戻る**ので、
新しいコードは次の置き場所を先に探す（無ければ新しいファイルを作る）。
分割はどれも**公開契約を変えない**（HTTP の口・JSX の出力・CSS のカスケードは同一）。

## CSS

- 入口は `apps/web/src/styles.css` の `@import` manifest だけ（規則を書き戻さない）。
- 実体は `apps/web/src/styles/*.css`（`tokens` / `shell` / `chat` / `review` / `vibe-fx` …）。
- **読み込み順＝カスケード順**。順序は動かさない。新しい見た目は意味の合うファイルへ追記し、
  どれにも合わなければ新ファイル＋manifest に 1 行。
- `apps/web/src/styles/autopilot.css` は**入れ子 manifest**（3 行・規則を書かない）。規則は
  `autopilot-deck.css`（基底デッキ／`@media (max-width: 430px)` まで）と `autopilot-story.css`
  （`/* --- AP2-4 --- */` 以降の Story Flick・Live Sandbox・Style Gacha）。`styles.css` は
  `autopilot.css` を 1 行 import するだけで 31 行のまま動かさない。
- 各ファイルは ratchet の上限（`scripts/coherence-baseline.json` の `maxLines` = 800 行）以下に保つ。
- テストは `apps/web/test/helpers/styles.js` の `readStyles()` で全ソースを展開して読む
  （`apps/web/test/stylesManifest.test.js` が manifest・参照先・行数・`:root` の単一性を機械検査）。
- 分割前後で**ビルド済み CSS バンドルがバイト一致**することを実測して確認した（2026-11-21）。

## チャットの表示パーツ

- `apps/web/src/features/chat/ChatParts.jsx`: 本文 Markdown / ツール行 / 統合レポートカード /
  過去セッション一覧 / 入力欄の自動伸長。
- 会話全体の状態（ソケット・送信・スクロール・添付・ドロワー開閉）は `apps/web/src/features/ChatPane.jsx` に残す。

## レビューの表示パーツ

- `apps/web/src/features/review/Chip.jsx`: `.ak-chip` のチップ（一覧の行・「推奨」・読取専用が共有）。
  定義は 1 箇所だけに置く。
- `apps/web/src/features/review/ReviewForms.jsx`: 設問から描く `StandardForm` / sandbox iframe と
  貼り付け回答の `IframeForm` / 詳細シートへの `SheetLink`、挿絵の拡大用 `toZoom`（内部専用）。
- `apps/web/src/features/review/ReviewDetail.jsx`: 判断待ち以外の読み取り専用詳細 `ReadOnlyDetail`
  （回答履歴・before/after・再オープン）。
- `apps/web/src/features/review/AnnotationCreate.jsx`: 「＋ 注釈」シート `NewAnnotationSheet` と、
  開く前の先読み `prefetchAnnotationData`（キャッシュはこのモジュールが持つ）。
- 一覧（`ItemRow`）・作業ログ（`WorkerFeed`）・タブ・選択状態・送信後の遷移（次の判断待ちを開く／
  全件完了バナー）は `apps/web/src/features/ReviewPane.jsx` に残す。

## Bridge の HTTP 層

- `apps/bridge/src/http/respond.js`: 応答の共通形（`sendJson` / `sendError` / `sendFailure`）・本文読み取り・
  `langOf`・`MIME`。
- `apps/bridge/src/http/rate-limit.js`: 書き込み / ペアリング / 読み取りの 3 系統（バケットを混ぜない）。
- `apps/bridge/src/http/login-page.js`: ログイン画面の HTML と日英文言。
- `apps/bridge/src/http/static-files.js`: `dist` → `dist.prev` フォールバックを含む静的配信。
- ルーティングとドメイン判断は `apps/bridge/src/server.js` に残す（ここは「読む／書く」だけ）。

## Bridge の A2B パイプライン最適化

- 入口は `apps/bridge/src/pipeline-optimizer.js` の**バレルだけ**（明示的な named re-export・実装を置かない）。
  公開している 23 export は分割前と同一なので、新しい呼び出し元はこのパスを import する。
- 実体は `apps/bridge/src/pipeline/` の 4 ファイル。依存は `paths` ← `soul` ← `profile` ← `skills` の DAG
  （`pipeline/` の内部は直接 import し、バレル経由にしない＝循環を作らない）。
  - `paths.js`: `REPO_ROOT` / `BUNDLED_SKILLS` / `DEFAULT_SKILLS_SRC` だけの葉。
  - `soul.js`: A2B マーカーと規範文・`mergeSoul` / `backupStamp` / `nextBackupPath` / `applySoulFile` /
    `inspectSoulFile` / `profileSoulState` / `optimizeHermesSoul`（† の 3 つは `pipeline/` 内部共有専用）。
  - `profile.js`: プロファイル名の正規化・探索と `SOUL.md` の同期（`ensurePilotProfile` / `optimizeProfileSouls`）。
  - `skills.js`: 同梱スキルのファイル配置と適用状況（`installSkill` / `optimizeAgentSkills` / `getOptimizeStatus`）。
- `optimizeAntigravitySkills`（現行名 `optimizeAgentSkills`）は `pipeline/skills.js` が定義元なので、
  `scripts/check-coherence.mjs` の `LEGACY_SYMBOLS` の allow にこのパスが入っている（消すと hard fail）。

## Bridge の旧レビュータグ（読み取り専用の互換）

- `apps/bridge/src/review/legacy-tags.js`: 移行前データの `[akapen]` を**読むだけ**受ける唯一の置き場所
  （`LEGACY_REVIEW_TAG` / `LEGACY_REVIEW_NAME` / `LEGACY_REVIEW_LIKE`）。書き込み側は常に `[review]`。
- リテラルを増やさない: SQL はテンプレート文字列、正規表現は `new RegExp` で組み立てる
  （マッチ挙動は変えない）。この 1 ファイルだけが `check-coherence` の旧名 allow に入っている。
- 旧ボードの履歴は `[akapen]` のまま残す（移行スクリプトは body を書き換えない仕様）。

## 分割後の地図

```text
apps/bridge/src/
  pipeline-optimizer.js      ← バレル（23 export を再エクスポート・60 行未満）
  pipeline/
    paths.js                 ← REPO_ROOT / BUNDLED_SKILLS / DEFAULT_SKILLS_SRC（葉）
    soul.js                  ← A2B_* / backupStamp / mergeSoul / nextBackupPath /
                               applySoulFile† / inspectSoulFile† / profileSoulState† / optimizeHermesSoul
    profile.js               ← DEFAULT_PILOT_PROFILE / PROFILE_SOUL_CREATE_IF_MISSING /
                               sanitizePilotProfile / pilotProfileSkillsDir / listProfileNames /
                               ensurePilotProfile / optimizeProfileSouls
    skills.js                ← SKILL_TARGET_CANDIDATES / installSkill / optimizeAntigravitySkills /
                               optimizeAgentSkills / getOptimizeStatus
  review/legacy-tags.js      ← LEGACY_REVIEW_TAG（[akapen] の唯一の定義）
  review/autopilot-contract.js ← Autopilot Fast-Lane 定数（STYLE_PRESETS / Auto-Resolve / Promote）

scripts/
  render-mocks.mjs           ← Fast-Lane 並列 CDP モック描画＆Pre-Flight Visual Gate CLI

skills/
  autopilot-fastlane/SKILL.md ← Autopilot Fast-Lane 汎用スキル（サンドボックス描画 / Promote 手順）

apps/web/src/features/
  ReviewPane.jsx             ← TABS / ItemRow / WorkerFeed / ReviewPane（約 748 行）
  review/Chip.jsx            ← Chip（ReviewPane / ReviewForms / ReviewDetail が共有）
  review/ReviewForms.jsx     ← toZoom / StandardForm / IframeForm / SheetLink
  review/ReviewDetail.jsx    ← ReadOnlyDetail
  review/AnnotationCreate.jsx← downscaleFile / prefetchAnnotationData / findTarget / NewAnnotationSheet
  autopilot/
    AutopilotDeck.jsx        ← デッキの状態・副作用・スワイプ物理を束ねる親（葉は下の 3 枚）
    DeckCardStage.jsx        ← 提示専用の葉: スタック 3 枚＋前面カード（状態なし）
    DeckRemixBar.jsx         ← 提示専用の葉: remix バー・注記フォーム・StyleGachaBar 差し込み
    DeckActionBar.jsx        ← 提示専用の葉: undo ピル＋アクションバー（✕ ⏸ 🖍 ♥）
    AutopilotCards.jsx       ← StarterStage / LiveStudioCard / CompletionCard / OptionMockPreview
    AutopilotView.jsx        ← Zero-Fork レンズ投影・AutopilotLensToggle・AutopilotSwipeLink
    MockCompareStage.jsx     ← 0.1秒フリック比較・長押し Peek・▶ 触ってみる iframe（sandbox 強制）
    StyleGachaBar.jsx        ← 5種スタイル・ガチャ（上限3回制御）
    LiveRadarCard.jsx        ← Panoptes 着想・純粋 React+SVG レーダー BI（subscribeSync のみ）
    BeforeAfterTimelapse.jsx ← 完了カード用ビフォー・アフター タイムラプス比較

apps/web/src/lib/autopilotDeck.js  ← 再エクスポート専用バレル（公開契約 27 名をここで固定。実装を置かない）
apps/web/src/lib/autopilot/
  deck-core.js                     ← 定数・データ・ジェスチャ判定（13 export）
  deck-flow.js                     ← デッキ構築・カード切替・回答/undo/remix 進行（9 export）
  studio.js                        ← 4 幕ステージ判定・成果物抽出・実況 i18n（5 export）
apps/web/src/lib/liveRadar.js      ← LiveRadarCard 座標投影・トークン集計純関数
apps/web/src/styles/autopilot.css  ← Autopilot 専用スタイル（tokens.css トークンのみ使用）
apps/web/src/styles/autopilot-radar.css ← LiveRadarCard SVG ＆ タイムラプス専用 CSS
```

† は「分割前は private だったが、モジュール境界を越えるので export する」もの。`pipeline/` 内の
内部共有であることをコメントで明示する（公開契約には数えない）。

## 死んだコードの再測定（SEMM-10 / 2026-11-27 実測）

- `rg` 参照ゼロ export **0 件**（`lib/autopilot/*.js` 27・`lib/autopilotDeck.js` 27・`features/autopilot/*.jsx` 17・`bridge/src/architect/*.js` 63 を全数）・未参照 `.ap-*` クラス **0 件**（133 クラス中）。削る対象は無い。
- 注意: `ap-stamp-{left,right,up,down}` と `ap-theme-{cyan,emerald,amber,violet}` の 8 つは**文字列で書かれていない**（`ap-stamp-${swipe.direction}` / `ap-theme-${theme}` のテンプレート結合）。リテラル検索だけで判定すると誤って「未参照」に見えるので、動的結合の接頭辞まで見る。
