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


## 進行状況の 1 行

行ごとに `progressText()` を出す。`running` は `開始 X / 心拍 Y`、赤ペン待ちは
`提示 Z`。値は bridge の `list()` が `task_events` の最新 1 件と `last_heartbeat_at`
から詰める（`akapen.js` の `lastEvents()`）。

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
