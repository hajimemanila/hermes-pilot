# Hermes Pilot v0.3.0 — Wiki スクリーンショット撮影台本

このドキュメントは、GitHub Wiki（Manual編・Showcase編①②）の全 **30 ID × 2 サイズ（計 60 枚）** の撮影台本および自動チェックリスト進捗表です。

---

## 1. ディレクトリ構造とファイル命名規約（日英完全パリティ設計）

日本語版（`ja`）を先に完成させ、後からクリーンな英語環境（`en`）で撮影した際に **Markdown 内のパスを `assets/ja/` → `assets/en/` に一括置換するだけで英語版 Wiki が完成する** よう、以下の命名規約に統一します。

```text
docs/wiki/assets/
  ├── ja/
  │   ├── MN01_login-pairing_390.png
  │   ├── MN01_login-pairing_1180.png
  │   ├── ...
  │   ├── SC01_seed-sheet_390.png
  │   └── SC01_seed-sheet_1180.png
  └── en/
      ├── MN01_login-pairing_390.png
      ├── MN01_login-pairing_1180.png
      ├── ...
      ├── SC01_seed-sheet_390.png
      └── SC01_seed-sheet_1180.png
```

- **サイズ記号**:
  - `_390.png` = スマホ縦（`390×844` / `@2x` Retina = 実画像 `780×1688`）
  - `_1180.png` = 横置きタブレット 2ペイン（`1180×820` / `@2x` Retina = 実画像 `2360×1640`）
- **撮影ヘルパーコマンド（`scripts/capture-wiki.mjs`）**:
  - 進捗確認: `node scripts/capture-wiki.mjs --status --lang ja`
  - Manual編の基本6タブ一括撮影: `node scripts/capture-wiki.mjs --preset manual --lang ja`
  - 現在の画面を指定IDで両サイズ即撮り: `node scripts/capture-wiki.mjs --id SC02 --lang ja`

---

## 2. ショーケース題材（日英対訳シード台本）

> **題材**: **FocusFlow（ミニマル・ポモドーロ＆タスクタイマー）**
> - **選定理由**: UIの視覚的変化（タイマー円環・タスク一覧・統計バー）が一目で分かり、「①起点〜プロトタイプ完成 → ②Memos/Brainstormからの機能追加 → ③Coherence監査からのリファクタリング」の3段階を綺麗に見せられ、そのまま `v0.3.0` のレシピ第1号にも流用できるため。

### 2.1 コピペ用テキストセット（JA / EN）

| フェーズ | 用途 | 🇯🇵 日本語環境 (`--lang ja`) 用テキスト | 🇺🇸 英語環境 (`--lang en`) 用テキスト |
| :--- | :--- | :--- | :--- |
| **Phase 1: 起点** | **Spec Seed 1行入力** (`Visual-Gate` 推奨) | `シンプルなポモドーロタイマーを作って。25分集中＋5分休憩の切替、今日の完了トマト数の記録、スマホで見やすい大きな残り時間表示` | `Build a minimal Pomodoro timer with 25m focus / 5m break toggle, today's completed tomato counter, and a large mobile-friendly countdown display` |
| **Phase 1: 検収** | **Annotation 赤入れ指示** (モックまたは初回実装スクショへの赤入れ) | `① 残り時間のフォントを1.5倍大きくして中央寄せに / ② スタート・一時停止ボタンを親指が届く下部エリアに配置` | `1. Make the countdown timer font 1.5x larger and centered / 2. Move the Start/Pause button to the bottom thumb zone` |
| **Phase 2: 蓄積** | **Memos タブへのアイデアメモ** (タグ: `#idea`, `#ui`) | `ポモドーロ完了時にどのタスクに何分使ったか選べるようにしたい。あと夜間作業用にダークテーマ切替が欲しい` | `Track which task each completed Pomodoro belonged to, and add a dark theme toggle for late-night focus sessions` |
| **Phase 2: 拡張** | **Brainstorm / 追加 Spec Seed** | `タスク別の集中時間サマリバーとダークモード切替ボタンを追加` | `Add a per-task focus duration summary bar and a dark mode toggle button` |
| **Phase 3: 保守** | **Coherence & Refactor** | `🛠 Refactor` シートを開き、ライブ診断帯を確認して推奨スイープを1タップ起票 | Open `🛠 Refactor` sheet, inspect the live coherence band, and file the recommended sweep in one tap |

---

## 3. Manual 編：撮影＆ドッグフーディング・チェックリスト（MN01〜MN15）

> 💡 `⚡ Auto` マークのあるカットは `node scripts/capture-wiki.mjs --preset manual --lang ja` で一括自動撮影できます。モーダルやメニューを開いた状態のカットは、ブラウザで状態を作ってから `--id <ID>` で撮影するか、実機・DevTools で撮影します。

| ID | ファイル名ベース (`<ID>_<slug>`) | タブ | 撮影方式 | ドッグフーディング確認項目 | JA `390` | JA `1180` | EN `390` | EN `1180` |
| :--- | :--- | :--- | :--- | :--- | :---: | :---: | :---: | :---: |
| **MN01** | `MN01_login-pairing` | Auth | 手動 / `--id MN01` | `/auth` のログイン画面・ペアリング案内が言語設定通りに美しく表示されるか | [x] | [x] | [ ] | [ ] |
| **MN02** | `MN02_settings-overview` | Settings | ⚡ Auto | Settings タブの全体表示、`Optimise this Hermes` や言語・テーマ・Vibe 切替が揃っているか | [x] | [x] | [ ] | [ ] |
| **MN03** | `MN03_tasks-overview` | Tasks | ⚡ Auto | ボード選択、ステータスフィルタ、Spec Seed / Brainstorm / Refactor の3ボタンとタスク一覧が崩れないか（`1180` で2ペインになるか） | [x] | [x] | [ ] | [ ] |
| **MN04** | `MN04_task-detail-diff` | Tasks | `--id MN04` | タスクをタップした詳細画面で、イベント履歴・Git Diff・Approve / Comment / Abort が正常に機能するか | [x] | [x] | [ ] | [ ] |
| **MN05** | `MN05_review-inbox` | Review | ⚡ Auto | Waiting / Done 一覧と上部の作業フィード（`.ak-feed`）の時刻がすべて相対時刻（`relTime`）で統一されているか | [x] | [x] | [ ] | [ ] |
| **MN06** | `MN06_annotation-toolbar` | Review | `--id MN06` | スクショ付きレビューで Annotation エディタ（矩形・矢印・テキスト・色切替・ツールバー折りたたみ）が滑らかに動くか | [x] | [x] | [ ] | [ ] |
| **MN07** | `MN07_chat-overview` | Chat | ⚡ Auto | ストリーミング応答、Thinking / Tool ログ折りたたみ、下部スニペットチップ帯が表示されるか（`1180` で左セッション＋右最小ヘッダ＆タイムラインになるか） | [x] | [x] | [ ] | [ ] |
| **MN08** | `MN08_chat-bubble-menu` | Chat | `--id MN08` | メッセージバブル操作メニュー（コピー・Memosへ保存・要約・追加指示）が画面外にはみ出さず動作するか | [x] | [x] | [ ] | [ ] |
| **MN09** | `MN09_chat-session-drawer` | Chat | `--id MN09` | セッション一覧ドロワー（および横断検索）で `Reply` / `RO` バッジと実行中インジケータが正しく表示されるか | [x] | [x] | [ ] | [ ] |
| **MN10** | `MN10_memos-grid` | Memos | ⚡ Auto | `390` では1列（高さ自動・タグ表示）、`1180` では2列（高さ220px・4行クランプ）のレスポンシブ契約通りに描画されるか | [x] | [x] | [ ] | [ ] |
| **MN11** | `MN11_memo-handoff` | Memos | `--id MN11` | メモカードから `🧠 Brainstorm` または `📝 Spec Seed` へ1タップでテキストを引き継げるか | [x] | [x] | [ ] | [ ] |
| **MN12** | `MN12_terminal-pty` | Terminal | ⚡ Auto | Terminal タブで xterm PTY が遅延チャンクエラーなく開かれ、OS別スニペット帯と Enter 送信が機能するか | [x] | [x] | [ ] | [ ] |
| **MN13** | `MN13_theme-vibe-compare` | Settings | `--id MN13` | `Dark / Light` × `⚡ Dopamine / 🧘 Serotonin` を切り替えた際、バッジや枠線に黒枠漏れ（P7）が無いか | [x] | [x] | [ ] | [ ] |
| **MN14** | `MN14_pwa-diagnostics` | Settings | `--id MN14` | Settings 内の PWA 診断を実行し、manifest / icons / SW / scope がすべて `✓`（緑）で読めるか | [x] | [x] | [ ] | [ ] |
| **MN15** | `MN15_hermes-dashboard-tab` | `:9119` | 手動スクショ | 標準 Hermes Dashboard (`:9119`) の `Hermes Pilot` タブでリポジトリ管理・スニペット編集・ログ閲覧が同期しているか | [x] | [x] | [ ] | [ ] |

---

## 4. Showcase 編：一気通貫ストーリー撮影＆ドッグフーディング（SC01〜SC09）

> 💡 ショーケースを実際に動かしながら、各フェーズの画面が出たタイミングで `node scripts/capture-wiki.mjs --id SC01 --lang ja` のように撮影します。

| ID | ファイル名ベース (`<ID>_<slug>`) | タブ | フェーズ | ドッグフーディング確認項目（ここを通せば A2B パイプライン全経路の検証が完了） | JA `390` | JA `1180` | EN `390` | EN `1180` |
| :--- | :--- | :--- | :--- | :--- | :---: | :---: | :---: | :---: |
| **SC01** | `SC01_seed-sheet` | Tasks | **1. 起点 (Spec Seed)** | `📝 Spec Seed` シートを開き、2.1 の1行テキストを入力して実行ポリシー（`Visual-Gate` / `Zero-Stop`）を選べるか | [x] | [x] | [ ] | [ ] |
| **SC02** | `SC02_quick-review-interview` | Review | **2. 設計面接 (Quick Review)** | Architect が起票した Round 1 の3問シートを開き、`⚡ Accept All Recommended` ボタンと各選択肢の推奨理由が表示されるか | [x] | [x] | [ ] | [ ] |
| **SC03** | `SC03_spec-launchpad` | Tasks | **3. 仕様確定と起票 (Launchpad)** | Round 2 で生成された `docs/SPEC-*.md` が Spec Launchpad に現れ、各 Batch の `Execution Mode` と `Recommended Role` を確認して1タップ起票できるか | [x] | [x] | [ ] | [ ] |
| **SC04** | `SC04_live-worker-feed` | Tasks | **4. 自走モニタリング (Live Run)** | `ArchitectJobBar` / `LiveSheet` / `WorkerFeed` でワーカーの進行状況がリアルタイムにストリーミング表示されるか | [x] | [x] | [ ] | [ ] |
| **SC05** | `SC05_annotation-redpen` | Review | **5. 赤入れ指示 (Annotation)** | ワーカーが添付したスクショ（またはモック）に対し、指／マウスで矩形・矢印・番号付きコメントを描いて送信し、ワーカーがアンブロックされるか | [x] | [x] | [ ] | [ ] |
| **SC06** | `SC06_before-after-compare` | Review | **6. 修正検収 (Before ↔ After)** | 再提出されたスクショで `Before ↔ After` トグルを切り替え、赤入れ通りに直っていることを確認して `✅ Looks Good` で完了できるか | [x] | [x] | [ ] | [ ] |
| **SC07** | `SC07_mission-receipt` | Tasks | **7. 完走レシート (Mission Receipt)** | 全 Batch 完了後に Mission Receipt モーダルを開き、`1200×630` PNG と 280文字以内のシェアテキストが出力されるか | [x] | [x] | [ ] | [ ] |
| **SC08** | `SC08_memos-to-brainstorm` | Memos / Tasks | **8. 次期アイデア拡張 (Brainstorm)** | `Memos` に書き留めたアイデアや完走レポートから `🧠 Brainstorm` シートを起動し、機能追加サイクルへ繋げられるか | [x] | [x] | [ ] | [ ] |
| **SC09** | `SC09_coherence-refactor-sheet` | Tasks | **9. 品質維持 (Coherence & Refactor)** | `🛠 Refactor` シートのライブ診断帯（Hard fails / Soft signals / Hotspots）を確認し、リファクタスイープを起票できるか | [x] | [x] | [ ] | [ ] |

---

## 5. Showcase 編②：オートパイロットモード一気通貫（AP01〜AP06）

> 💡 `node scripts/capture-wiki.mjs --preset autopilot --lang ja` で FocusFlow の 4 幕オートパイロット全 12 カットを一括自動撮影できます。

| ID | ファイル名ベース (`<ID>_<slug>`) | タブ | フェーズ | 確認項目 | JA `390` | JA `1180` | EN `390` | EN `1180` |
| :--- | :--- | :--- | :--- | :--- | :---: | :---: | :---: | :---: |
| **AP01** | `AP01_autopilot-starter` | Autopilot | **Act 1. スターター** | 4 レシピカード・1 行入力ランチャー・プロジェクトバーが崩れないか | [x] | [x] | [ ] | [ ] |
| **AP02** | `AP02_autopilot-swipe-deck` | Autopilot | **Act 2. スワイプデッキ** | Option-Cycle（1 選択肢 = 1 カード）・ビジュアルモック・4 方向バーが揃うか | [x] | [x] | [ ] | [ ] |
| **AP03** | `AP03_autopilot-gacha-remix` | Autopilot | **Act 2. スタイルガチャ** | 🎲 スタイルガチャ＆リミックスチップがカード上に違和感なく展開されるか | [x] | [x] | [ ] | [ ] |
| **AP04** | `AP04_autopilot-live-radar` | Autopilot | **Act 3. ライブ軌道レーダー** | 2 並列ワーカー（W1/W2）色分けパルス・中央アイリス・実況ティッカーが動くか | [x] | [x] | [ ] | [ ] |
| **AP05** | `AP05_autopilot-xray-nudge` | Autopilot | **Act 3. X-Ray & Live Nudge** | X-Ray 差分バー・ステップ振り返りドロワー・YOU 象限 Nudge ピンが見えるか | [x] | [x] | [ ] | [ ] |
| **AP06** | `AP06_autopilot-complete-card` | Autopilot | **Act 4. 完了カード** | Before/After タイムラプス・成果物リンク・起動コマンド・レシート導線が揃うか | [x] | [x] | [ ] | [ ] |

---

## 6. Wiki ページ構成（v0.3.0）

1. **`Home.md`** — Hermes Pilot の全体像（A2B + Autopilot 2 モード案内 ＋ Interactive Demo リンク ＋ 目次）
2. **`Showcase-From-Idea-to-Product.md`** — ショーケース①：コックピット編（`SC01`〜`SC09`）
3. **`Showcase-Autopilot-Mode.md`** — ショーケース②：オートパイロット編（`AP01`〜`AP06`）
4. **`Manual-Installation-and-Setup.md`** — インストール、ペアリング、環境最適化、PWA 診断（`MN01`, `MN02`, `MN14`, `MN15`）
5. **`Manual-A2B-Tasks-and-Review.md`** — Tasks タブ、Spec Launchpad、Quick Review、Annotation 赤入れ＆検収（`MN03`〜`MN06`）
6. **`Manual-Chat-Memos-and-Terminal.md`** — Chat、Memos、Terminal、Theme & Vibe 設定（`MN07`〜`MN13`）
