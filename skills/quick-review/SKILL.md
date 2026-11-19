---
name: quick-review
description: "Ask a human to decide between options: build a Quick Review sheet, file a blocked [review] task, then apply the answer."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [review, human-in-the-loop, kanban, sheet]
    category: workflow
    phase: decide
    role: author
    abstract_roles: [role:decision-framer, role:planner, role:visual-reviewer]
    recommended_role: role:decision-framer
    quality_tier: decision-ready
---

# Quick Review（設問シートで判断を仰ぐ）

エージェントが実装・調査の分岐点で**人に決めてほしい**とき、長文チャットで質問せず
「選択肢＋推奨案」のシートを 1 枚出し、スマホから 1 タップで答えてもらう。
答えはカンバンの `comment` と `unblock` として戻り、ワーカーが自走を再開する。

このスキルは **`hermes-pilot` プラグイン同梱**。データの置き場は
`~/.hermes/plugin-data/hermes-pilot/review/`（環境変数 `HP_DATA_DIR` で上書き可）。

## いつ使うか / 使わないか

使う:
- 見た目・配置・文言など、**正解が一意でない**判断
- 2 つ以上の実装方針があり、どちらも成立する
- 破壊的・不可逆な操作の直前に、人の意思を確定させたい

使わない（自分で決めて進む）:
- 正解が一意（テストが通る/通らない、型エラー、排他 1 択）
- 事実確認だけで決まること（`file:line` を読めば分かる）
- 多数の項目の一括検収（1 枚に詰め込むと答えられない）

## 抽象ロールと委譲・フォールバック（Model-Agnostic Delegation）

このスキルは**モデル非依存**。特定モデル名・プロバイダ名・課金プラン・個人環境のパスを
ここに書かない。「どの抽象ロールをどの実モデルへ割り当てるか」は実機プロファイル側
（プロファイルメモリ / `SOUL.md` の割当表）が持つ。

- `role:decision-framer` — 設問設計・トレードオフ整理。**このスキルの主ロール**。
  3±1 問への切り出し、選択肢 2〜3 と推奨理由（利点 / 代償）の構成。
- `role:planner` — 複雑な設計分岐の選択肢抽出・トレードオフ比較（正解が一意でない設計判断）。
- `role:visual-reviewer` — 見た目比較の挿絵（`thumbs/*.png`）チェック。絵を付けたときだけ。
- `role:builder` — 回答の反映実装と `npm run verify`。

### ネイティブ委譲とフォールバック

1. 上記のロールに当たるサブタスクは **`delegate_task` で委譲できる**（`goal` / `context` に
   ロール名と「設問 JSON に落とせる形で返す」を明記する）。
2. 子は**読み取り専用の助言者**。シートの作成・起票・回答の反映は親が行う。
3. 委譲が失敗した（エラー / レート制限 / タイムアウト / 未対応モデル / 委譲ツール未搭載）
   場合は**停止しない**。主モデルへフォールバックし、設問 JSON を自分で完結させる。
   シートが出ないままブロックするのが最悪なので、フォールバックして必ず 1 枚出す。
4. フォールバックした事実は `comment` に 1 行残す。

### 外部 AI CLI の禁止境界

`gemini` CLI（`gemini -p` 等）・`agy -p` のような外部 AI CLI をサブプロセスで起動して
設問案や挿絵を作る経路は使わない（`spawn` / `execFile` / `exec` も対象）。委譲は Hermes の
ネイティブ API プロバイダ＋`delegate_task` のみ。ランタイムコード側は `npm run check:oauth` が機械検査する。

## 手順

### 1. 問いを 3±1 に絞る

各問は「人が決めること 1 つ」。**事実（`file:line` か実行結果）は本文に書き、人には決定だけを残す**。
選択肢は 2〜3。推奨を 1 つ決め、理由（利点 / 代償）を必ず書く。

### 2. 絵にする（任意・見た目の論点だけ）

見た目・配置・情報密度・配色の**比較そのものが論点**のときだけ、両方の案を絵にする。
現行 UI に加える変更なら、まず現行画面の忠実な再現を撮る（現物と乖離したモックを描かない）。
絵の無い論点（命名、保存形式、API、ロジック）には付けない — 付けない方が速く、判断もぶれない。
スクショが必要なときだけヘッドレスブラウザ（`browser_exec`）を使う。

### 3. シートを作る（JSON が主・HTML は任意）

**第一推奨は構造化 JSON 1 枚（`mode=standard`）**。PWA はこれでネイティブフォームを描く。
`.html` は複数タブ比較・図解・スクショ並べが不可欠なときだけの**任意拡張**。

置き場: `~/.hermes/plugin-data/hermes-pilot/review/sheets/<label>-<round>.json`
（`mkdir -p` してから書く。`<label>` は `^[a-z0-9][a-z0-9._-]{0,40}$`）

```json
{
  "label": "cockpit-03",
  "round": 1,
  "mode": "standard",
  "title": "シートの表題（タスク名と同じでよい）",
  "topic": "何を決めるのか 1〜2 文",
  "target": "~/Projects/your-repo",
  "questions": [
    {
      "id": "q1",
      "text": "問いの本文",
      "options": [
        { "id": "A", "label": "選択肢", "detail": "利点: … / 代償: …", "recommended": true, "thumb": "thumbs/cockpit-03-1/q1-A.png" },
        { "id": "B", "label": "選択肢", "detail": "利点: … / 代償: …" }
      ]
    }
  ],
  "has_global_note": true,
  "sheet": "sheets/cockpit-03-1.json",
  "created_at": "2026-11-13"
}
```

挿絵を付けるなら `review/thumbs/<label>-<round>/q1-A.png` に置き、`thumb` は `thumbs/...` の相対パスにする。

`.html` を併用する場合だけ、このスキルの `assets/sheet-template.html` をコピーして中身を差し替える。
ブリッジが読むのはこの 3 点なので**構造は変えない**（`.json` だけで起票するときは不要）:

- `#akForm` … 設問フォームのルート
- `#out` … 回答テキストの出力先（`textarea`）
- `#genBtn` … 回答テキストを組み立てるボタン（アプリ内では「回答を送信」に化ける）

HTML を書くときの設問のマークアップ（ブリッジの注入スクリプトが `#akForm .q h3` を装飾する）:

```html
<section class="q" data-q="q1">
  <h3>Q1. 帯の形は、流す・静止・今のまま、どれにするか</h3>
  <label data-opt="A"><input type="radio" name="q1" value="A"> A. 流れるティッカー <span class="rec">推奨</span>
    <span class="d">利点: 件名が長くても最後まで読める / 代償: 動く文字を追い続ける負担</span></label>
  <label data-opt="B"><input type="radio" name="q1" value="B"> B. 静止 1 行
    <span class="d">利点: 疲れない / 代償: 2 件目以降は省略</span></label>
  <textarea name="note-q1" placeholder="補足（任意）"></textarea>
</section>
```

> 旧手順（`.html` を主・`mode=sheet`）は**レガシー／カスタム HTML 拡張**として残る。
> どちらの `mode` でも、`.json` さえあれば PWA は `<StandardForm>` で回答でき、
> `.html` が無ければブリッジが `.json` から安全な HTML を動的生成する。

### 4. カンバンに起票して `blocked` にする

本文の**機械可読行**（この 1 行がブリッジの唯一の手掛かり）:

```text
[review] label=<label> round=<round> mode=standard sheet=sheets/<label>-<round>.json target=<repo_path> chat=<session_id>
```

```bash
hermes kanban create "Q1〜Q3: <表題>" --body "$(cat <<'BODY'
<人向けの要約。何が決まれば進めるか、いま何が止まっているか>

[review] label=cockpit-03 round=1 mode=standard sheet=sheets/cockpit-03-1.json target=~/Projects/your-repo chat=<session_id>
BODY
)" --assignee <profile>

hermes kanban block <task_id> "レビュー待ち（Q1〜Q3）" --kind needs_input
```

- `target=` は `~` 展開後の絶対パスでも `~/...` でもよい（ブリッジが実パスに直す）
- `chat=<session_id>` を書くと、完了報告がその会話に戻る（書かないとフィードだけ）
- **`assignee` を必ず付ける**（無いと dispatcher が拾わない）
- 起票後は**待つ**。回答が来るまで別のタスクを進める（自分で回答を捏造しない）

### 5. 回答を受けて反映する

回答は次のどちらかで届く:

1. PWA のレビュー画面 → `POST /api/review/<task_id>/answer`
   → `review/sheets/<label>-<round>.answer.json` と `.answer.txt` が書かれ、タスクが `comment` + `unblock` される
2. タスクのコメントに貼られた回答テキスト（`【レビュー回答】` 形式）

`.answer.txt`（またはコメント）を読み、**選ばれた選択肢どおりに実装**する。
`(未選択 = お任せ)` は推奨案で確定してよい。`全体へのコメント:` の指示は最優先。

反映したら `hermes kanban comment <task_id> "反映: <何をどう変えたか>"` を残して完了へ進む。
反映が回答と違うと判断したら `POST /api/review/<task_id>/reopen`（`request-changes`）で再質問する。

## 回答フォーマット（壊さない）

シートが生成するテキストはこの形。ブリッジの `parseReplyText` は
`【レビュー回答】` と `全体へのコメント:` を読み、旧 `【赤ペン回答】` / `全体への赤ペン:` も受理する。

```text
【レビュー回答】cockpit-03
Q1. 帯の形は、流す・静止・今のまま、どれにするか: A — 流れるティッカー / 補足: 3 件までなら可
Q2. 既存バーは置き換えるか: (未選択 = お任せ)
全体へのコメント: 色は現行のまま
---
上の回答を反映して作業を続けてください。お任せの項目は推奨案で確定してください。
```

## 落とし穴

- **`sheet=` のパスは `review/` からの相対**（`sheets/x-1.json`）。`..`・絶対パスは拒否される
- 機械可読行は **`mode=standard sheet=sheets/<label>-<round>.json`** を第一推奨にする
  （`.html` を併用したときだけ `mode=sheet sheet=sheets/x-1.html`）。`image=` に `.html` を書いても
  `sheet` として救済されるが、`sheet=` を正しく書く
- **見た目の比較が論点でないときに `.html` を手書きしたり `browser_exec` で撮ったりしない**。
  JSON 1 枚で足りる論点に絵を付けると、シート 1 枚に数分かかり回答も遅れる
- 同じ回答の再送は冪等（`.answer.json` の `sha256` で判定）。二重に `comment` は付かない
- 回答は **`blocked` のときだけ**受け付ける。`ready` / `running` / `done` に送ると 409 `NOT_WAITING`
- 2 ラウンド目は `round=2` で**新しいファイル**（`<label>-2.json` / `.html`）を作る（1 を上書きしない）
