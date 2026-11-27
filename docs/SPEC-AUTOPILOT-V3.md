# SPEC-AUTOPILOT-V3 — Compact Interactive Radar, Run Telemetry, Gesture Isolation & Wave Parallelism

- **Status**: archived  
> **Batch prefix:** `AP3`  
> **Extends:** `docs/SPEC-AUTOPILOT-V2.md` (Archived `AP2-1..AP2-6`)  
> **Target:** Hermes Mobile PWA (`apps/web`, `apps/bridge`, `docs`)

---

## 1. 実機テストからの課題一覧と根本原因

1. **レーダーカード下部が 390×844 画面で見切れる**:
   - SVG `220×220px`＋`.ap-studio-card` 余白＋`.ap-ticker-box` と4行ログの重複で縦が `~780px` に膨らみ、下部のアクションボタンがスクロール外にはみ出す。
2. **レーダー上のドットの意味が不明＋タッチ無反応**:
   - `core`/`verify`/`explore` リングに軸表記がなく、ドット詳細がホバー `<title>` のみでモバイルでタップできない。
3. **「24h 消費: 0」のまま動かない**:
   - `usage.js` は `{ input, output, cacheRead }` を返すのに、`liveRadar.js` が `totalTokens ?? tokens` を読んで常に `0` になっていた。さらにリアルタイム感のため「実行単位トークン（`runTokens`）」表示が望ましい。
4. **段階ゲージが増減・逆行する**:
   - ツール名（`test` 後に再修正で `edit_file` 等）で段階を戻していたうえ、タスク起票直後に `total=0` 計算から `done/total=0` 計算へ切り替わってゲージが `56% -> 12%` へ急落していた。
5. **Visual インタビュー時のスワイプと説明文スクロール競合**:
   - `.ap-card` 全体が `touch-action: none` で上下スワイプ（赤入れ／お任せ）まで拾うため、下部テキストを読む縦スクロールと衝突する。
6. **Autopilot 専用の安全な並列ワーカー稼働**:
   - Cockpit 側（既定 `serial: true`）に一切影響を与えず、Autopilot 時のみ非重複ファイルの独立バッチを最大 3 並列で起動し、共有ファイル／ホットスポットを含むバッチのみ自動で直列フォールバックする。

---

## 2. 技術設計

### 2.1 Autopilot 限定 Wave 並列起票（最大 3 並列＋共有ファイル自動直列フォールバック）と実行トークン計測

- **Wave プランナー (`apps/bridge/src/specs/wave-plan.js`)**:
  - `parallelMode !== 'wave'`（Cockpit 既定）時は全バッチを従来の 1 本鎖直列として返し、Cockpit 挙動を 100% 不変に保つ。
  - Autopilot (`job.autopilot === true`) の `autoStart` 時のみ `parallelMode: 'wave', maxParallel: 3` を指定する。
  - 各バッチの `Files:` と任意の `- **Depends On**: none | ID1, ID2` を解析し、以下すべてを満たす連続バッチのみ同一 Wave（最大 `3` 本）へ束ねて同時着手を許可する：
    1. 対象ファイルが 1 件以上宣言されており、`SHARED_HOTSPOT_FILES`（`package.json`, `i18n/*.json`, `coherence-baseline.json`, `routes.js`, `server.js`, `App.jsx`, `styles.css` 等）を含まない。
    2. 同一 Wave 内の他バッチと対象ファイルが重複しない。
    3. `Depends On` に同一 Wave 内のバッチを含まない。
  - 上記に反する場合は **自動的に直列バリア（Wave サイズ 1）へ安全フォールバック** する。
- **実行単位トークン (`/api/live` 拡張 / `apps/bridge/src/live.js`)**:
  - `session_turn_leases LEFT JOIN sessions` から `input_tokens`, `output_tokens`, `cache_read_tokens`, `estimated_cost_usd` を後方互換付きで取得（古いテストDBに列が無い場合は自動フォールバック）。
  - `telemetry` に `{ runTokens, runCacheRead, runCostUsd, cacheHitPct, activeWorkers }` を追加する。

### 2.2 単調増加ゲージとトークン集計バグ修正 (`liveRadar.js` / `studio.js`)

- `liveRadar.js`:
  - `runTokens = live.telemetry.runTokens`（未指定時は `turns[].tokens.total` 合算）を最優先し、`tokenMode: 'run' | '24h'` を返す。
  - `usage.totals` のフォールバック集計を `(input + output)` 対応へ修正し、常に 0 になる不具合を解消する。
- `studio.js`:
  - `computeStudioProgress({ phase, doneCount, runningCount, totalCount, activityKey })` を導入：
    - 設計 (`total === 0`): `8%〜20%` (`stepIndex = 0`)
    - 制作・検証 (`total > 0, done < total`): `20 + Math.round(((done + Math.min(running, total - done) * 0.35) / total) * 65)` (`20%〜85%`)、`stepIndex = 1 | 2`
    - 仕上げ (`done >= total`): `92%` (`stepIndex = 3`)
  - さらに `LiveStudioCard` 内で `runKey` ごとの高水位（monotonic max）を保持し、作業ループ中でもゲージ・段階ドットが絶対に後退しないようにする。

### 2.3 1画面完結型・インタラクティブコンパクトレーダー (`LiveRadarCard.jsx`)

- SVG 描画高を `220px -> 160px`（`<=400px` 時は `148px`）へ縮小し、余白圧縮＋重複ティッカー整理により `390×844` で下部ボタンまで 1 画面に収める。
- 上軸に同心円ラベル（`実装 / 検証 / 探索` または `BUILD / CHECK / SCAN`）を表示する。
- 各ドットに透明タップ判定（`r="18"`）を持たせ、タップで選択リング＋直下のインスペクタカード（`.ap-radar-inspector`）へツール名・紐づくタスク名・役割・経過秒を表示する。
- 指標バーに `🪙 今回: {runTokenLabel}`（および並列数 `{n}並列稼働` バッジ）を表示する。

### 2.4 Visual インタビューの横スワイプ専用化＆説明文スクロール分離

- `deck-core.js` / `AutopilotDeck.jsx`:
  - インタビューカードのジェスチャーを **`horizontalOnly: true`（右＝決定 / 左＝次案）専用** とし、縦スワイプ（お任せ／赤入れ）をカード本体から廃止して下部ボタン専用に統一する。
  - `handlePointerDown` は `.ap-card-copy` 内からの操作を除外し、横ドラッグ時は `dy = 0` で水平移動させる。
- `DeckCardStage.jsx` / `autopilot-deck.css`:
  - `.ap-card-copy` を独立した縦スクロール領域（`max-height: 150px; overflow-y: auto; touch-action: pan-y`）にし、常に視認できるカスタムスクロールトラック＋ノブ（`.ap-copy-scrollbar` / `.ap-copy-thumb`）と `全文を読む / 閉じる` トグルを備える。

---

## 3. 実装バッチ計画（すべて `[Mode: Zero-Stop]`）

### Batch AP3-1: LIVE-RUN-TOKENS-WAVE-PARALLEL — 実行単位トークン計測＆Autopilot限定3並列Wave起票

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **Objective**: `/api/live` に実行中セッションの `runTokens` / `cacheHitPct` を追加し、Autopilot 時のみ共有ファイル自動直列フォールバック付きの最大 3 並列 Wave 起票を `specs.js` / `architect.js` へ組み込む。
- **Files**:
  - `apps/bridge/src/live.js`
  - `apps/bridge/src/specs/wave-plan.js`
  - `apps/bridge/src/specs.js`
  - `apps/bridge/src/architect.js`
  - `apps/bridge/src/architect/autopilot.js`
  - `apps/bridge/test/autopilotWavePlan.test.js`
  - `apps/bridge/test/liveTelemetry.test.js`
- **Verify**:
  - `specs.js`（<=613行）および `architect.js`（<=702行）のラチェット上限を守り、Cockpit 既定 `serial` が不変であること。
  - 並列テスト（3並列・重複ファイル自動直列・共有ホットスポット自動直列）と `check-coherence.mjs --strict` が pass すること。

### Batch AP3-2: PROGRESS-MONOTONIC-TOKEN-FIX — 単調増加ゲージ＆トークン集計バグ修正

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **Objective**: `liveRadar.js` の `usage.totals` 読取バグ修正＋`runTokens` 優先化、および `studio.js` のフェーズ連動・単調増加プログレス計算を実装する。
- **Files**:
  - `apps/web/src/lib/liveRadar.js`
  - `apps/web/src/lib/autopilot/studio.js`
  - `apps/web/src/demo/fetch.js`
  - `apps/web/test/LiveRadarCard.test.js`
- **Verify**:
  - `autopilotDeck.js` の 27 export 契約を維持したまま、設計→制作→検証→仕上げでゲージが一切逆行しないこと。
  - `usage.totals: { input, output }` および `runTokens` が正しくコンパクト表記されること。

### Batch AP3-3: COMPACT-INTERACTIVE-RADAR — 1画面収容コンパクト化＆ドットタップ詳細インスペクタ

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **Objective**: `LiveRadarCard` をコンパクト SVG（160px/148px）＋同心円軸ラベル＋ドットタップ選択インスペクタ＋今回消費トークン表示へ刷新し、`LiveStudioCard` の高水位ゲージ化と縦余白最適化を行う。
- **Files**:
  - `apps/web/src/features/autopilot/LiveRadarCard.jsx`
  - `apps/web/src/features/autopilot/AutopilotCards.jsx`
  - `apps/web/src/styles/autopilot-radar.css`
  - `apps/web/src/styles/autopilot-deck.css`
  - `apps/web/src/i18n/en.json`
  - `apps/web/src/i18n/ja.json`
- **Verify**:
  - `LiveRadarCard` が新規 `setInterval` / 直接 `fetch` を持たないこと（`sync-owner`）。
  - `npm test && npm run build && node scripts/check-coherence.mjs --strict` が pass すること。

### Batch AP3-4: INTERVIEW-SCROLL-SWIPE-VERIFY — 縦スワイプ廃止＋独立スクロールノブ＆実機検証・配備

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:visual-reviewer`
- **Objective**: インタビューカードの縦スワイプを廃止して下部ボタン専用化し、`.ap-card-copy` に独立縦スクロール＋カスタムスクロールノブ＆展開トグルを実装し、`390×844` 実画面検証・デプロイ・サービス再起動を完了する。
- **Files**:
  - `apps/web/src/lib/autopilot/deck-core.js`
  - `apps/web/src/features/autopilot/AutopilotDeck.jsx`
  - `apps/web/src/features/autopilot/DeckCardStage.jsx`
  - `apps/web/src/styles/autopilot-deck.css`
  - `apps/web/src/i18n/en.json`
  - `apps/web/src/i18n/ja.json`
  - `apps/web/test/autopilotV3Ux.test.js`
- **Verify**:
  - `npm test`・`npm run build`・`npm run build:demo`・`node scripts/check-coherence.mjs --strict` が全件合格すること。
  - headless Chrome `390×844` 実測でレーダー下端見切れゼロ、ドットタップ動作、今回消費トークン非ゼロ表示を確認し、`npm run deploy` ＆ サービス再起動まで完了すること。
