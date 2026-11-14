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
    quality_tier: decision-ready
---

# Spec Architect（1 行の種から自走できる仕様書を作る）

Architect の仕事は「仕様書を書くこと」ではなく、**Builder（カンバン自走ワーカー）が
追加の質問をせずに完走できる仕様書を 2 ラウンドで作ること**。長文の質問をチャットへ
並べない。判断は設問シートに載せ、人が 1 タップで答える形にする。

このスキルは **`hermes-pilot` プラグイン同梱**。`hermes-pilot init` が
`~/.hermes/skills/spec-architect/` へ配置する。

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

1. 質問は **3±1 問**。各問は「人が決めること 1 つ」。事実（`file:line`・実行結果）は
   本文に書き、人には決定だけを残す。
2. 各問に選択肢 2〜3・`recommended: true` を 1 つ。理由（利点 / 代償）を必ず添える。
3. 見た目の論点は**両案を絵にする**。既存画面への追加なら現行 UI の忠実な再現を先に撮る。
4. 出力先は `quick-review` スキルと同じ場所・同じ形式:

```text
~/.hermes/plugin-data/hermes-pilot/review/sheets/spec-<slug>-1.html
~/.hermes/plugin-data/hermes-pilot/review/sheets/spec-<slug>-1.json
```

5. カンバンへ起票して **blocked** にする（回答が来るまで実装しない）:

```bash
hermes kanban create "Q1〜Q3: <プロジェクト名>の設計方針" --assignee <profile> --body "$(cat <<'BODY'
<何が決まれば仕様書を書き始められるか。いま何が止まっているか。>

[review] label=spec-<slug> round=1 mode=sheet sheet=sheets/spec-<slug>-1.html target=<repo_path> chat=<session_id>
BODY
)"
hermes kanban block <task_id> "仕様インタビュー待ち（Q1〜Q3）" --kind needs_input
```

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

## Execution Mode の選び方

| Mode | 使うとき | ワーカーに注入される契約 |
|---|---|---|
| `Zero-Stop` | 正解が一意（テスト・ビルド・機械的リファクタ） | 質問せず `npm run verify` が通るまで自律修復して `done` |
| `Fast-Track Review` | 実装方針が 1 つに決まらず、途中で分岐しうる | 分岐が出たら実装前に `quick-review` シートを起票して 1 タップ承認を待つ |
| `Visual Gate` | 見た目が変わる（UI・CSS・文言・レイアウト） | `npm run deploy` → 実画面 390×844 / 820×1180 を検証・撮影 → 必要なら `annotation` レビュー |

迷ったら `Visual Gate`。見た目が変わらないと断言できないなら視覚検収を挟む。

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

- **`docs/SPEC-*.md` のファイル名は大文字 `SPEC` で始める**。`spec-*.md` は走査対象外。
- `BATCH_ID_RE` は 16 文字まで。長い ID（`V5-1-optimizer`）は切り落とされる。
- 本文中の `### ` 見出しは起票時のバッチ境界になる。**バッチ内の小見出しは `####` 以下**にする。
- `- **実行モード**` / `[Mode: ...]` の表記は `specs.js` の正規表現に合う形
  （`- **Execution Mode**: \`[Mode: Zero-Stop]\``）を厳守する。バックティックの有無は許容。
- 仕様書に **認証情報・トークン・個人情報を書かない**。パスは `~` か相対パスで書く。
- インタビュー回答を待たずに SPEC を書き始めない。待つ間は別タスクを進める。
