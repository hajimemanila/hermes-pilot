# SPEC-AUTOPILOT-V2 — Autopilot Fast-Lane Harness, Interactive Sandbox & LiveRadar BI

- **Status**: archived
> **Status:** Archived (completed AP2-1..AP2-6)  
> **Batch prefix:** `AP2`  
> **Supersedes / Extends:** `docs/SPEC-AUTOPILOT.md` (Archived `AP-1..AP-6`)  
> **Target:** Hermes Mobile PWA (`apps/web`, `apps/bridge`, `scripts`, `skills`)

---

## 1. 改善アイデア評価マトリクス（採否・補正方針）

`video_1.mp4` 観測と現行アーキテクチャ（`specs.js` / `live.js` / `review/sheet-html.js` / `audit-responsive.mjs` / `sync-owner` / `baseline-ratchet`）を照合した全10項目の評価結果。

| # | カテゴリ / 提案 | 判定 | 技術評価・設計補正 | 割当バッチ |
|---|---|---|---|---|
| 1-① | 技術的・後処理系質問の Auto-Resolve | **採用（補正あり）** | UXノイズ除去に有効。ただし「不可逆・破壊的変更（データ削除・外部公開・課金）」だけは自動決済禁止とし、計画プロンプト側で Safe Auto-Resolve ルールを明文化する。 | `AP2-2` |
| 1-② | 選択肢 A/B/C の瞬時フリック比較 | **採用** | 上部ピル押下より親指到達性が圧倒的に高い。モック領域の左右45%タップ／スワイプ＋長押し一時切替（0.1秒フリック）＋上部ピル同期を実装し、赤入れ座標は選択中案IDに紐づける。 | `AP2-4` |
| 1-③ | テキスト質問のミニプレビュー自動生成 | **採用** | テキストのみの Q2 等で認知負荷の段差を解消できる。`render-mocks.mjs` に軽量スニペットモード（`height <= 120px` パーツ単位 HTML→PNG）を持たせ、`review` カードへ自動添付する。 | `AP2-1`, `AP2-2` |
| 2-① | 並列一括モックレンダラー (`render-mocks.mjs`) | **採用（補正あり）** | `scripts/audit-responsive.mjs` と同型の「ゼロ外部npm依存・Chrome CDP + Node 22 built-in `WebSocket`」で実装。1ブラウザ起動で複数HTMLを並列タブ描画し `390x844` PNG＋計測JSONを一括返却する。 | `AP2-1` |
| 2-② | Pre-Flight Visual Gate | **採用（補正あり）** | 破綻モック（`scrollWidth > clientWidth`、`naturalWidth === 0` 画像欠損、重大重なり、低コントラスト）を人間の目に触れさせない点は最重要。`render-mocks.mjs` 内で DOM 検査し、`failed` 案はワーカーへ自動差戻し、通過案のみカード化する。 | `AP2-1` |
| 2-③ | Sandbox → Cockpit 昇格 (Promote) プロトコル | **採用（補正あり）** | `.hermes-pilot/sandbox/` は `.gitignore` 対象とし、プロトタイプ中は本番ソース変更・ユニットテストをバイパス。`♡ 決定` 時に確定HTML＋スクショ＋赤入れJSONを Cockpit 用 `SPEC` / バッチへ昇格させる。 | `AP2-2` |
| 3-① | カード内「触れるモック」（Live Sandbox Toggle） | **採用（厳格CSP補正）** | モバイル片手操作感の確認に必須。ただし `srcDoc` ではなく `GET /api/review/:id/mock` 経由で配信し、`REVIEW_SHEET_CSP` と同等の **`sandbox="allow-scripts allow-forms"`（`allow-same-origin` 禁止・不透明オリジン）** を強制して親アプリとのXSS/ストレージ隔離を担保する。 | `AP2-3`, `AP2-4` |
| 3-② | スタイル・ガチャ（1タップ方向転換） | **採用（コスト制御補正）** | `× 次案` の延長としてライト層に刺さる。無制限再生成による遅延/トークン浪費を防ぐため、プリセット5種（ミニマル / ネオン / レトロ / エディトリアル / ベントー）＋1カードあたりガチャ上限（既定3回）とプロンプト注入契約を設ける。 | `AP2-2`, `AP2-4` |
| 3-③ | ビフォー・アフター タイムラプス | **採用（実装軽量化）** | Phase 1 の `screenshot` / `render-mocks` 出力と確定モックを軽量サムネイル比較／GIF・フレーム切替カードとして完了画面（`AutopilotDeck` 完了カード）に表示。動画エンコード依存は持たせず Canvas / CSS クロスフェード＋比較スライダーで実現する。 | `AP2-5` |
| 4-① | 動的レーダーBI (`LiveRadarCard` / Panoptes着想) | **採用（Clean-Room & Zero-Dep）** | `huwhitememes/panoptes`（MIT）の概念を参照しつつ、外部チャートライブラリ・新規 `setInterval` ポーリングを一切追加せず、純粋 React + SVG（`~220px` 円形レーダー＋3〜4行ライブフィード）と既存の `subscribeSync('live' \| 'usage' \| 'reviewWaiting')` のみで実装する。 | `AP2-3`, `AP2-5` |

---

## 2. 技術設計詳細

### 2.1 ハーネス・ファストレーン (`scripts/render-mocks.mjs`)

- **ゼロ依存原則**: `scripts/audit-responsive.mjs` と同様に Chrome/Chromium バイナリを検出・起動し、Node 22 組み込み `WebSocket` で CDP を直接駆動する（Puppeteer / Playwright 等を `package.json` に追加しない）。
- **入出力インターフェース**:
  - 入力: JSON マニフェスト（`variants: [{ id, htmlPath, viewport?: { width: 390, height: 844 }, snippetSelector?: string }]`）または `--dir .hermes-pilot/sandbox/<jobId>`。
  - 実行: 1ブラウザプロセス内で最大3〜4タブを `Promise.all` 並列展開し、`Page.captureScreenshot` と DOM Pre-Flight 検査を一括実行。
  - 出力: `variants[].{ id, status: "pass" | "fail", screenshotPath, width, height, metrics: { scrollWidth, clientWidth, brokenImages, overlapCount, lowContrastCount }, failures: string[] }`。
- **Pre-Flight Visual Gate 基準**:
  1. `scrollWidth <= clientWidth`（モバイル 390px 横溢れゼロ）
  2. `document.querySelectorAll('img')` すべてで `complete && naturalWidth > 0`
  3. インタラクティブ要素間の重なり（`overlapCount === 0`）および極端な低コントラスト検出
  4. `snippetSelector` 指定時は該当要素のバウンディングボックスのみクリップ撮影（Q2等のミニプレビュー用）
- **Git汚染防止**: `.gitignore` に `.hermes-pilot/` を追加し、サンドボックス生成物（HTML/PNG/中間JSON）が作業ツリーを汚さないことを保証する。

### 2.2 Auto-Resolve・Promote 契約・スタイルガチャ仕様

- **Safe Auto-Resolve ルール**:
  - 自動決済可: ファイル配置パス、一時フラグ撤去、内部コンポーネント分割、i18n キー命名、CSS トークン名など、ユーザー体験・視覚・不可逆データに影響しない決定。
  - 自動決済不可（必ずカード化）: レイアウト方向性、配色・トーン、ナビゲーション配置、情報優先度、外部公開・破壊的操作。
- **Sandbox → Cockpit Promote プロトコル**:
  - Autopilot フェーズでは本番 `apps/web/src` を編集せず `.hermes-pilot/sandbox/<sessionId>/` のみ出力する。
  - `♡ 決定`（または最終案確定）時に、Bridge 経由で `{ chosenVariantId, mockHtmlPath, screenshotPath, annotations, styleTag }` を含む Promote ペイロードをまとめ、Cockpit 側の次ステップ（正規 `Zero-Stop` 実装バッチ）への入力として渡す。
- **スタイルガチャ (`stylePreset`)**:
  - プリセット: `minimal` / `neon` / `retro` / `editorial` / `bento`
  - ユーザーがガチャボタンでプリセットを選んで「別スタイル生成」を押すと、`review` 回答メタデータに `action: "regenerate_style", stylePreset` を載せてワーカーへ再生成を依頼する。
- **Generic Skill 準拠**: `skills/*.md` への追記は既存の `skillsGeneric.test.js` と `languageRule.test.js` を満たすため、100% 汎用英語 ASCII（特定リポジトリ名・非ASCII文字を含めない）で記述する。

### 2.3 `/api/live` テレメトリ拡張と `/api/review/:id/mock` 安全配信

- **`/api/live` (`apps/bridge/src/live.js`)**:
  - `turnsFrom(target, at)` を拡張し、`state.db` の `messages` テーブルから直近1件だけでなく `recentTools`（最大6件: `{ toolName, at, status }`）を抽出する。
  - 各アクティブジョブに軽量サマリー `telemetry: { recentTools, toolCount, phaseLabel }` を付与（既存フィールドの後方互換性を完全維持、`sync-owner` 契約順守）。
- **`GET /api/review/:id/mock` (`apps/bridge/src/routes/review.js`)**:
  - `review_requests` レコードに紐づくサニタイズ済み／許可済み `.hermes-pilot/sandbox/` 配下の HTML モック（およびパストラバーサル検証済みファイル）を配信する。
  - レスポンスヘッダに `REVIEW_MOCK_CSP` を付与し、`sandbox allow-scripts allow-forms`（**`allow-same-origin` は絶対に付与しない**）＋ `X-Content-Type-Options: nosniff` ＋ `Referrer-Policy: no-referrer` を強制する。
  - テスト（`routeContracts.test.js` 等）でパストラバーサル拒否（`400/403`）と CSP ヘッダ検証を必須とする。

### 2.4 フリック比較 UI・Live Sandbox・LiveRadarCard (`apps/web`)

- **0.1秒フリック比較 & 赤入れ同期 (`AutopilotDeck` / Review Card)**:
  - モック画像コンテナの左右タップゾーン（左45%: 前案 / 右45%: 次案）＋水平スワイプ＋長押し（一時的に別案を比較表示し、離すと戻る）で 0.1 秒切替。
  - 上部 `A / B / C` ピルと完全双方向同期し、赤入れアノテーション座標は `activeVariantId` ごとに分離保持する。
- **`▶ 触ってみる` (Live Sandbox Toggle)**:
  - 画像表示 ↔ `<iframe src="/api/review/${id}/mock?variant=${variantId}" sandbox="allow-scripts allow-forms" />` をワンタップ切替。
  - 操作後もワンタップで静止画＋赤入れモードへ復帰できる。
- **`LiveRadarCard.jsx`（Panoptes MIT Clean-Room 着想）**:
  - 純粋 React + SVG（直径約 `220px` のレーダー円＋走査スイープ＋同心円リング＋アクティブワーカー／直近ツールブリップ点＋フェーズ状態）をカード上部に配置し、下部に 3〜4 行のコンパクトライブフィードを表示する。
  - 状態購読は `subscribeSync('live')`, `subscribeSync('usage')`, `subscribeSync('reviewWaiting')` のみを使用（独自の `setInterval` による `/api/*` ポーリング追加禁止）。
  - 完了カードには初期モックと最終成果のビフォー・アフター切替（タイムラプス再生／比較トグル）を搭載する。
  - レイアウト高さ・バンドルサイズ・DOM ノード数は既存の `baseline-ratchet` 基準内に収める。

---

## 3. 実装バッチ計画（すべて `[Mode: Zero-Stop]`）

### Batch AP2-1: HARNESS-RENDER — 並列一括モックレンダラー＆Pre-Flight Visual Gate

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **Objective**: `.hermes-pilot/sandbox/` 上の複数HTMLモックを 1回の Chrome CDP 起動で並列描画し、`390x844` スクショ（およびパーツスニペット）と Pre-Flight DOM 検査結果を一括返却する CLI を構築する。
- **Files**:
  - `.gitignore`（`.hermes-pilot/` を追加）
  - `scripts/render-mocks.mjs`（新規: `audit-responsive.mjs` 流儀の zero-npm-dep Chrome CDP + Node 22 WebSocket 並列レンダラー＆Pre-Flight 検査）
  - `scripts/tests/renderMocks.test.mjs`（新規: マニフェスト解析・Pre-Flight pass/fail 判定ロジック・クリップ/パス解決の単体テスト）
- **Acceptance Criteria**:
  1. `scripts/render-mocks.mjs --help` が終了コード 0 で仕様を表示すること。
  2. `scrollWidth > 390` や壊れた `<img>` を含むHTMLを渡した際（モックまたは実ブラウザテストで）`status: "fail"` と具体的 `failures` 理由を返すこと。
  3. ユニットテストおよび `node scripts/check-coherence.mjs --strict` が pass すること。

### Batch AP2-2: AUTOPILOT-PROTOCOL — Auto-Resolve・Promote 契約＆スタイルガチャ定義

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:planner`
- **Objective**: オートパイロット専用の「Safe Auto-Resolve」「ミニプレビュー生成指示」「Sandbox → Cockpit Promote」「スタイルガチャ (`stylePreset`)」契約をプロトコル文書と Generic Skills へ組み込む。
- **Files**:
  - `skills/autopilot-fastlane/SKILL.md`（新規または既存スキル更新: 100% 汎用英語 ASCII で Fast-Lane 規則・`render-mocks` 呼出手順・Auto-Resolve 基準・Promote 出力形式を定義）
  - `apps/bridge/src/review/autopilot-contract.js`（新規: `STYLE_PRESETS` 定義、Promote ペイロード正規化・バリデーションヘルパー）
  - `apps/bridge/test/autopilotContract.test.js`（新規: スタイルプリセット検証・Promote スキーマ検証・Auto-Resolve 分類境界テスト）
- **Acceptance Criteria**:
  1. `skillsGeneric.test.js` および `languageRule.test.js` が全件 pass すること（非ASCII・特定リポジトリ固有表現ゼロ）。
  2. `autopilotContract.test.js` が pass すること。
  3. `node scripts/check-coherence.mjs --strict` が pass すること。

### Batch AP2-3: LIVE-TELEMETRY-MOCK-API — `/api/live` ツール履歴拡張＆`/api/review/:id/mock` 安全配信

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **Objective**: `LiveRadarCard` 向けの直近ツール履歴（最大6件）を `/api/live` へ追加し、`▶ 触ってみる` インタラクティブモックを厳格 CSP 付きで安全配信する `/api/review/:id/mock` エンドポイントを実装する。
- **Files**:
  - `apps/bridge/src/live.js`（`turnsFrom` / `baseSnapshot` に `recentTools`・`telemetry` を追加、後方互換維持）
  - `apps/bridge/src/review/sheet-html.js`（`REVIEW_MOCK_CSP` 定数追加: `sandbox allow-scripts allow-forms`、`allow-same-origin` 不使用）
  - `apps/bridge/src/routes/review.js`（`GET /api/review/:id/mock` 追加、`.hermes-pilot/sandbox/` 配下の安全パス解決＆パストラバーサル遮断）
  - `apps/bridge/test/liveTelemetry.test.js`（新規）
  - `apps/bridge/test/reviewMockRoute.test.js`（新規: CSPヘッダ・パストラバーサル403・正常HTML配信テスト）
- **Acceptance Criteria**:
  1. `GET /api/review/:id/mock` レスポンスの CSP に `sandbox allow-scripts allow-forms` が含まれ、`allow-same-origin` が含まれないこと。
  2. `../` 等によるパストラバーサルが 400/403 で拒否されること。
  3. `apps/bridge` 全テスト（`routeContracts.test.js` 含む）と `check-coherence.mjs --strict` が pass すること。

### Batch AP2-4: STORY-SWIPE-SANDBOX — 0.1秒フリック比較・`▶ 触ってみる`・スタイルガチャ UI

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **Objective**: Autopilot カードUIに Instagram ストーリー風 0.1秒フリック比較、`▶ 触ってみる` サンドボックス `iframe` トグル、およびスタイル・ガチャ操作（再生成リクエスト送信）を実装する。
- **Files**:
  - `apps/web/src/components/autopilot/MockCompareStage.jsx`（新規: 左右45%タップ／長押しPeek／ピル同期＋`▶ 触ってみる` iframe トグル）
  - `apps/web/src/components/autopilot/StyleGachaBar.jsx`（新規: 5種プリセット選択＋ガチャ上限カウンタ付き再生成ボタン）
  - `apps/web/src/components/AutopilotDeck.jsx`（または現行 Autopilot カード親コンポーネントへの統合、`ActiveVariantId` ごとの赤入れ保持）
  - `apps/web/src/i18n/*.json`（JA/EN UIラベル追加、`i18n` 一貫性維持）
  - `apps/web/test/`（フリック比較状態遷移・サンドボックス `sandbox` 属性検証テスト）
- **Acceptance Criteria**:
  1. 画像領域左右タップおよび長押しで即座に表示案が切り替わり、赤入れ座標が案ごとに分離維持されること。
  2. `▶ 触ってみる` 有効時の `<iframe>` 属性が `sandbox="allow-scripts allow-forms"` であり `allow-same-origin` を持たないこと。
  3. `apps/web` テスト・i18n チェック・ビルドが通り、既存 Cockpit UI に回帰がないこと。

### Batch AP2-5: LIVE-RADAR-BI — Panoptes 着想・動的レーダーBI (`LiveRadarCard`) ＆タイムラプス

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **Objective**: `huwhitememes/panoptes`（MIT）の動的レーダー概念を純粋 React + SVG で実装した `LiveRadarCard` を待機中カードに統合し、完了カードにはビフォー・アフター タイムラプス切替を追加する。
- **Files**:
  - `apps/web/src/components/autopilot/LiveRadarCard.jsx`（新規: `~220px` SVG レーダー＋ブリップ＋3〜4行ライブフィード、`subscribeSync('live' | 'usage' | 'reviewWaiting')` 購読のみ）
  - `apps/web/src/components/autopilot/BeforeAfterTimelapse.jsx`（新規: 初期スクショ ↔ 決定モックのクロスフェード／比較トグル）
  - `apps/web/src/components/AutopilotDeck.jsx`（待機ビューへ `LiveRadarCard`、完了ビューへ `BeforeAfterTimelapse` を組込）
  - `apps/web/src/i18n/*.json`（必要キー追加）
  - `apps/web/test/LiveRadarCard.test.jsx`（新規: ブリップ描画・ライブフィード更新・新規 polling タイマー不使用テスト）
- **Acceptance Criteria**:
  1. `LiveRadarCard` が新規 `setInterval` / 直接 `fetch('/api/live')` を行わず `subscribeSync` 経由で更新されること（`sync-owner` 準拠）。
  2. 外部チャートライブラリを一切導入せず `npm run build` および `baseline-ratchet`（バンドル・UI指標）を悪化させないこと。
  3. 単体テストおよび `check-coherence.mjs --strict` が pass すること。

### Batch AP2-6: DEMO-VERIFY — Demo レーダーシーケンス・ドキュメント更新・総合検証

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:visual-reviewer`
- **Objective**: Demo モードへ Autopilot V2（フリック比較＋レーダー活動＋タイムラプス）シーケンスを追加し、運用ドキュメント更新と `390x844` 実画面・全テストの総合検証を完了する。
- **Files**:
  - `apps/web/src/demo/`（Demo シーケンスに `recentTools` レーダー遷移・複数案フリックモック・タイムラプスデータを追加）
  - `docs/`（ユーザーガイド／機能説明の必要箇所を更新、Wikiリンク整合維持）
- **Acceptance Criteria**:
  1. Demo モード（`390x844`）で `LiveRadarCard`・0.1秒フリック・`▶ 触ってみる` トグル・タイムラプスが視覚破綻（横溢れ・文字切れ）なく描画されること。
  2. 全テストスイート（`apps/bridge`・`apps/web`・`scripts`）および `node scripts/check-coherence.mjs --strict` が全件 pass すること。

---

## 4. Round 2 自己検証チェックリスト＆完了ゲート

全バッチ完了時点で以下を機械確認する。

- [ ] **Sync Ownership (`sync-owner`)**: `LiveRadarCard` および `AutopilotDeck` に独自の `setInterval` / 重複 `/api/*` 取得ループが存在しない。
- [ ] **Write Ownership (`write-owner`)**: 状態更新が既存 Store / Bridge API 契約を経由している。
- [ ] **Sandbox Security (`REVIEW_MOCK_CSP`)**: `GET /api/review/:id/mock` と `<iframe sandbox="allow-scripts allow-forms">` に `allow-same-origin` が付与されていない。
- [ ] **Generic Skills (`skillsGeneric.test.js` & `languageRule.test.js`)**: `skills/*.md` への追記が汎用英語 ASCII のみで構成されている。
- [ ] **Coherence & Ratchet**: `node scripts/check-coherence.mjs --strict` が `0 hard fail(s)` であり、`baseline-ratchet` および `routeContracts.test.js` が通過している。
