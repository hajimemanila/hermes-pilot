# Manual 編の操作カット用レシピ（`--eval`）

`docs/WIKI-SHOTLIST.md` の「手動 / `--id`」カットは、`scripts/capture-wiki.mjs` の `--eval` に
**画面を目的の状態へ持っていく JS** を渡して撮る。ここに置いたファイルがその正本。

```bash
# 1 カットずつ（2 サイズ同時）
node scripts/capture-wiki.mjs --id MN04 --lang ja --eval "$(cat docs/wiki/recipes/MN04.js)"
node scripts/capture-wiki.mjs --id MN06 --lang ja --eval "$(cat docs/wiki/recipes/MN06.js)"
node scripts/capture-wiki.mjs --id MN08 --lang ja --eval "$(cat docs/wiki/recipes/MN08.js)"
node scripts/capture-wiki.mjs --id MN09 --lang ja --eval "$(cat docs/wiki/recipes/MN09.js)"
node scripts/capture-wiki.mjs --id MN11 --lang ja --eval "$(cat docs/wiki/recipes/MN11.js)"

# MN13 はテーマと Vibe をフラグで固定する（JS 不要）
node scripts/capture-wiki.mjs --id MN13 --lang ja --theme light --vibe serotonin

# 進捗確認
node scripts/capture-wiki.mjs --status --lang ja
```

## 前提（ライブデータに依存する）

- `MN04`: ボード `hermes-mobile-pwa` に、`~/.hermes/state/kanban-sop/history.jsonl` へ
  `metadata.git` を残した完了タスクがあること（スクリプトはボード一覧から
  `hermes-mobile-pwa` を選び、`PWAチャットUI` のタスクを開く）。
- `MN06`: 注釈待ち（`mode=annotation` / blocked）のカードが 1 件あること。
  PWA の「＋ 注釈」からライブラリ画像を選ぶと 1 件作れる。**撮影だけなら送信せず閉じ、
  用済みのカードは「取消」で archived にする**（赤ペン待ちに残さない）。
- `MN08` / `MN09`: 再開できる会話（一覧のバッジが「継続可」）が 1 件以上あること。
- `MN11`: 本文（title / body）を持つメモが 1 件以上あること。
  チェックリストだけのメモは本文が空なので文面が引き継がれない（実測）。
