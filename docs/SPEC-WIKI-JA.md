# SPEC: v0.2.4 日本語版 マニュアル＆ショーケース Wiki 構築 (`SPEC-WIKI-JA`)

Status: decided (2026-11-23, `docs/WIKI-SHOTLIST.md` 全 48 カット収集完了後)
Based on: `docs/WIKI-SHOTLIST.md`, `docs/SPEC-WIKI-SHOTS.md`

## 1. Concept

`SPEC-WIKI-SHOTS` で収集・検証を完了した日本語版全 48 枚の Retina スクリーンショット（`docs/wiki/assets/ja/` 配下の `MN01`〜`MN15` および `SC01`〜`SC09` × スマホ縦 `390×844` / タブレット横 2 ペイン `1180×820`）を用い、GitHub Wiki およびリポジトリ内ドキュメントとしてそのまま公開・閲覧できる **日本語版 詳細マニュアル＆一気通貫ショーケース Wiki（`docs/wiki/ja/`）** を構築する。
あわせて、全 48 画像の参照漏れ・リンク切れ・日英パス置換互換性を機械検査する `scripts/check-wiki.mjs` を整備し、のちに英語環境で `assets/en/` を撮影した際に `assets/ja/` → `assets/en/` の一括置換だけで英語版 Wiki（`docs/wiki/en/`）を構築できる構造を確立する。

## 2. Agreed decisions (interview outcome)

| # | Topic | Decision | Rationale |
|---|---|---|---|
| **D1** | Wiki ページの配置場所 | `docs/wiki/ja/` 配下に GitHub Wiki 互換のファイル名（`Home.md`, `_Sidebar.md`, `Showcase-From-Idea-to-Product.md`, `Manual-*.md`）で作成する | Git リポジトリ内での PR レビュー・画像相対リンク解決と、`*.wiki.git` への将来ミラーリングの両方に対応するため |
| **D2** | スマホ（`390`）とタブレット（`1180`）の並置レイアウト | 各シーン（`MN01`〜`MN15`, `SC01`〜`SC09`）は Markdown テーブルで **左列: 📱 スマホ縦 (`390×844`) / 右列: 🖥️ タブレット横 2ペイン (`1180×820`)** を並べて比較表示する | 片手操作の軽快さと、タブレット 2 ペイン Master-Detail の情報密度の両方を一目で伝えるため |
| **D3** | 画像参照パス規約 | `docs/wiki/ja/*.md` から `../assets/ja/<ID>_<slug>_<390\|1180>.png` の相対パスで統一する | のちの英語版（`docs/wiki/en/*.md`）作成時に `../assets/ja/` → `../assets/en/` の単純文字列置換だけで全 48 画像リンクが切り替わるようにするため |
| **D4** | 機械検査ゲート | `scripts/check-wiki.mjs` を新設し、① 全 6 ページの必須見出し存在、② 全 48 画像ファイル（`MN01`〜`MN15`, `SC01`〜`SC09` × `390`/`1180`）が最低 1 回ずつ参照されていること、③ リンク先ファイルの存在（リンク切れ 0 件）を検証する | 画像の貼り忘れやタイポによるリンク切れをゼロにするため |

## 3. Detailed technical spec

### 3.1 ページ構成と割り当てスクリーンショット（全 48 枚）

Targets: `docs/wiki/ja/Home.md`, `docs/wiki/ja/_Sidebar.md`, `docs/wiki/ja/Showcase-From-Idea-to-Product.md`, `docs/wiki/ja/Manual-Installation-and-Setup.md`, `docs/wiki/ja/Manual-A2B-Tasks-and-Review.md`, `docs/wiki/ja/Manual-Chat-Memos-and-Terminal.md`

1. **`docs/wiki/ja/Home.md` ＆ `docs/wiki/ja/_Sidebar.md`**:
   - Hermes Pilot のコンセプト（スマホ/タブレットから自律エージェントを操縦する意思決定コックピット＆A2Bパイプライン）。
   - A2B パイプライン全体フロー図（Mermaid または ASCII 図解）と Interactive Demo（GitHub Pages）へのリンク。
   - **Showcase 編** と **Manual 編（3 部作）** へのナビゲーション目次、およびドッグフーディング用クイックチェックリスト概要。
   - 代表プレビューとして `MN03_tasks-overview_390.png` / `MN03_tasks-overview_1180.png` を掲載。
2. **`docs/wiki/ja/Showcase-From-Idea-to-Product.md`（ショーケース編：`SC01`〜`SC09` 全 18 枚）**:
   - 題材 `FocusFlow`（ミニマル・ポモドーロ＆タスクタイマー）を例に、実際にコピペして試せるプロンプト文言（`docs/WIKI-SHOTLIST.md` §2.1）と各画面の操作ポイント・裏側の仕組みを 9 ステップで詳説：
     - **Step 1: 起点 (`SC01_seed-sheet_390.png` / `_1180.png`)** — Tasks タブから 1 行の Spec Seed 入力と実行ポリシー（`Visual-Gate` vs `Zero-Stop`）の選択
     - **Step 2: 設計面接 (`SC02_quick-review-interview_390.png` / `_1180.png`)** — Architect が生成した Round 1 の 3 問シートと `⚡ Accept All Recommended` 1 タップ回答
     - **Step 3: 仕様確定と起票 (`SC03_spec-launchpad_390.png` / `_1180.png`)** — `docs/SPEC-*.md` の生成と Spec Launchpad アコーディオン（Batch ごとの `Execution Mode` と `Recommended Role`）からの 1 タップ冪等起票
     - **Step 4: 自走モニタリング (`SC04_live-worker-feed_390.png` / `_1180.png`)** — `ArchitectJobBar`・`LiveSheet`・`WorkerFeed` によるリアルタイム進捗確認
     - **Step 5: 赤入れ指示 (`SC05_annotation-redpen_390.png` / `_1180.png`)** — `Visual-Gate` で届いたスクショに対する矩形・矢印・コメントの Annotation 赤入れ送信
     - **Step 6: 修正検収 (`SC06_before-after-compare_390.png` / `_1180.png`)** — `Before ↔ After` 比較トグルでの修正確認と `✅ Looks Good` 1 タップ完了
     - **Step 7: プロトタイプ完成と戦果レシート (`SC07_mission-receipt_390.png` / `_1180.png`)** — 全 Batch 完了時の `1200×630` Mission Receipt PNG 出力と X 換算 280 文字以内のシェア文
     - **Step 8: 次期アイデアと機能追加 (`SC08_memos-to-brainstorm_390.png` / `_1180.png`)** — 日常の気づきを溜める `Memos` カードから `🧠 Brainstorm` シートへの 1 タップ引き継ぎと機能追加サイクル
     - **Step 9: 品質維持とリファクタリング (`SC09_coherence-refactor-sheet_390.png` / `_1180.png`)** — `🛠 Refactor` シートのライブ Coherence 診断帯（Hard fails / Soft signals / Hotspots）と推奨スイープ（`bug-hunt` 等）の起票
3. **`docs/wiki/ja/Manual-Installation-and-Setup.md`（導入・設定編：`MN01`, `MN02`, `MN14`, `MN15` 計 8 枚）**:
   - 公式カタログ / CLI からのインストール手順、Bridge サービス登録、QR / ワンタイムコードによるスマホ・タブレットのペアリング（`MN01_login-pairing_390.png` / `_1180.png`）。
   - Settings タブの全体構成と `Optimise this Hermes` 1 タップ環境最適化、4 つの抽象ロール（`role:planner` / `role:builder` / `role:visual-reviewer` / `role:decision-framer`）の仕組み（`MN02_settings-overview_390.png` / `_1180.png`）。
   - ホーム画面インストール（WebAPK）と PWA 診断ツールの見方・トラブルシューティング（`MN14_pwa-diagnostics_390.png` / `_1180.png`）。
   - 標準 Hermes Dashboard (`:9119`) の `Hermes Pilot` タブとの一元連携（`MN15_hermes-dashboard-tab_390.png` / `_1180.png`）。
4. **`docs/wiki/ja/Manual-A2B-Tasks-and-Review.md`（Tasks & Review 編：`MN03`〜`MN06` 計 8 枚）**:
   - Tasks タブのボード切替、ステータスフィルタ、整理モード（一括アーカイブ）、3 大アクションバー（`Spec Seed` / `Brainstorm` / `Refactor`）（`MN03_tasks-overview_390.png` / `_1180.png`）。
   - タスク詳細シートのイベント履歴、Git Diff 確認、コメント・Unblock・Abort・Emergency 全タスク緊急停止（`MN04_task-detail-diff_390.png` / `_1180.png`）。
   - Review インボックス（Waiting / Done 切替、相対時刻作業フィード、1-Tap Fast-Track 承認）（`MN05_review-inbox_390.png` / `_1180.png`）。
   - Annotation 赤入れエディタの描画ツール（矩形・矢印・フリーハンド・色切替・Undo・ツールバー折りたたみ）（`MN06_annotation-toolbar_390.png` / `_1180.png`）。
5. **`docs/wiki/ja/Manual-Chat-Memos-and-Terminal.md`（Chat・Memos・Terminal・外観編：`MN07`〜`MN13` 計 14 枚）**:
   - Chat タブのストリーミング応答、Thinking / Tool ログ展開、プロファイル選択、スニペットチップ帯（`MN07_chat-overview_390.png` / `_1180.png`）。
   - メッセージバブル操作メニュー（コピー・Memos 保存・要約・追加指示）（`MN08_chat-bubble-menu_390.png` / `_1180.png`）。
   - セッション一覧ドロワー（`Reply` / `RO` バッジ、稼働中インジケータ、横断検索）（`MN09_chat-session-drawer_390.png` / `_1180.png`）。
   - Memos タブのレスポンシブ表示（スマホ 1 列 / タブレット 2 列）、タグ検索、完了レポート Inbox（`MN10_memos-grid_390.png` / `_1180.png`）と Spec Seed / Brainstorm への 1 タップハンドオフ（`MN11_memo-handoff_390.png` / `_1180.png`）。
   - Terminal タブの実 PTY 接続、OS 連動コマンドスニペット、IME 中でも確実に動く Enter 送信（`MN12_terminal-pty_390.png` / `_1180.png`）。
   - Theme（`Dark` / `Light` / `System`）× Vibe（`⚡ Dopamine` / `🧘 Serotonin`）のカスタマイズと Haptics / Sound 独立維持（`MN13_theme-vibe-compare_390.png` / `_1180.png`）。

### 3.2 Wiki 整合性チェッカー `scripts/check-wiki.mjs`

Targets: `scripts/check-wiki.mjs`, `apps/bridge/test/wikiDocs.test.js`

1. **`node scripts/check-wiki.mjs [--lang ja]`**:
   - `docs/wiki/<lang>/` 配下の必須 6 ファイル（`Home.md`, `_Sidebar.md`, `Showcase-From-Idea-to-Product.md`, `Manual-Installation-and-Setup.md`, `Manual-A2B-Tasks-and-Review.md`, `Manual-Chat-Memos-and-Terminal.md`）が存在し空でないことを検証する。
   - 各 Markdown ファイル内の画像リンク `![...](...)` とページリンク `[...](...)` を抽出し、相対パス解決先が実在するファイル（および `isValidPng`）であることを検証する。
   - `WIKI_SHOTS`（`scripts/capture-wiki.mjs` の全 24 ID × `390` / `1180` = 48 枚）が `docs/wiki/<lang>/*.md` 全体で **48 枚すべて漏れなく参照されていること** を検証する。
   - 違反が 0 件なら `check-wiki: OK — 6 page(s), 48/48 shot(s) referenced, 0 broken link(s) (lang=ja)` を英語（ASCII）で出力して exit 0 を返す。

## 4. Kanban task breakdown (Batch WJA-1 .. WJA-4)

### Batch WJA-1: Wiki 整合性チェッカー（scripts/check-wiki.mjs）＋ Home / Sidebar / 導入・設定マニュアル構築

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **Objective**: `scripts/check-wiki.mjs`（リンク切れ・全 48 画像参照網羅チェッカー）を作成した上で、`docs/wiki/ja/Home.md`、`docs/wiki/ja/_Sidebar.md`、および導入・設定マニュアル `docs/wiki/ja/Manual-Installation-and-Setup.md`（`MN01`, `MN02`, `MN14`, `MN15` の `390` / `1180` 計 8 枚を並列テーブルで掲載）を作成する。
- **Files**:
  - New: `scripts/check-wiki.mjs`
  - New: `docs/wiki/ja/Home.md`
  - New: `docs/wiki/ja/_Sidebar.md`
  - New: `docs/wiki/ja/Manual-Installation-and-Setup.md`
- **Verify**:
  - `Home.md`、`_Sidebar.md`、`Manual-Installation-and-Setup.md` が作成され、`MN01`, `MN02`, `MN14`, `MN15`（および `Home.md` の `MN03`）の `390`/`1180` 画像パスがすべて実在ファイルに解決されること。
  - `npm run check:coherence` が 0 hard fail で通ること。

---

### Batch WJA-2: Showcase 編（Showcase-From-Idea-to-Product.md — SC01〜SC09 全18カット完全解説）構築

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **Objective**: `FocusFlow`（ミニマル・ポモドーロ＆タスクタイマー）を題材に、起点（`SC01` Spec Seed）→ 設計面接（`SC02` Quick Review）→ 起票（`SC03` Spec Launchpad）→ 自走監視（`SC04` Live Run）→ 赤入れ（`SC05` Annotation）→ 比較検収（`SC06` Before/After）→ 戦果レシート（`SC07` Mission Receipt）→ アイデア拡張（`SC08` Memos to Brainstorm）→ 品質維持（`SC09` Coherence & Refactor）の全 9 フェーズ・18 枚のスクリーンショット（`390` スマホ縦 ＆ `1180` タブレット横並列）と再現用プロンプトを網羅した `docs/wiki/ja/Showcase-From-Idea-to-Product.md` を作成する。
- **Files**:
  - New: `docs/wiki/ja/Showcase-From-Idea-to-Product.md`
- **Verify**:
  - `SC01`〜`SC09` の `390` / `1180` 計 18 枚の画像すべてが `docs/wiki/ja/Showcase-From-Idea-to-Product.md` 内で `../assets/ja/SC...` として参照され、リンク切れが 0 件であること。
  - 各ステップにユーザーがそのままドッグフーディングで追体験できる入力シード・確認チェックポイントが含まれていること。

---

### Batch WJA-3: Manual 編（Tasks & Review 編 ＋ Chat・Memos・Terminal・外観編）構築

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **Objective**: `docs/wiki/ja/Manual-A2B-Tasks-and-Review.md`（`MN03`〜`MN06` の 8 枚掲載：ボード操作・タスク詳細＆Diff・緊急停止・Review インボックス・Annotation ツールバー）および `docs/wiki/ja/Manual-Chat-Memos-and-Terminal.md`（`MN07`〜`MN13` の 14 枚掲載：Chat・バブルメニュー・セッションドロワー・Memos レスポンシブ＆ハンドオフ・Terminal 実 PTY・Theme×Vibe 比較）を作成する。
- **Files**:
  - New: `docs/wiki/ja/Manual-A2B-Tasks-and-Review.md`
  - New: `docs/wiki/ja/Manual-Chat-Memos-and-Terminal.md`
- **Verify**:
  - `node scripts/check-wiki.mjs --lang ja` が exit 0（全 6 ページ・全 48/48 カット参照・リンク切れ 0 件）を返すこと。

---

### Batch WJA-4: Wiki 単体テスト固定・README 導線追加・最終 verify

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **Objective**: `apps/bridge/test/wikiDocs.test.js` を追加して `scripts/check-wiki.mjs` の全 48 カット参照・リンク整合性を自動テストで固定し、`README.ja.md`（および `README.md`）に `docs/wiki/ja/Home.md`（マニュアル＆ショーケース Wiki）への案内リンクを追加した上で `npm run verify` を通す。
- **Files**:
  - New: `apps/bridge/test/wikiDocs.test.js`
  - Changed: `README.ja.md`
  - Changed: `README.md`
- **Verify**:
  - `node --test apps/bridge/test/wikiDocs.test.js` および `node scripts/check-wiki.mjs --lang ja` が exit 0 で通ること。
  - `npm run verify` が exit 0 で通ること。
