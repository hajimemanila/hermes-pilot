---
name: annotation
description: "Fix UI from a hand-drawn red-mark screenshot: file an [review] annotation task, read marks/note, apply the change."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [review, annotation, screenshot, ui, human-in-the-loop]
    category: workflow
    phase: fix
    role: author
    abstract_roles: [role:visual-reviewer, role:builder]
    recommended_role: role:visual-reviewer
    quality_tier: evidence-based
---

# Annotation（スクショの赤入れで修正点を受け取る）

実装後の UI 確認を「文章の指摘」ではなく**画像の赤入れ**で受け取る。
人はスクショに線・矩形・矢印とひとことを書き、アプリが座標付きの
`.annotation.json`（`marks` + `note`）に落とす。エージェントはそれを読み、
**指摘された場所を特定して直す**。

このスキルは **`hermes-pilot` プラグイン同梱**。データの置き場は
`~/.hermes/plugin-data/hermes-pilot/review/`（環境変数 `HP_DATA_DIR` で上書き可）。

## Language

Write user-facing prose in the run's UI language — sheet title/topic/question/option text, SPEC prose, and the comments and summaries you post.
Keep machine tokens ASCII and unchanged: `label=`, `sheet=`, `mode=`, `round=`, `target=`, task ids, file paths, and the SPEC keys **Execution Mode** / **Objective** / **Files** / **Verify**.
This is `LANGUAGE_RULE_MARKER` / `LANGUAGE_RULE_EN` in `apps/bridge/src/language-rule.js`; `apps/bridge/test/languageRule.test.js` keeps this section and the bridge prompt identical.
When the run's language is Japanese, only the prose switches to Japanese (JA variant in the same module); the machine line and paths stay ASCII.
The rule covers the sheet you write and every prose line you post to the board, including the 1-line `complete --summary`.

## いつ使うか

- 実装後の見た目（間隔・折返し・色・重なり）を人の目で確定したい
- 文章で説明すると長くなる・言葉が食い違う（「ここ」が通じない）
- PWA のスクショに赤を入れるのが最短（`390x844` の撮影が済んでいる）

使わない: 一意に決まる不具合（テスト失敗、例外、型エラー）は自分で直す。

## 抽象ロールと委譲・フォールバック（Model-Agnostic Delegation）

このスキルは**モデル非依存**。特定モデル名・プロバイダ名・課金プラン・個人環境のパスを
ここに書かない。「どの抽象ロールをどの実モデルへ割り当てるか」は実機プロファイル側
（プロファイルメモリ / `SOUL.md` の割当表）が持つ。

- `role:visual-reviewer` — 実装ロールとは別枠。スクショ差分（`.before.png` / `.after.png`）と
  赤入れ画像（`.annotated.png`）の読解・座標の言語化・`390x844` / `820x1180` の視覚検収。
  **このスキルの主ロール**。
- `role:builder` — 特定された箇所の修正実装、`npm run deploy`、`npm run verify`。
- `role:decision-framer` — 「どこまで直すか」が分岐するときの設問設計（`quick-review` へ渡す）。
- `role:planner` — 赤の指摘が複数コンポーネント／状態に跨り、原因究明が複雑なとき。

### ネイティブ委譲とフォールバック

1. 手順 B の画像読解は **`role:visual-reviewer` へ `delegate_task` で委譲するのを推奨**。
   `images` に画像パスを渡し、`goal` / `context` にロール名と「指摘箇所を領域名＋根拠で返す」を明記する。
2. 子は**読み取り専用の助言者**。ファイル編集・commit・`npm run deploy` はしない。
   適用と検証は親（`role:builder`）が行う。
3. 委譲が失敗した（エラー / レート制限 / タイムアウト / マルチモーダル非対応 / 委譲ツール未搭載）
   場合は**停止しない**。`.annotation.json` の `marks` 座標配列（0〜1 正規化）と `note` だけで
   自分で特定し、修正まで完走する。座標があれば画像の読解は代替できる。
4. フォールバックした事実は `comment` に 1 行残す。

### 外部 AI CLI の禁止境界

`gemini` CLI（`gemini -p` 等）・`agy -p` のような外部 AI CLI をサブプロセスで起動して
画像を読ませる経路は使わない（`spawn` / `execFile` / `exec` も対象）。委譲は Hermes の
ネイティブ API プロバイダ＋`delegate_task` のみ。ランタイムコード側は `npm run check:oauth` が機械検査する。

## 手順 A: 自分で注釈タスクを起票する（スクショを撮った側）

### 1. 撮る（UI が変わる変更のときだけ）

- `npm run deploy` を**先に**実行（ブリッジは `apps/web/dist` を配信する。ビルドしないと古い画面が写る）
- 撮影: PWA は `390x844`（タブレット確認は `820x1180`）
- 置き場: `~/.hermes/plugin-data/hermes-pilot/review/shots/<label>-<round>.png`
- 変更前と後を比べるなら `.before.png` / `.after.png` を両方残す

### 2. 起票して `blocked` にする

本文の機械可読行:

```text
[review] label=<label> round=<round> mode=annotation image=shots/<label>-<round>.png target=<repo_path> chat=<session_id>
```

```bash
hermes kanban create "注釈: <何を見てほしいか>" --body "$(cat <<'BODY'
見てほしい点（1〜3 個）。どの画面の、どの状態か。

[review] label=tasks-strip round=1 mode=annotation image=shots/tasks-strip-1.png target=~/Projects/your-repo chat=<session_id>
BODY
)" --assignee <profile>

hermes kanban block <task_id> "注釈待ち（赤入れ）" --kind needs_input
```

- `image=` は `review/` からの相対（`shots/...`）。`..` と絶対パスは拒否される
- `assignee` は必須（無いと dispatcher が拾わない）
- PWA から起票する場合: レビュータブ →［＋ 注釈］→ 画像を選ぶ → 送信
  （`POST /api/review/annotation/new`。本文と `chat=` はブリッジが組み立てる）

### 3. 待つ

回答（赤入れ）が来るまで別のタスクを進める。赤を自分で捏造しない。

## 手順 B: 赤入れを受け取って直す

保存物（`review/shots/` 配下）:

| ファイル | 中身 |
|---|---|
| `<label>-<r>.png` | 下地（元のスクショ） |
| `<label>-<r>.annotated.png` | 赤入れ合成済み（**人が何を指したかはこれで見る**） |
| `<label>-<r>.annotation.json` | `{ note, marks: [{tool, points}], base_image, annotated_image, base_sha256, image_sha256, annotated_at }` |

`marks[].points` は **元画像の幅・高さに対する % (0〜1)**。`tool` は `pen` / `rect` / `arrow`。
ので、座標 → 実画面の位置は `x * width`, `y * height` で戻す。

1. `.annotation.json` の `note` を読む（ひとこと。ここに意図が書いてある）
2. `annotated.png` を**`role:visual-reviewer` へ `delegate_task` で委譲して**読む
   （`images` に `annotated.png` と `before` / `after` を渡し、指摘の領域・対象コンポーネント・
   根拠を返させる）。委譲できないときは画像を無くても `marks` の座標だけで読める —
   **止まらずに座標フォールバック**へ落ちる
3. 赤の領域 → どのコンポーネントかを特定する（DOM なら `document.elementFromPoint`、
   React なら該当 CSS/JSX を `rg` で引く）
4. **指摘された場所だけ**直す。周辺の「ついで改善」は混ぜない（差分が読めなくなる）
5. `npm run deploy` → 撮り直して after を残す（実装・デプロイ・`npm run verify` は `role:builder` の仕事＝親が行う）
6. `hermes kanban comment <task_id> "反映: <どのファイルの何をどう直したか>"` を残す

赤入れは `POST /api/review/<task_id>/annotation`
（`{annotated_image: "data:image/png;base64,…", marks, note}`）で保存され、
同時に `comment` + `unblock` される。同じ画像の再送は冪等（`image_sha256`）。

## 落とし穴

- **回答は `blocked` のときだけ**受け付ける。`ready` / `running` / `done` に送ると 409 `NOT_WAITING`
- 画像は 12MB まで（data URL）。超えるなら縮小してから送る
- `marks` は 200 件、`points` は 1 ストローク 400 点までに丸められる（それ以上は捨てられる）
- `.annotation.json` の `annotated_image` は**相対パス**。解決はブリッジが `review/` 配下で行う
- 座標は「元画像」基準。合成済み画像を縮小して見ても比率は変わらないが、
  スクショを撮り直して下地が変わったら**古い marks は使えない**（round を上げて起票し直す）
- 画像をコピーするときは `preserveTimestamps: true`（一覧は `mtime` の新しい順に並ぶ）
