---
name: spec-architect
description: "Turn a one-line seed into a SPEC the batch runner can execute: sheet-driven interview, then docs/SPEC-<SLUG>.md with Execution Mode per batch."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [architect, spec, interview, quick-review, a2b-pipeline, kanban]
    category: workflow
    phase: design
    role: architect
    abstract_roles: [role:planner, role:builder, role:visual-reviewer, role:decision-framer]
    recommended_role: role:planner
    quality_tier: decision-ready
---

# Spec Architect（1 行の種から自走できる仕様書を作る）

Architect の仕事は「仕様書を書くこと」ではなく、**Builder（カンバン自走ワーカー）が
追加の質問をせずに完走できる仕様書を 2 ラウンドで作ること**。長文の質問をチャットへ
並べない。判断は設問シートに載せ、人が 1 タップで答える形にする。

このスキルは **`hermes-pilot` プラグイン同梱**。`hermes-pilot init` が
`~/.hermes/skills/spec-architect/` へ配置する。

## Language

Write user-facing prose in the run's UI language — sheet title/topic/question/option text, SPEC prose, and the comments and summaries you post.
Keep machine tokens ASCII and unchanged: `label=`, `sheet=`, `mode=`, `round=`, `target=`, task ids, file paths, and the SPEC keys **Execution Mode** / **Objective** / **Files** / **Verify**.
This is `LANGUAGE_RULE_MARKER` / `LANGUAGE_RULE_EN` in `apps/bridge/src/language-rule.js`; `apps/bridge/test/languageRule.test.js` keeps this section and the bridge prompt identical.
When the run's language is Japanese, only the prose switches to Japanese (JA variant in the same module); the machine line and paths stay ASCII.
The rule covers the sheet you write and every prose line you post to the board, including the 1-line `complete --summary`.

## いつ使うか

使う:
- 1 行メモ / 音声ディクテーション（`Spec Seed`）から実装計画を作るとき
- 既存リポジトリに新しい機能群（複数バッチ）を足すとき
- 人が「何を作るか」は言えるが「どう作るか」は決めていないとき

使わない:
- 変更が 1 ファイルで正解が一意（そのまま実装して `npm run verify` を通す）
- すでに `docs/SPEC-*.md` があり、`hermes-pilot` の仕様ランチャーで起票するだけのとき

## 2 ラウンド・プロトコル

### Round 1 — Quick Review 直結インタビュー

チャットに箇条書きの質問を並べる代わりに、**設問シートを 1 枚だけ**作る。
**第一推奨は構造化 JSON（`mode=standard`）**。手書き HTML とヘッドレスブラウザ撮影は
「見た目の比較そのものが論点」のときだけの任意拡張。

1. 質問は **3±1 問**。各問は「人が決めること 1 つ」。事実（`file:line`・実行結果）は
   本文に書き、人には決定だけを残す。根拠は**該当箇所の最小確認だけ**で足りる
   （リポジトリ全体の作り込みやモック構築をしない。決まったら即シート）。
   **Round 1 では `npm test` / `npm run verify` を走らせない**。探索は `rg` / `grep` で
   該当シンボルだけを引き、依存関係の全量確認やビルドで時間を使わない。テストとビルドは
   Round 2 で SPEC（各バッチの Verify）に書けばよい。シートを書いたら**即ブロック**する。
2. 各問に選択肢 2〜3・`recommended: true` を 1 つ。理由（利点 / 代償）を必ず添える。
3. 見た目の論点（配置・情報密度・配色の比較そのもの）**だけ**両案を絵にする。
   それ以外（仕様・ロジック・文言・API・データ設計）は `.json` のみで起票して即ブロックする
   — `browser_exec` での撮影も 300 行級の HTML 生成も行わない。
   既存画面への追加で絵が要るときは、現行 UI の忠実な再現を先に撮る。
4. 出力先は `quick-review` スキルと同じ場所・同じ形式。**主成果物は `.json`**:

```text
~/.hermes/plugin-data/hermes-pilot/review/sheets/spec-<slug>-1.json   ← これが主（mode=standard）
~/.hermes/plugin-data/hermes-pilot/review/sheets/spec-<slug>-1.html   ← 見た目の論点のときだけ任意
```

5. カンバンへ起票して **blocked** にする（回答が来るまで実装しない）:

```bash
hermes kanban create "Q1〜Q3: <プロジェクト名>の設計方針" --assignee <profile> --body "$(cat <<'BODY'
<何が決まれば仕様書を書き始められるか。いま何が止まっているか。>

[review] label=spec-<slug> round=1 mode=standard sheet=sheets/spec-<slug>-1.json target=<repo_path> chat=<session_id>
BODY
)"
hermes kanban block <task_id> "仕様インタビュー待ち（Q1〜Q3）" --kind needs_input
```

`.json` だけで PWA のネイティブフォーム（`<StandardForm>`）と「シート全体を開く ↗」の
両方が動く（`.html` が無ければブリッジが `.json` から安全な HTML を動的生成する）。

待つ間は別のタスクを進める。**自分で回答を捏造しない。**

### Round 2 — SPEC 生成

回答（`.answer.json` / `.answer.txt` / コメントの `【レビュー回答】`）を読み、
`docs/SPEC-<SLUG>.md` を書く。`(未選択 = お任せ)` は推奨案で確定してよい。

必須フォーマット（`apps/bridge/src/specs.js` が機械的に読む。**形を変えない**）:

```markdown
# SPEC: <プロジェクト名> (`SPEC-<SLUG>`)

状態: 仕様確定（<日付>・インタビュー Q1〜Q3 合意済み）
前提仕様: <前バージョンの SPEC があればリンク>

## 1. コンセプト

<3〜6 行。何を、誰のために、どこまで作るか。>

## 2. 合意決定表（インタビュー結果）

| # | 論点 | 決定内容 | 根拠・背景 |
|---|---|---|---|
| **D1** | <問い> | <決めたこと> | <なぜ> |

## 3. 詳細技術仕様

### 3.1 <領域>

対象: <file>, <file>

1. **<機能>**: <仕様。関数名・保存キー・エンドポイント名まで書く>

## 4. カンバンタスク分割（Batch <SLUG>-1 〜 <SLUG>-N）

### Batch <SLUG>-1: <バッチ名>

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: <1〜3 行。何をどのファイルに実装するか>
- **変更・新規ファイル**:
  - 新規: `<path>`
  - 変更: `<path>`
- **受入条件（Verify）**:
  - <観測可能な条件。テストファイル名まで書く>
  - `npm run verify` が全件パスすること。

---
```

## バッチ見出しの規約（守らないと起票が壊れる）

- バッチ見出しは **`### Batch <ID>: <Title>`** のみ。`<ID>` は英字始まり 16 文字まで
  （`V5-1` / `P2` / `T3` は可、`1.1` は不可）。
- バッチ以外の `###` 見出しは**必ず数字で始める**（`### 3.1 …`）。数字で始めないと
  仕様ランチャーがバッチと誤認して起票する。
- 各バッチに必ず次の 3 行を置く: `- **Execution Mode**: ...` / `- **目的**: ...` /
  `- **受入条件（Verify）**: ...`。`Execution Mode` が無いバッチは起票時に
  行動契約（`[Hermes Pilot Execution Contract]`）が注入されず、自走が保証されない。
- 任意行 `- **Recommended Role**: role:planner | role:builder | role:visual-reviewer`
  を `Execution Mode` の直後に置ける（設計寄りは `role:planner`、実装・検証は `role:builder`、
  見た目の検収を含むなら `role:visual-reviewer`）。未宣言でも起票は壊れない。

## Execution Mode の選び方

| Mode | 使うとき | ワーカーに注入される契約 |
|---|---|---|
| `Zero-Stop` | 正解が一意（テスト・ビルド・機械的リファクタ） | 質問せず `npm run verify` が通るまで自律修復して `done` |
| `Fast-Track Review` | 実装方針が 1 つに決まらず、途中で分岐しうる | 分岐が出たら実装前に `quick-review` シートを起票して 1 タップ承認を待つ |
| `Visual Gate` | 見た目が変わる（UI・CSS・文言・レイアウト） | `npm run deploy` → 実画面 390×844 / 820×1180 を検証・撮影 → 必要なら `annotation` レビュー |

迷ったら `Visual Gate`。見た目が変わらないと断言できないなら視覚検収を挟む。

## 抽象ロールと委譲・フォールバック（Model-Agnostic Delegation）

このスキルは**モデル非依存**。特定モデル名・プロバイダ名・課金プラン・個人環境のパスをここに書かない。
「どの抽象ロールをどの実モデルへ割り当て、失敗時にどこへ落とすか」は**実機プロファイル側**
（プロファイルメモリ / `SOUL.md` の割当表）が持つ。仕様書とスキルは抽象ロール名だけを扱う。

### 4 つの抽象ロール

- `role:planner` — 高度推論・設計・仕様策定・複雑な原因究明。Round 1 の問い設計、
  Round 2 の影響分析・バッチ分割がここ。
- `role:builder` — 通常実装・テスト修正・ビルド・定型作業。SPEC に沿った実装と
  `npm test` / `npm run verify` の修復がここ。
- `role:visual-reviewer` — スクショ差分・赤入れ画像（`.annotated.png`）の読解・
  `390x844` / `820x1180` の視覚検収。**見た目の比較が論点のときだけ**使う。
- `role:decision-framer` — 設問設計・トレードオフ整理。3±1 問への切り出しと
  選択肢・推奨理由の構成がここ。

推奨の当て方:

- Round 1 / Round 2 の設計推論・影響分析・バッチ分割は **`role:planner`**。
- 絵（モック・スクショ）を検証する場合のみ **`role:visual-reviewer` を併用**する。
  絵の無い論点（API・保存形式・命名・ロジック）には付けない。
- 各バッチ定義に任意行 `- **Recommended Role**: role:builder` を書ける
  （`role:planner` / `role:visual-reviewer` / `role:decision-framer` も同様）。
  未宣言なら Execution Mode から推定される。

### ネイティブ委譲とフォールバック

委譲は Hermes Agent 標準の **`delegate_task`** だけを使う。

1. 親がロール条件に合うサブタスクを切り出し、`goal` / `context` にロール名を明記して 1 回だけ委譲する。
2. 子は**読み取り専用の助言者**。ファイル編集・commit・install・`npm run verify` は親が行う。
3. 委譲が失敗した（エラー / レート制限 / タイムアウト / 未対応モデル / 委譲ツール未搭載）
   場合は**停止しない**。プロファイルの割当表どおりのフォールバック順（次点 → 主モデル）へ
   切り替え、自分でそのまま完走する。
4. フォールバックした事実は完了報告か comment に 1 行残す（黙って検証を落とさない）。
5. 同じロールで 2 回失敗したら 3 回目を投げない。自分で完走する。

### 外部 AI CLI の禁止境界

`gemini` CLI（`gemini -p` 等）・`agy -p` のような**外部 AI CLI をサブプロセスで起動して
推論させる経路は使わない**。`spawn` / `execFile` / `exec` での起動も、シェルからのパイプも対象。
ランタイムコード側は `npm run check:oauth` が機械検査する。委譲は Hermes のネイティブ API
プロバイダ＋`delegate_task` のみ。

## バッチ分割の目安

- 1 バッチ = **1 回の `npm run verify` で閉じる**変更量（おおむね 200〜600 行）。
- 依存は前から後ろへの一方向。`V5-2` が `V5-1` の API を使うなら `V5-1` を先に置く。
- 「基盤 → 機能 → 演出 → 総合検証」の順にし、最後のバッチは結合検証と実画面監査にする。
- 6 バッチを超えるなら、独立した SPEC に割る（1 SPEC = 1 つの目的）。

## 仕上げ（A2B ハンドオフ）

SPEC を書いたら、次を 1 つだけ出す:

```text
仕様書: docs/SPEC-<SLUG>.md（Batch <SLUG>-1 〜 <SLUG>-N / n バッチ）
起票: hermes-pilot の Tasks → 仕様ランチャー、または scripts から specs.launchSpec（dryRun: true で確認 → 実行）
```

`autoStart=true` のタグ付きで依頼されていた場合は、未起票バッチを **1 回だけ**
起票する（`dryRun: true` → `dryRun: false`。二重起票を絶対に作らない）。

## 落とし穴

- **Round 1 に手書き HTML を作らない／`browser_exec` で撮らない**。見た目の比較そのものが
  論点でなければ `.json` 1 枚で起票して即ブロックする（HTML とモック画像で数分失うだけで
  判断は変わらない）。絵が要るのは配置・情報密度・配色の比較が主題のときだけ。
- **`docs/SPEC-*.md` のファイル名は大文字 `SPEC` で始める**。`spec-*.md` は走査対象外。
- `BATCH_ID_RE` は 16 文字まで。長い ID（`V5-1-optimizer`）は切り落とされる。
- 本文中の `### ` 見出しは起票時のバッチ境界になる。**バッチ内の小見出しは `####` 以下**にする。
- `- **実行モード**` / `[Mode: ...]` の表記は `specs.js` の正規表現に合う形
  （`- **Execution Mode**: \`[Mode: Zero-Stop]\``）を厳守する。バックティックの有無は許容。
- 仕様書に **認証情報・トークン・個人情報を書かない**。パスは `~` か相対パスで書く。
- インタビュー回答を待たずに SPEC を書き始めない。待つ間は別タスクを進める。
