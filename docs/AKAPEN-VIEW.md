# 赤ペンタブの表示仕様（確定: akapen-view-01）

赤ペン（`~/Projects/akapen` のシート）で決めた初期仕様。実装は
`apps/web/src/features/AkapenPane.jsx` と `apps/web/src/lib/akapenView.js`、
サーバ側は `apps/bridge/src/akapen.js`。

- シート: `~/Projects/akapen/sheets/akapen-view-01-1.html`
- 回答: `~/Projects/akapen/sheets/akapen-view-01-1.answer.json`（q1=A / q2=B / q3=A）
- カンバン: board `mobile` の `t_db19d4b4`

## 決まったこと

| # | 論点 | 決定 | 実装 |
|---|---|---|---|
| 1 | 一覧の既定表示 | **判断待ちだけ** | `AkapenPane.jsx` の `TABS` 既定 `waiting`、`groupItems()` |
| 2 | 送信後の挙動 | **留まって次の判断待ちへ** | `handleSubmitted()` + `nextWaiting()` |
| 3 | 完了シートの扱い | **最新 8 件に畳む** | `groupItems()` の `done` / `doneTotal`、`doneHint()` |

### 1. 既定は「判断待ち」だけ

`判断待ち / 進行中 / 完了` の 3 チップで切り替える。既定タブは `waiting`。
チップの数字は実件数（`done` はタブ内見出しに `直近 N 件` とだけ出す）。

- 「判断待ち」= `status === 'blocked'` かつ本文に `[akapen]` ラベルがある（`isWaiting()`）。
  `ready` / `running` は赤ペンを送れないので `進行中` に入る。
- タブは `role="tablist"` / `aria-selected` 付き。総件数 0 のときは空状態の文言を出す。
- 既定を絞った理由: 一覧 API は 5 状態を `LIMIT 80` で返すため、畳まないと
  「いま自分が判断すべき 1 件」が進行中・完了に埋もれる。

### 2. 送信後は閉じず、次の判断待ちを開く

送信 → `POST /api/akapen/:id/answer` → 一覧を再取得 → `nextWaiting(items, answeredId)`
で次の 1 件をそのまま開く。**残りが無いときだけ**シートを閉じ、トーストで結果を出す。
回答済み ID は必ず除外する（`blocked` のままだと自分自身を再度開いてしまうため）。

- 旧実装は送信後 600 ms で無条件に閉じていた。
- 送信の可否は `answer()` が `blocked` 以外を **409 `NOT_WAITING`** で拒否する
  （`akapen.js` の `answer()`）。二重送信で `answer.json` を上書きしたり
  comment が二重に付くのを防ぐ。UI 側は `isWaiting()` で先に弾き、
  進行中・完了は `ReadOnlyDetail`（フォーム無し）を出す。

### 3. 完了は「最新 8 件」に畳む

`groupItems()` が `done` を `created_at` 降順の先頭 8 件に切り、
`doneTotal` に全件数を残す。見出しは `直近 8 件`（件数を偽らない）。

- 旧実装は `<details>` で畳んでいたが、タブに統合した（判断待ちを見る既定画面から
  完了を消すほうが効くため）。「畳む」という決定自体は変えていない。

### 4. 判断待ちは**閉じられる**（2026-11-12 追加）

放置された判断待ちが一覧から消えない問題への対処。赤ペン待ち（`blocked`）のシートと
注釈エディタの末尾に `CloseActions`（`apps/web/src/components/CloseActions.jsx`）を出す。

| 操作 | 実体 | 一覧 | 履歴 |
|---|---|---|---|
| 完了にする | `hermes kanban complete <id> --result <理由>` | 判断待ち→完了タブ | result に理由が残る |
| 取消（アーカイブ） | `hermes kanban comment` ＋ `hermes kanban archive <id>` | どのタブにも出ない | コメントとタスク行は DB に残る |

- 破壊的寄りなので**開く→長押し1.5秒**の 2 段階（`HoldButton`）。誤タップで閉じない
- 連打は bridge 側が **noop** で吸収する（既に done/archived なら CLI を呼ばない）
- 取り消し線の案（`promote` で戻す）は採らない: 判断待ちに戻すとまた一覧に居座るため

### 5. 詳細シートへの導線は**ドロワーの先頭**（2026-11-13 追加: 実測）

判断待ちのドロワーはネイティブの設問フォームが主なので、シートの全体像（前提・挿絵・
前回の回答）は見えない。リンクをフォームの末尾に置いていたため、設問が増えると
スクロールの下に隠れ、**導線が無いように読めた**（実測: `repo-picker-01-1` の 4 問で
`.sheet-body` は scrollHeight 3028px / clientHeight 636px、末尾リンクの offsetTop は 2767px）。

- `SheetLink`（`apps/web/src/features/AkapenPane.jsx`）を**ドロワー本文の先頭**に置き、
  判断待ち・進行中・完了のどれでも同じ位置に出す（同じ操作は同じ場所）
- フォーム末尾の重複リンクは削除（1 ドロワー 1 本）。注釈エディタは対象外（シート自体を描く）
- 見た目は `.ak-sheetlink`（`--accent` の細いピル）。開いた瞬間に設問カードより先に目に入る


## 進行状況の 1 行

行ごとに `progressText()` を出す。`running` は `開始 X / 心拍 Y`、赤ペン待ちは
`提示 Z`。値は bridge の `list()` が `task_events` の最新 1 件と `last_heartbeat_at`
から詰める（`akapen.js` の `lastEvents()`）。

### 判断待ちの件数を下部ナビの丸バッジに出す（2026-11-12 追加: 注釈 1377.jpg）

「赤ペン」タブのアイコン右上に**小さい丸（`--warn` 地・濃色数字）**を出し、判断待ちの件数を見せる。
注釈（`1377.jpg` の赤ペン）の指示どおり **タブ内の表示（「N 件の判断待ち」・チップの数字）は変えない**。

- 出す場所はナビだけ。`0` のときはバッジ自体を出さない（0 の丸は「何かある」と誤読させる）。
- 件数の出所は `waitingCount(items)`（`lib/akapenView.js`）＝ `groupItems()` の `waiting` と同じ定義。
  `App.jsx` が `/api/akapen` を 15 秒ごとに引き、`AkapenPane` が一覧を取り直したときは
  `hm:akapen-items` イベントで同じ items を流して即同期する（回答直後に 15 秒待たない）。
- 取得に失敗しても前の値を保つ（バッジは補助情報なので画面を壊さない）。
- スクリーンリーダー向けには `aria-label="赤ペン（判断待ち 1 件）"` をボタンに付け、丸自体は
  `aria-hidden`（数字の二重読みを避ける）。CSS は `.nav-icon` / `.nav-badge`。

#### タスクタブ側（承認待ち）も同じ丸にする（2026-11-12 追加）

依頼は「承認待ちがあるときはタスクタブに、赤ペン判断待ちがあるときは赤ペンタブに」だったので、
同じ部品をタスクタブにも当てる。**「ティッカー」= 下部ナビの丸バッジ**であって、タブ内に流れる帯の
ことではない（注釈 1377.jpg のメモで確定）。

- 件数は `pendingCount(items)`（`lib/akapenView.js`）＝ `/api/inbox` の items 件数。
  タスクタブ内の「承認待ち N 件」バーと同じ数え方。
- `TasksPane` が `/api/inbox` を取り直したら `hm:inbox-items` で同じ items を流し、`App.jsx` が
  15 秒待たずに同期する（赤ペン側の `hm:akapen-items` と対）。
- **2 つの数字は必ず別々**にする。`/api/inbox` は本文に `[akapen]` を持つ blocked を除く
  （`inbox.js` の `boardItems`）ので、承認待ちに赤ペン待ちは混ざらない。除かないと、赤ペンの
  シート待ちが立っている間だけ承認待ちが水増しされる（実測: 1 件 → 3 件）。
- バッジの色は両方 `--warn`、`aria-label` だけ「承認待ち N 件」/「判断待ち N 件」で言い分ける。

## 状態ラベル

`review` = `レビュー中`（旧: `赤ペン待ち`）。赤ペン待ちは `blocked` + ラベルなので、
`review` に「赤ペン待ち」を残すと 2 種類の待ちが同じ名前になる。
`ready` = 反映待ち / `running` = 生成中 / `done` = 完了。

## 検証

```bash
cd ~/Projects/hermes-mobile-pwa
npm test          # node --test apps/bridge/test/*.test.js apps/web/test/*.test.js
```

- `apps/web/test/akapen-view.test.js` — グループ分け・`nextWaiting`・`doneHint`
- `apps/bridge/test/akapen.test.js` — `answer()` の `NOT_WAITING` と一覧の `progress`

## 未決（次の赤ペン候補）

- 完了タブの「もっと見る」（8 件超の閲覧手段。現状は API の `LIMIT 80` までしか辿れない）
- 送信後の自動再取得間隔（現状 15 秒ポーリング。送信直後は明示 `load()`）

## 判断待ち 0 件の空状態（2026-11-12 追加: akapen-empty-01）

赤ペン（`~/Projects/akapen/sheets/akapen-empty-01-1.html`、回答は q1=A / q2=A / q3=A）で
決めた 3 点。実装は `AkapenPane.jsx` の判断待ちタブの分岐（`groups.waiting.length` が 0 のとき）。

| # | 論点 | 決定 | 中身 |
|---|---|---|---|
| 1 | 枠の有無 | **枠付きカード** | `.ak-empty-card`（`--surface` 面 + 枠 + 12px 丸め） |
| 2 | 導線の形 | **塗りのボタン** | `.ak-empty-btn`（44px、`setShowNew(true)` = ヘッダの「＋ 注釈」と同じ） |
| 3 | 件数行 | **残す** | `.ak-empty-meta` に `進行中 n 件 ・ 完了 n 件` |

- 文言は「次の仕様はチャットから投げてください。」＋注記「ライブラリの画像に赤を入れて送ることもできます」。
- **総件数 0 件**（`!hasItems`）のときは従来の `.empty` のまま。移行直後に「チャットから投げて」だけ出ると
  カンバンの存在が伝わらないため、2 つの空状態は分けて持つ。
- 空状態のボタンは `NewAnnotationSheet` を開くだけ。タスクを作るかは利用者が選ぶ。

## 挿絵の拡大（同日追加: 赤ペン回答の全体メモ）

回答フォームの挿絵は `.ak-opt-thumb`（高さ 72px 固定）だと案の違いが読めない、という指摘への対応。

- 挿絵を `.ak-thumb-btn`（`role="button"`）で包み、タップ / Enter で `createPortal` の
  `.ak-zoom`（`position: fixed`、`z-index: 90`）に原寸表示する。`stopPropagation` で
  **選択は切り替えない**（選択は行全体のタップ）。
- 幅の制約は `.ak-opt-thumb` から `.ak-thumb-btn`（`max-width: 46%`）へ移した。img 側に
  `max-width: 46%` を残すと、横長画像が `object-fit: contain` で右側に黒帯を出す。
- 背景タップと「閉じる」で閉じる。シートは閉じない。

### 拡大時のキャプション（注釈 akapen-empty-01: 「この文言はなんですか？」）

- 当初は `figcaption` に `{o.id}. {o.label}` だけを出していたため、`A. 塗りのボタン` としか
  表示されず、どの問いの案なのか画面から読み取れなかった（人が注釈で質問した）。
- `thumbCaption(qno, option, questionText)`（`lib/akapenView.js`）で
  **`Q2 A. 塗りのボタン`（太字）＋ 問いの文（11px・muted）** の 2 行にした。
  `alt` / `aria-label` も同じ見出しを使う（画像 alt が空文字だったのも同時に修正）。
- 落とし穴: **`.ak-zoom` を足した直後に dist を作り直さずスクショを撮ると、CSS が無い状態が写る**
  （オーバーレイが暗幕も原寸も効かず、キャプションと「閉じる」だけが地に落ちて見える）。
  見た目を撮る前に必ず `npm run build`。

### 画像一覧の取得日時とリポジトリ名（`.ak-new-cap`）

「＋ 注釈」の下地一覧（`/api/akapen/library`）は同じ画面のショットが並ぶため、どれが
いつ・どのリポジトリの画像かが画面から読めなかった。各セルの下に 2 行で出す。

- 取得日時 = `mtime`（epoch ms）。一覧の並びもこの値の新しい順。`capturedLabel(ms)` が
  端末ローカルの `MM/DD HH:mm` に整形する（秒は出さない。3 列に収める）。
  library への取り込みは `shutil.copy2` なので、元画像の撮影時刻がそのまま残る。
- リポジトリ名 = **画像にリポジトリ情報は無い**ので bridge が推定する。赤ペンのタスク本文
  `[akapen] … image=<rel> target=<path>` を集め、`image=` の完全一致 → `label=` の
  ハイフン境界一致（撮影名は `<label>-<stamp>-<round>.<kind>.png`）→ `target` を
  Git Ops の登録リポジトリへ**最長一致**で解決（`~/.hermes` のような広いリポジトリがある
  ため短い一致で打ち切らない）。推定できなければ `—`（`repoLabel()`、実測 33 枚中 4 枚）。
- `target=` は `~/projects/…` と `~/Projects/…` が混在するので比較は小文字で行う
  （macOS は大文字小文字を区別しない）。

### 進行中と完了を「開かなくても」気づく（作業フィード + ナビの点）

実測（`t_f7823266`）: 回答 22:19:43 → worker 起動 22:19:47（3 秒）→ 完了 22:26:38（実作業 6.8 分）。
完了報告は監視 cron `mobile-akapen-watch` が 22:27:09 に作っていたが、**配信先が Discord だけ**で
PWA には届かず、「完了したのに気づけない」状態だった。

- 監視 cron は Discord に出す同じ 1 行を `~/.hermes/plugin-data/akapen/feed.jsonl` にも追記する
  （末尾 500 行だけ残す）。bridge の `GET /api/akapen/feed?limit=&since=` が末尾を返す。
- 赤ペンタブは上端に **作業フィード**（直近 3 行、時刻 + 1 行）を出す（`.ak-feed`）。15 秒で更新。
- ナビの赤ペンタブは 1 つだけ印を出す（`navBadgeState`、優先度は 判断待ち > 未読の完了 > 反映中）:
  判断待ち = 黄色の数字（既存）、未読の完了 = 緑の点、反映中 = 青の点（`.nav-dot`）。
  **数字は「あなたの番」にだけ使う**（完了件数を数字にすると判断待ちと混ざる）。
- 既読は「赤ペンタブを開いている＝既読」。`hm.akapenSeenAt` を localStorage に置き、開いている間は
  `hm:akapen-seen` で未読を 0 にする。閉じている間に増えた完了だけ緑の点が残る。
- 新しい完了を検知したらトーストで 1 回だけ知らせる（同じ行で二度は出さない。初回読み込みでは出さない）。
