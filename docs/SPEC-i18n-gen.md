# SPEC: 英語モードの生成物（シート HTML・注釈文・パイプラインのプロンプト）(`i18n-gen`)

- **Status**: archived
- **アーカイブ日**: 2026-11-21（COH-4・全バッチ完了済み。以後は参照用に保持し、新規起票の対象外）

対象: `~/Projects/hermes-mobile-pwa`（PWA `apps/web` ＋ ブリッジ `apps/bridge` ＋ 同梱 skills）
決定: 赤ペンシート `spec-quick-review-annotation-html` round 1（回答 `sheets/spec-quick-review-annotation-html-1.answer.json`・**Q1〜Q4 すべて A**）
前提仕様: `docs/SPEC-i18n-resp.md`（Q1=B で「長文生成物（パイプライン報告・シート HTML・CLI 出力）」として延期した部分がこの SPEC）

---

## 1. コンセプト

画面の辞書はもう揃っている（`apps/web/src/i18n/en.json` / `ja.json` = 各 1074 キー、`ReviewPane.jsx` の `t()` 123 箇所）。
ところが**ブリッジが生成する文**（シート HTML・回答テキスト・カンバンに残す 1 行）と**プロンプト／スキル**は日本語固定なので、
英語に切り替えても「アプリは英語、シートと指示と回答文は日本語」になる。

この SPEC は**生成側だけ**を実行時言語に追従させる。出力の言語は 1 か所（`apps/bridge/src/lang.js` の `resolveLang()`）で決め、
**機械トークン**（`label=` / `sheet=` / `mode=` / `round=` / `target=` / タスク id / パス / `**Execution Mode**`）は ASCII のまま動かさない。
人が読む散文（シートの title・topic・設問・選択肢、SPEC 本文、投稿するコメントと summary）だけが言語に従う。

**対象外（この SPEC では触らない）**: 画面辞書（既に parity）、`pipeline-watcher.js` / `pipelineOptimizer` の長文レポート（別 SPEC の種に残す・§6）、
プロファイル側の `SOUL.md` / メモリ（Q2=C を採らなかったため。リポジトリの外は触らない）。

---

## 2. 合意決定表（インタビュー結果）

| # | 論点 | 決定内容 | 根拠・背景 |
|---|---|---|---|
| **D1** | 生成文の言語をどこから取るか | **リクエスト単位**: PWA が `/sheet` `/view` に `?lang=` を付け、サーバは既存の `langOf()`（`server.js:314` → `lang.js`）で解決して `review.*` に渡す | トグルに即追従・再起動不要・端末ごとに別言語が可能。ヘルパは実装済みで `bridge/test/lang.test.js` がある。ブリッジ設定に固定すると「アプリは en・ブリッジは ja」の不一致が起きる（B の代償）。`hm.lang` の明示選択が OS のヘッダに負ける C も却下 |
| **D2** | 「この言語で書け」の規則をどこに置くか | **両層**: リポジトリの 3 スキルに規範節（`## Language`）＋ ブリッジが組むプロンプトに同じ規則 | スキルはエージェントが作業中に読み直すもの、プロンプトは最初に読むもの。片方だけだと日本語の散文に引き戻される（このカードの実測がそれ）。規則文は**1 つの定数**にして guard test で 3 スキルと突き合わせる |
| **D3** | en のとき SPEC 見出しとタスク本文の見出しは | **en のとき英語で書く**（`**Execution Mode**` / `**Objective**` / `**Files**` / `**Verify**`、`## Objective` / `## Excerpt (acceptance criteria + Verify)`）。**パーサは両言語のまま** | 読み取り側は既に両対応（`specs.js:49` `目的|Objective`、`:56` `Execution Mode|実行モード`）ので書き手だけの仕事。en の SPEC が英語本文に日本語見出しを被せている状態が報告の元 |
| **D4** | カンバンに残す運用 1 行（回答サマリ・unblock 理由・注釈サマリ・注釈カードの title・block 理由・回答文の末尾） | **実行時言語で出す**。あわせて `toReplyText` の既定を `ja` → `en` に倒す（`review.js:186`） | worker はこの 1 行を入力として読む。en ランで日本語の指示行が末尾に付くのは往復の残り半分。回答パーサは既に `[Review Answer]` / `Overall Note:` を受ける（`:31`, `:146`）ので往復は安全。履歴が混在するので**両表記を受ける**ことをテストで固定する |

---

## 3. 詳細技術仕様

### 3.1 言語の決定点は 1 か所（共通・全バッチの前提）

- 新規の言語判定を書かない。`apps/bridge/src/lang.js` の `resolveLang()`（`?lang=` → `Accept-Language` → 既定 `en`）と
  `apps/bridge/src/server.js:314` の `langOf(req, url)` だけを使う。既定は `en`（`lang.js:10`）。
- **読み取り系**: `/api/review/:id/sheet`（`server.js:1048`）と `/api/review/:id/view`（`:1066`）は
  `const lang = langOf(req, url)` を解決し、`review.sheetHtml(id, lang)` / `review.reviewViewHtml(id, lang)` に渡す。
- **書き込み系**: `/answer` / `/annotation` / `/approve` も同じく `langOf(req, url)` を 1 回だけ解決し、
  `review.answer(id, payload, lang)` / `saveAnnotation(id, payload, lang)` / `approve(id, payload, lang)` に渡す。
  PWA の `api()` は既に `accept-language: getLang()` を送る（`apps/web/src/api.js:47`）ので、**書き込み系にクライアント変更は要らない**
  （`?lang=` もテスト用に受ける）。
- **PWA 側で変えるのは 2 URL だけ**: `apps/web/src/features/ReviewPane.jsx:415`（iframe の `src`）と `:460`（`/view` のリンク）。
  `apps/web/src/api.js` に `export function withLang(path)` を足し（`getLang()` を `encodeURIComponent` して `?lang=` を付ける）、
  この 2 か所で使う。iframe はブラウザが直接 GET するので、`api()` のヘッダは付かない＝クエリが要る。
- `lang` 引数の既定値はすべて `'en'`（`DEFAULT_LANG` と一致）。既定を `'ja'` に戻さないことをテストで固定する（§3.6）。

### 3.2 生成 HTML の文言表（GEN-1）

`apps/bridge/src/review.js` にモジュールレベルの表を置き、テンプレートから日本語を直書きで消す。

```js
/** 生成 HTML の文言（`lang` ごと。キー集合は両言語で同一）。 */
const HTML_TEXT = {
  en: { recBadge: 'Recommended', note: '…', empty: 'No questions.', viewTitle: 'Review sheet', … },
  ja: { recBadge: '推奨',         note: '…', empty: '設問がありません。', viewTitle: 'レビューシート', … },
}
export function htmlText(lang) { return lang === 'ja' ? HTML_TEXT.ja : HTML_TEXT.en }
```

置換対象（現状の直書き箇所）:

1. `renderSheetHtmlFromData(data, ak = {}, lang = 'en')`
   - `<html lang="ja">`（`:291`）→ `<html lang="${lang}">`
   - `推奨` バッジ（`:265`）→ `htmlText(lang).recBadge`
   - 自動生成ビューの注記（`:334`）／空状態 `設問がありません。`（`:336`）
   - 字体スタックの `"Hiragino Sans","Noto Sans JP"` は**そのまま**（見た目の問題であって文言ではない）
2. `reviewViewHtml(taskId, lang = 'en')`
   - `<html lang="ja">`（`:410`）／`<title>レビューシート …`（`:414`）／iframe の `title="レビューシート"`（`:425`）
   - ステータス文言（`:451`, `:461`, `:463`, `:468`）と `:453` の「回答を送信しました（タスクは …）」
3. `injectReviewBridge(html, taskId, lang = 'en')`
   - 「回答を送信」「選んで［回答を送信］を押すと…」`relabel()`、「アプリに回答を送りました（この画面は閉じてOK）」
     「この画面からは直接送信できません。…」（`:530` 付近の `report(...)` 3 か所）

設問・選択肢・`topic`・`title` は**データそのまま**（訳さない）。手書き `.html` シートは従来どおり中身をそのまま返す（生成しない）。

### 3.3 回答テキストと運用 1 行（GEN-2）

`toReplyText(label, answers, global, questions, lang = 'en')` の EN 形を確定する。

```text
[Review Answer] <label>
Q1. <question>: <choice> / note: <note>
Q2. <question>: (unselected = take recommended)
Overall Note: <global>
---
Apply the answers above and continue. Items left unselected are settled by the recommended option.
```

- 現状 `:192` の `(未選択 = お任せ)` と `:193` の `補足:` は `en` でも日本語のまま（`en` 分岐は見出しだけ）。ここを分岐する。
- 末尾の指示行（`:198`）も分岐する。`:196` / `:189` は既に分岐済み。
- **読む側も両対応にする**: `review.js:146` `parseReplyText` の note 見出し（`補足:`）と未選択判定（`(未選択`）に EN を足す。
  `apps/web/src/lib/reviewPaste.js`（貼り付けフォールバック）も同様にし、`PASTE_NOTE_MARK` / `PASTE_UNSELECTED` を配列化する。
  このファイル冒頭の「ここだけは日本語のままにしてある」というコメントは**事実でなくなるので書き換える**（`noHardcodedJapanese.test.js` の除外根拠も同じコメントにある）。
- **運用 1 行**（`lang` を受けて分岐。機械トークンと `--author` はそのまま）:
  - 回答サマリ `:1025`（`レビュー回答: N問 (選択 x / お任せ y)` → `Review answers: N (chosen x / defaulted y)`）
  - unblock 理由 `:983` / `:1032`（回答受領・再送）、`:1278` / `:1310`（注釈受領・再送）
  - 注釈サマリ `:1305`（`注釈: N ストローク / メモ:` → `Annotation: N strokes / note:`）
  - 注釈カードの title `:1644`（`注釈（画像から作成）`）と block 理由 `:1702`（`注釈待ち（画像から作成）`）
  - `approve` の `approved_by` などの記録フィールドは機械語なので触らない
- 履歴は混在する。監視役は今のところ `[review]` / `[akapen]` のマーカーしか見ていない（`review-watcher.js:161`、
  `pipeline-watcher.js:108`）ので**変更不要**。逆に「`注釈:` や `レビュー回答` の前方一致で状態を判定するコードを新設しない**こと**をテストで固定する（§3.6）。

### 3.4 プロンプトとスキルの言語規則（GEN-3）

1. 新規 `apps/bridge/src/language-rule.js`:

```js
/** 機械検査の基準文（スキルとプロンプトが同じ 1 文を持つ）。 */
export const LANGUAGE_RULE_MARKER = "Write user-facing prose in the run's UI language"
export const LANGUAGE_RULE_EN =
  `${LANGUAGE_RULE_MARKER} — sheet title/topic/question/option text, SPEC prose, the comments and summaries you post. ` +
  'Keep machine tokens ASCII and unchanged: `label=`, `sheet=`, `mode=`, `round=`, `target=`, task ids, file paths, ' +
  'and the SPEC keys **Execution Mode** / **Objective** / **Files** / **Verify**.'
export const LANGUAGE_RULE_JA = '<同じ内容の日本語（機械トークンは ASCII のまま）>'
export function languageRule(lang) { return lang === 'ja' ? LANGUAGE_RULE_JA : LANGUAGE_RULE_EN }
```

2. `apps/bridge/src/architect.js` の 2 つのプロンプトビルダーで `languageRule(lang)` を本文に差し込む。
   - `:448` の `UI language: ${lang}` の**次の行**に規則を置く（現状は言語を伝えるだけで「その言語で書け」が無い）。
   - `:330`（もう一方のビルダー）と `:471-473`（Round 2 の必須キー `**目的**` / `**変更・新規ファイル**` / `**受入条件（Verify）**`）を
     **en のとき `**Execution Mode**` / `**Objective**` / `**Files**` / `**Verify**`** に切り替える（D3）。
3. 3 スキルの冒頭（`## いつ使うか` の直前）に `## Language` 節を足し、**`LANGUAGE_RULE_MARKER` をそのまま 1 行含める**。
   - `skills/quick-review/SKILL.md`（200 行）／`skills/annotation/SKILL.md`（138 行）／`skills/spec-architect/SKILL.md`（226 行）
   - 節の本文は英語 5 行でよい（この節は「出力言語の規則」であって、日本語で書かれた手順書の一部ではない）。
     「この 1 文は `apps/bridge/src/language-rule.js` と同一で、guard test が突き合わせる」と 1 行添える。
4. `createFromImage`（`review.js:1644`）のカード本文は機械行（`[review] label=… mode=annotation image=… target=…`）だけなので規則を入れない。
   注釈の散文規則はスキル側（annotation）が持つ。

### 3.5 SPEC 見出しと worker タスク本文（GEN-4）

- `apps/bridge/src/specs.js:362` `buildTaskBody({ specRelPath, repoPath, board, batch, chat, lang })`:
  - `## 目的`（`:373`）→ en は `## Objective`、ja は現行のまま
  - `## 抜粋（受入条件 / Verify を含む）`（`:377`）→ en は `## Excerpt (acceptance criteria + Verify)`
  - `batch?.objective` が空のときの代替文（`:375`）も同じ言語に合わせる
- `launchSpec(input)`（`specs.js:685`）に `lang` を受け、`:741` の `buildTaskBody` に渡す。未指定は `'en'`（`DEFAULT_LANG`）。
- `server.js:651`（`POST /api/specs/launch`）で `lang: langOf(req, url)` を渡す（クライアント変更なし・`api()` の `accept-language` で足りる）。
- パーサは**両言語のまま**（`OBJECTIVE_RE` `specs.js:49` / `EXECUTION_MODE_RE` `:56` は既に両対応。
  `**Files**` / `**Verify**` はパーサが読んでいない＝見出し改名は本文の見た目だけに効く）。既存の ja SPEC からは ja のまま起票される（ヘッダで ja が返る）。

### 3.6 再発防止（GEN-5）

1. 新規 `apps/bridge/test/reviewI18n.test.js`:
   - **en 出力に CJK が 0 文字**（fixture は ASCII のみの `sheet.json`）:
     `renderSheetHtmlFromData(fixture, ak, 'en')` / `reviewViewHtml(id, 'en')` / `injectReviewBridge('<html></html>', id, 'en')` /
     `toReplyText(label, answers, '', questions, 'en')` / `buildTaskBody({…, lang: 'en'})`。日本語の直書きが 1 つ残ると落ちる。
   - **ja 出力は既知の JA ラベルを含む**（`推奨` / `設問がありません。` / `注釈` 等）。片側だけのテストにしない。
   - `HTML_TEXT` のキー集合が ja / en で一致（訳抜け検出）。
   - 既定引数の逆戻り防止: `review.js` のソースに `lang = 'ja'` が無い（`DEFAULT_LANG` は en）。
2. 新規 `apps/bridge/test/languageRule.test.js`:
   - 3 スキルすべてが `LANGUAGE_RULE_MARKER` を含む／`LANGUAGE_RULE_EN` が marker を含む（同一文の証明）。
   - `architect.js` と `specs.js` が `languageRule(` を使っている（`grep` ベースの静的検査）。
3. **静的検査の拡張**（既存に追記）: `apps/web/test/i18nLeak.test.js` の冒頭コメントは「シート HTML・spec の生成文は Q1=C で対象外」と
   書いている。対象は変わらないが**理由が変わる**（生成文は言語表を通るようになった）のでコメントを更新する。
   加えて「`注釈:` / `レビュー回答` を前方一致の状態判定に使っていない」を 1 本の静的テストで固定する。
4. `docs/OPERATIONS.md` に 3 行: 出力言語の決定点は `apps/bridge/src/lang.js`／`?lang=` → `Accept-Language` → `en`／機械トークンは ASCII 固定。

---

## 4. カンバンタスク分割（Batch GEN-1 〜 GEN-5）

直列（1→2→…→5）。理由: GEN-1 と GEN-2 が同じ `apps/bridge/src/review.js`、GEN-3 と GEN-4 が同じ `architect.js` を触る。
並走すると同じチェックアウトで衝突する（`SPEC-i18n-resp` §5 の実測と同じ）。各バッチは**自分の担当ファイルだけ `git add`** する。

### Batch GEN-1: 生成 HTML を ?lang= に追従させる

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: シート HTML・単体タブのラッパー・アプリ内ブリッジの注入スクリプトの文言を `lang` で切り替え、`?lang=` を配線する（§3.2 と §3.1 の読み取り系）。
- **変更・新規ファイル**:
  - 変更: `apps/bridge/src/review.js`（`HTML_TEXT` / `htmlText()` / `renderSheetHtmlFromData` / `reviewViewHtml` / `injectReviewBridge` / `sheetHtml(id, lang)`）
  - 変更: `apps/bridge/src/server.js`（`/sheet` `:1048` と `/view` `:1066` で `langOf(req, url)` → 引数）
  - 変更: `apps/web/src/api.js`（`withLang(path)` を export）
  - 変更: `apps/web/src/features/ReviewPane.jsx`（`:415` の iframe `src`、`:460` の `/view` リンク）
  - 変更: `apps/bridge/test/review.test.js`（en / ja の HTML 出力を固定）
- **受入条件（Verify）**:
  - `renderSheetHtmlFromData(fixture, ak, 'en')` が `<html lang="en">` と `Recommended` を含み、`<html lang="ja">` と `推奨` を含まない（ja はその逆）。
  - `reviewViewHtml(id, 'en')` の `<title>` が英語・`<html lang="en">`。`injectReviewBridge(html, id, 'en')` に CJK が無い。
  - `apps/bridge/test/review.test.js` と `npm test` が全件パス。
  - ブリッジ再起動後の実機 receipt（報告に貼る）: `curl -s "…/api/review/<id>/sheet?lang=en" | rg -o '<html lang="[a-z]+"|Recommended'` → `lang="en"` / `Recommended`（`?lang=ja` は `lang="ja"` / `推奨`）。

### Batch GEN-2: 回答テキストとカンバンの運用 1 行を言語に合わせる

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: `toReplyText` の EN 形（§3.3）を完成させ、既定を `en` に倒し、回答・注釈のサマリ／unblock 理由／カード title を実行時言語で出す。読み取り側（`parseReplyText` と PWA の貼り付けパーサ）は両表記を受ける。
- **変更・新規ファイル**:
  - 変更: `apps/bridge/src/review.js`（`:186` 既定 `en`／`:192`・`:193`・`:198` の分岐／`:983`・`:1025`・`:1032`・`:1278`・`:1305`・`:1310`・`:1644`・`:1702`／`parseReplyText` の EN 受理）
  - 変更: `apps/bridge/src/server.js`（`/answer` `/annotation` `/approve` で `langOf` → `review.*(…, lang)`）
  - 変更: `apps/web/src/lib/reviewPaste.js`（`補足:` / `全体へのレビュー:` / `(未選択` に加えて `note:` / `Overall Note:` / `(unselected` を受理。冒頭コメントを事実に合わせる）
  - 変更: `apps/bridge/test/review.test.js`（`toReplyText(...,'en')` → `parseReplyText` の往復）、`apps/web/test/review-view.test.js` または新規 `apps/web/test/reviewPaste.test.js`
- **受入条件（Verify）**:
  - `toReplyText(label, answers, '', questions, 'en')` に CJK が 1 文字も無く、`parseReplyText` が同じ answers / global に戻す（往復テスト）。
  - ja 形は従来どおり `【レビュー回答】` / `補足:` / `(未選択 = お任せ)` を出し、往復が壊れない。
  - `en` の回答で呼ばれる `runKanban(['comment', …])` の引数が英語サマリであること（`opts.runKanban` を差し替えたテストで観測）。
  - `npm test` が全件パス。

### Batch GEN-3: 言語規則をスキルとプロンプトの両方に置く

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: `apps/bridge/src/language-rule.js` を新設し、`architect.js` のプロンプトに規則を差し込み、3 スキルに同じ 1 文を置く（§3.4）。
- **変更・新規ファイル**:
  - 新規: `apps/bridge/src/language-rule.js`
  - 変更: `apps/bridge/src/architect.js`（`:448` の直後・`:330` 周辺・`:471-473` の見出しを en/ja で分岐）
  - 変更: `skills/quick-review/SKILL.md`, `skills/annotation/SKILL.md`, `skills/spec-architect/SKILL.md`（`## Language` 節）
- **受入条件（Verify）**:
  - `languageRule('en')` が `LANGUAGE_RULE_MARKER` を含み、`languageRule('ja')` は日本語で機械トークンの一覧を保つ。
  - `architect.js` が組む seed プロンプト（`lang='en'`）が marker を含み、`lang='ja'` では JA 規則文を含む（ビルダーを直接呼ぶテスト）。
  - 3 スキルすべてに marker が入っている（`languageRule.test.js`）。
  - `npm test` が全件パス。

### Batch GEN-4: SPEC 見出しと worker タスク本文を en で書く

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: `buildTaskBody` と SPEC 生成プロンプトの見出しを言語で切り替え、パーサが両言語を受けることをテストで固定する（§3.5）。
- **変更・新規ファイル**:
  - 変更: `apps/bridge/src/specs.js`（`buildTaskBody`:362 に `lang`／`:373`・`:375`・`:377`／`launchSpec`:685 と `:741`）
  - 変更: `apps/bridge/src/server.js`（`/api/specs/launch`:651 で `lang: langOf(req, url)`）
  - 変更: `apps/bridge/test/specs.test.js`
- **受入条件（Verify）**:
  - `buildTaskBody({…, lang: 'en'})` が `## Objective` / `## Excerpt (acceptance criteria + Verify)` を含み `## 目的` を含まない。`lang: 'ja'` はその逆。
  - 4 変種のパースが通る: `- **目的**:` / `- **Objective**:` / `- **Execution Mode**: [Mode: Zero-Stop]` / `- **実行モード**: [Mode: Zero-Stop]`。
  - 既存 SPEC（`docs/SPEC-i18n-resp.md`）を ja で起票した本文に `## 目的` が残る（後方互換）。
  - `npm test` が全件パス。

### Batch GEN-5: 再発防止テストと運用メモ

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: §3.6 の guard を実装し、生成物の言語切替・規則の同一性・既定値の逆戻りを機械で固定する。
- **変更・新規ファイル**:
  - 新規: `apps/bridge/test/reviewI18n.test.js`, `apps/bridge/test/languageRule.test.js`
  - 変更: `apps/web/test/i18nLeak.test.js`（冒頭コメントの更新＋「`注釈:` / `レビュー回答` を状態判定に使っていない」検査）
  - 変更: `docs/OPERATIONS.md`（言語の決定点 3 行）
- **受入条件（Verify）**:
  - `reviewI18n.test.js`: en の 5 生成物すべてで CJK 0 文字／ja は既知ラベルを含む／`HTML_TEXT` のキー集合が一致／`review.js` に `lang = 'ja'` が無い。
  - `languageRule.test.js`: 3 スキル × marker、`architect.js` と `specs.js` が `languageRule(` を使用。
  - `npm run verify` が exit 0（`npm test` ＋ `check:dashboard` ＋ `check:pwa` ＋ `check:oauth` ＋ `build` ＋ `audit:responsive`）。

---

## 5. 検証（共通）

- `npm run verify` が緑（`package.json` の `verify` = `npm test && check:dashboard && check:pwa && check:oauth && build && audit:responsive`）。
- ベースライン: この SPEC を書いた時点の `HEAD` は `b47cd16`（`fix(i18n): 英語設定のスニペット指示文から日本語の見出しを除去`）。バッチごとに自分の差分だけを stage する。
- 実画面（見た目が変わる GEN-1・GEN-2）は **390×844 で en のシートを 1 枚**撮り、`shots/` に置く（before は人の赤があるので不要）。
- 実機 receipt（報告に貼る）: ブリッジ再起動 → `?lang=en` / `?lang=ja` の `/sheet` を curl して `<html lang>` とバッジ語を比較。

## 6. この SPEC の外（次の種）

- `apps/bridge/src/pipeline-watcher.js`（16 箇所）と `pipelineOptimizer` の**長文レポート**は日本語のまま。生成物が長く、worker が読む入力でもないので別 SPEC。
- `term-snippets.js` / `snippets.js` の同梱定型文（端末に打ち込む文面）は**両言語を持っている**ので変更不要。
- 画面辞書（`en.json` / `ja.json`）は parity 済み（1074 キー）で対象外。
