# SPEC: v0.2.4 Wiki スクリーンショット体系収集＆ドッグフーディング (`SPEC-WIKI-SHOTS`)

- **Status**: archived
- **アーカイブ日**: 2026-11-23（全48カット収集完了・`SPEC-WIKI-JA` へ引き継ぎ）

Status: decided (2026-11-23, `docs/WIKI-SHOTLIST.md` & `scripts/capture-wiki.mjs`)
Based on: `docs/WIKI-SHOTLIST.md`, `docs/DOGFOOD-0.2.4.md`

## 1. Concept

GitHub Wiki（日本語版先行・のちの英語版完全パリティ対応）に掲載する Manual 編（`MN01`〜`MN15`）および Showcase 編（`SC01`〜`SC09`）の全 24 シーン × 2 サイズ（スマホ縦 `390×844` / 横置きタブレット 2 ペイン `1180×820`）= **計 48 枚の Retina PNG スクリーンショット** を、`scripts/capture-wiki.mjs` を用いて体系的に収集・検収する。
この収集プロセス自体を Hermes Pilot の Spec Launchpad から起票・自走させることで、`v0.2.4` の実運用ドッグフーディングを完遂する。

## 2. Agreed decisions (interview outcome)

| # | Topic | Decision | Rationale |
|---|---|---|---|
| **D1** | 言語の進行順序 | 日本語環境（`--lang ja`、`docs/wiki/assets/ja/`）の全 48 カット収集を先行完遂する | UI 微調整時の手戻りを防ぎ、完了後に同一ファイル名規約で `assets/en/` へ展開するため |
| **D2** | 解像度と保存先 | `390×844`（`_390.png`）と `1180×820`（`_1180.png`）の 2 サイズ固定、`deviceScaleFactor: 2` | スマホ片手 UI とタブレット Master-Detail 2 ペインの両方の強みを Wiki で見せるため |
| **D3** | 撮影ハーネス | `scripts/capture-wiki.mjs`（CDP 直結、`--preset manual` / `--id` / `--eval` / `--unauth` / `--assert-complete`）を正本とする | 外部 npm 依存を追加せず、モーダル展開やテーマ切替、未認証 `/auth` 画面まで 1 ツールで再現可能にするため |
| **D4** | ショーケース題材 | `FocusFlow`（ミニマル・ポモドーロ＆タスクタイマー）の日英対訳シード（`SHOWCASE_SEEDS.ja`）を使用 | `SC01`（Spec Seed）〜 `SC09`（Coherence & Refactor）の一気通貫ストーリーが視覚的に最も分かりやすいため |

## 3. Detailed technical spec

### 3.1 対象アセットとヘルパー契約

Targets: `scripts/capture-wiki.mjs`, `docs/WIKI-SHOTLIST.md`, `docs/wiki/assets/ja/*.png`

1. **Manual 基本＆環境カット（Batch `WIKI-1`）**:
   - `MN01`（`/auth` 未認証ペアリング画面: `--id MN01 --unauth`）
   - `MN02`, `MN03`, `MN05`, `MN07`, `MN10`, `MN12`（基本 6 タブ: `--preset manual --lang ja`）
   - `MN14`（Settings の PWA 診断実行状態: `--id MN14 --eval` で診断ボタンをクリックし全項目 `✓` を表示）
   - `MN15`（標準 Hermes Dashboard `:9119` の `Hermes Pilot` タブ、またはローカル稼働中のダッシュボード画面）
2. **Manual 操作・モーダル・テーマ比較カット（Batch `WIKI-2`）**:
   - `MN04`（Tasks 詳細シート＋イベント履歴／Git Diff）
   - `MN06`（Review の Annotation エディタ＆ツールバー展開）
   - `MN08`（Chat メッセージバブルのコンテキストメニュー展開）
   - `MN09`（Chat セッションドロワー展開、`Reply` / `RO` バッジ表示）
   - `MN11`（Memos カードからの Brainstorm / Spec Seed ハンドオフ操作）
   - `MN13`（`Light` × `Serotonin` テーマ切替表示: `--id MN13 --theme light --vibe serotonin`）
3. **Showcase 一気通貫ストーリーカット（Batch `WIKI-3`）**:
   - `SC01`（`📝 Spec Seed` シートを開き、`SHOWCASE_SEEDS.ja.seed` のポモドーロタイマー仕様を入力した状態）
   - `SC02`（Round 1 `Quick Review` 3 問シートと `⚡ Accept All Recommended` ボタン表示）
   - `SC03`（`🚀 Spec Launchpad` の Batch アコーディオンと Role / Mode プレビュー展開）
   - `SC04`（`ArchitectJobBar` / `LiveSheet` / `WorkerFeed` の稼働モニタリング表示）
   - `SC05`（`Visual-Gate` スクショへの矩形・矢印・赤入れ Annotation 描画状態）
   - `SC06`（`Before ↔ After` 比較トグル表示と `✅ Looks Good` ボタン）
   - `SC07`（`🏆 Mission Receipt` モーダルの `1200×630` レシート PNG ＆ 280 字以内シェア文表示）
   - `SC08`（`Memos` のアイデアから `🧠 Brainstorm` シートへ引き継いだ状態）
   - `SC09`（`🛠 Refactor` シートのライブ Coherence 診断帯と推奨スイープ選択状態）
4. **全 48 カット完全性検証＆チェックリスト更新（Batch `WIKI-4`）**:
   - `node scripts/capture-wiki.mjs --assert-complete --lang ja` による全 48 ファイルの PNG シグネチャ・サイズ検証と `docs/WIKI-SHOTLIST.md` のチェックボックス更新。

## 4. Kanban task breakdown (Batch WIKI-1 .. WIKI-4)

### Batch WIKI-1: Manual 基本6タブ＆認証・診断スクショ収集（MN01〜03, 05, 07, 10, 12, 14, 15）

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **Objective**: `scripts/capture-wiki.mjs` を実行・必要に応じ `--eval` セレクタを補完し、Manual 編の基本 6 タブ（`MN02`, `MN03`, `MN05`, `MN07`, `MN10`, `MN12`）および `/auth` ログイン画面（`MN01`）、PWA 診断オールグリーン画面（`MN14`）、標準ダッシュボード連携画面（`MN15`）の計 9 シーン × 2 サイズ（18 枚）を `docs/wiki/assets/ja/` に撮影・保存する。
- **Files**:
  - Changed: `scripts/capture-wiki.mjs`
  - New: `docs/wiki/assets/ja/MN01_login-pairing_390.png`
  - New: `docs/wiki/assets/ja/MN01_login-pairing_1180.png`
  - New: `docs/wiki/assets/ja/MN02_settings-overview_390.png`
  - New: `docs/wiki/assets/ja/MN02_settings-overview_1180.png`
  - New: `docs/wiki/assets/ja/MN03_tasks-overview_390.png`
  - New: `docs/wiki/assets/ja/MN03_tasks-overview_1180.png`
  - New: `docs/wiki/assets/ja/MN05_review-inbox_390.png`
  - New: `docs/wiki/assets/ja/MN05_review-inbox_1180.png`
  - New: `docs/wiki/assets/ja/MN07_chat-overview_390.png`
  - New: `docs/wiki/assets/ja/MN07_chat-overview_1180.png`
  - New: `docs/wiki/assets/ja/MN10_memos-grid_390.png`
  - New: `docs/wiki/assets/ja/MN10_memos-grid_1180.png`
  - New: `docs/wiki/assets/ja/MN12_terminal-pty_390.png`
  - New: `docs/wiki/assets/ja/MN12_terminal-pty_1180.png`
  - New: `docs/wiki/assets/ja/MN14_pwa-diagnostics_390.png`
  - New: `docs/wiki/assets/ja/MN14_pwa-diagnostics_1180.png`
  - New: `docs/wiki/assets/ja/MN15_hermes-dashboard-tab_390.png`
  - New: `docs/wiki/assets/ja/MN15_hermes-dashboard-tab_1180.png`
- **Verify**:
  - `node scripts/capture-wiki.mjs --status --lang ja` で上記 9 ID（18 カット）がすべて `[x]` になること。
  - `npm run check:coherence` が 0 hard fail で通ること。

---

### Batch WIKI-2: Manual モーダル・ドロワー・テーマ比較スクショ収集（MN04, 06, 08, 09, 11, 13）

- **Execution Mode**: `[Mode: Visual-Gate]`
- **Recommended Role**: `role:visual-reviewer`
- **Objective**: 各タブのインタラクティブ状態（`MN04` タスク詳細＆Diff、`MN06` Annotation ツールバー、`MN08` チャットバブルメニュー、`MN09` チャットセッションドロワー、`MN11` メモハンドオフ、`MN13` Light × Serotonin テーマ比較）の計 6 シーン × 2 サイズ（12 枚）を `scripts/capture-wiki.mjs` で撮影し、代表カットを Visual-Gate レビューとして提示して目視承認を得る。
- **Files**:
  - Changed: `scripts/capture-wiki.mjs`
  - New: `docs/wiki/assets/ja/MN04_task-detail-diff_390.png`
  - New: `docs/wiki/assets/ja/MN04_task-detail-diff_1180.png`
  - New: `docs/wiki/assets/ja/MN06_annotation-toolbar_390.png`
  - New: `docs/wiki/assets/ja/MN06_annotation-toolbar_1180.png`
  - New: `docs/wiki/assets/ja/MN08_chat-bubble-menu_390.png`
  - New: `docs/wiki/assets/ja/MN08_chat-bubble-menu_1180.png`
  - New: `docs/wiki/assets/ja/MN09_chat-session-drawer_390.png`
  - New: `docs/wiki/assets/ja/MN09_chat-session-drawer_1180.png`
  - New: `docs/wiki/assets/ja/MN11_memo-handoff_390.png`
  - New: `docs/wiki/assets/ja/MN11_memo-handoff_1180.png`
  - New: `docs/wiki/assets/ja/MN13_theme-vibe-compare_390.png`
  - New: `docs/wiki/assets/ja/MN13_theme-vibe-compare_1180.png`
- **Verify**:
  - `node scripts/capture-wiki.mjs --status --lang ja` で `MN01`〜`MN15` の全 30 カットがすべて `[x]` になること。
  - `MN13`（Light × Serotonin）で黒枠・色漏れ（PITFALLS P7）が発生していないこと。

---

### Batch WIKI-3: Showcase 一気通貫ストーリー（FocusFlow）スクショ収集（SC01〜SC09）

- **Execution Mode**: `[Mode: Visual-Gate]`
- **Recommended Role**: `role:visual-reviewer`
- **Objective**: `SHOWCASE_SEEDS.ja`（ポモドーロタイマー FocusFlow）のシナリオに沿い、起点 `SC01`（Spec Seed 入力）→ `SC02`（Quick Review 3 問面接）→ `SC03`（Spec Launchpad アコーディオン）→ `SC04`（Live Worker Feed）→ `SC05`（Annotation 赤入れ描画）→ `SC06`（Before/After 比較）→ `SC07`（Mission Receipt 完了レシート）→ `SC08`（Memos から Brainstorm 起動）→ `SC09`（Coherence ライブ診断＆Refactor シート）の全 9 シーン × 2 サイズ（18 枚）を撮影し、Visual-Gate レビューで目視検収を受ける。
- **Files**:
  - Changed: `scripts/capture-wiki.mjs`
  - New: `docs/wiki/assets/ja/SC01_seed-sheet_390.png`
  - New: `docs/wiki/assets/ja/SC01_seed-sheet_1180.png`
  - New: `docs/wiki/assets/ja/SC02_quick-review-interview_390.png`
  - New: `docs/wiki/assets/ja/SC02_quick-review-interview_1180.png`
  - New: `docs/wiki/assets/ja/SC03_spec-launchpad_390.png`
  - New: `docs/wiki/assets/ja/SC03_spec-launchpad_1180.png`
  - New: `docs/wiki/assets/ja/SC04_live-worker-feed_390.png`
  - New: `docs/wiki/assets/ja/SC04_live-worker-feed_1180.png`
  - New: `docs/wiki/assets/ja/SC05_annotation-redpen_390.png`
  - New: `docs/wiki/assets/ja/SC05_annotation-redpen_1180.png`
  - New: `docs/wiki/assets/ja/SC06_before-after-compare_390.png`
  - New: `docs/wiki/assets/ja/SC06_before-after-compare_1180.png`
  - New: `docs/wiki/assets/ja/SC07_mission-receipt_390.png`
  - New: `docs/wiki/assets/ja/SC07_mission-receipt_1180.png`
  - New: `docs/wiki/assets/ja/SC08_memos-to-brainstorm_390.png`
  - New: `docs/wiki/assets/ja/SC08_memos-to-brainstorm_1180.png`
  - New: `docs/wiki/assets/ja/SC09_coherence-refactor-sheet_390.png`
  - New: `docs/wiki/assets/ja/SC09_coherence-refactor-sheet_1180.png`
- **Verify**:
  - `node scripts/capture-wiki.mjs --status --lang ja` で `SC01`〜`SC09` の全 18 カットが `[x]` になること。
  - 各スクリーンショットに対象のシート・モーダルが正しく開かれた状態で写っていること。

---

### Batch WIKI-4: 全48カット揃い踏み監査＆チェックリスト完了更新

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **Objective**: `node scripts/capture-wiki.mjs --assert-complete --lang ja` を実行して日本語版全 48 枚の PNG 整合性を機械検証し、`docs/WIKI-SHOTLIST.md` の `JA 390` / `JA 1180` チェックボックスを `[x]` に更新した上で `npm run verify` を通す。
- **Files**:
  - Changed: `docs/WIKI-SHOTLIST.md`
  - Changed: `scripts/capture-wiki.mjs`
- **Verify**:
  - `node scripts/capture-wiki.mjs --assert-complete --lang ja` が exit 0（`all 48 shots for lang=ja are valid PNGs`）を返すこと。
  - `npm run check:coherence` および `npm test` が 0 fail で通ること。
