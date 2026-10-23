# ディープリンク契約（PWA）

外部（`hermes-widget` のウィジェット、Discord bot、将来のクライアント）が PWA の特定画面を
開くための契約。**この1枚が正**。値の追加は後方互換で行う。

## 受け付ける形式

| 形式 | 例 | 挙動 |
|---|---|---|
| クエリ | `/?open=inbox&task=<id>&board=<slug>` | タスクタブ＋承認待ちシート。`task` を先頭に寄せてヒント表示 |
| クエリ | `/?open=chat` | チャットタブ |
| クエリ | `/?open=tasks` | タスクタブ（シートは開かない） |
| ハッシュ | `/#inbox` / `/#inbox:<task>` | 同一ドキュメント遷移でも拾える（`hashchange` 監視） |
| パス | `/inbox` `/chat` | 予備。**bridge の公開パス許可が必要**（現状 401） |
| 付加 | `&_=<epoch ms>` | キャッシュバスター。解釈しないが**消さない** |

## 規則

1. 読み取り後、`open` / `task` / `board` は `history.replaceState` で消す。
   リロードや再訪で勝手にシートが開き直らないため。
2. `_` は**そのまま残す**（受信側のキャッシュ回避意図を壊さない）。
3. シートは開いたときに `#inbox[:<task>]` を `history.pushState` で積む。
   `popstate` でハッシュが外れたら閉じる＝**Android の戻るで閉じる**。
4. 未ログイン時は `/auth` 画面に落ちる（ディープリンクは消費される）。
5. 追加の値は `open=` の語彙を増やす形で行い、既存の値の意味は変えない。

## 実装位置

- 解釈: `apps/web/src/lib/deeplink.js`
- タブ決定・イベント: `apps/web/src/App.jsx`（`hm:open-inbox` を dispatch）
- シート開閉・履歴: `apps/web/src/features/TasksPane.jsx`
- 表示（回答済み区別・フォーカス）: `apps/web/src/features/InboxSheet.jsx`
