# SPEC: PWA チャットの全プロファイル対応（送信可 + プロファイル可視化）

- **Status**: archived
- **アーカイブ日**: 2026-11-21（COH-4・全バッチ完了済み。以後は参照用に保持し、新規起票の対象外）

状態: **実装済み（2026-11-12）** / 起票 `t_7674a165`（仕様）`t_6b527899`（bridge）`t_64aeb243`（UI）
対象: Hermes Mobile PWA（bridge 4097 / UI /ws/chat）
実装: `apps/bridge/src/chat-profile.js`（profile 検証）/ `apps/web/src/features/ChatPane.jsx`（札・ヘッダー・選択シート）

## 1. なぜ今は default だけ書けるのか（忘れていた理由）

`docs/OPERATIONS.md` の **2026-10-24 決定** が根拠。技術的制約ではなく**スコープ削減の決定**だった。

> 方針（決定 2026-10-24）: 閲覧は全プロファイル／返信は既定プロファイルのみ。
> 開発時の指示は Discord 経由で行い、PWA からの指示はサブプロジェクトや簡単な質問が中心のため、
> PWA を複雑化させない（他プロファイル宛の返信＝WS 経路の追加は実装しない）。

実装上の対応関係:

| 機能 | 実装 | 制約 |
|---|---|---|
| 会話一覧 | `GET /api/sessions`（bridge）が `/api/profiles` を列挙し `?profile=` で合成 | 全プロファイル可 |
| 会話の中身 | `GET /api/sessions/:id/transcript?profile=` が各 `state.db` を readOnly で読む | 全プロファイル可 |
| 送信 | `/ws/chat` → `127.0.0.1:9119/api/ws`（`apps/bridge/src/server.js:781-`）に**プロファイルを渡していない** | default のみ |
| UI | `ChatPane.jsx:950-` が `profile !== 'default'` を **読み取り専用**で開く（`loadTranscript`） | default のみ |

## 2. 実測: RPC 自体は既にプロファイルを受ける（2026-11-12 / 本番 :9119）

`/api/ws`（legacy token path, bridge と同じ経路）で確認:

```
session.list   {profile:"sample-app"}                              -> 6 件（例 20260101_120000_deadbeef）
session.resume {session_id:"2026...", profile:"sample-app", lazy:true} -> ok / history 133 件
session.create {title:"...", profile:"default"}                 -> ok / info.profile_name = default
```

コード側の裏付け:

- `session.list` / `session.create` / `session.resume` は `_profile_scoped` で `params["profile"]` を解決
  （`tui_gateway/methods_session.py:334`, `:623`）
- `prompt.submit` は**セッション記録に束縛済み**の `profile_home` で走る（`tui_gateway/methods_prompt.py:1428-`）
- `/api/ws` は legacy token でも `profile_scope='host'` になり、serve 済みの兄弟プロファイルを選べる
  （`hermes_cli/web_routers/chat_ws.py:702-735`）
- gateway は multiplex（1 プロセスが default / mobile / sample-app を serve: `hermes gateway list` で全て同じ PID）

→ **不足しているのは bridge の受け渡しと UI の 2 点だけ。** profile を渡さないコードが「読み取り専用」の実体。

規模（state.db の sessions）: default 109 / mobile 9 / sample-app 15。

## 3. 設計案（採用候補）

### 3.1 bridge

- `/ws/chat` の上流はそのまま 1 本。JSON-RPC フレームは素通しのまま、
  **`session.create` / `session.resume` の `params.profile` だけ許可リストで検証**して通す
  - 許可リスト = `/api/profiles` の served 名（30 秒キャッシュ済み `listProfiles()`）
  - 未知名は `-32602` で落とす（`../` や `default` 以外の注入を弾く）
  - 省略時は現行どおり default（後方互換）
- `prompt.submit` / `attach` 系は変更不要（session に束縛される）
- 監査: `chat.profile` {profile, method} を `audit.jsonl` に残す

### 3.2 UI

- **会話一覧**: 各行に小さなプロファイルチップ。`default` は無印、他は名前（例 `sample-app`）
- **会話ヘッダー**: 開いている会話のプロファイル名を常設（読み取り専用バナーは廃止）
- **新規会話**: 「＋」→ プロファイル選択シート（default を先頭・推奨）→ `session.create {profile}`
- **他プロファイルの既存会話**: タップで `session.resume {profile}` → そのまま続きを書ける
  （`resume` が失敗したときだけ従来の transcript 読み取り専用にフォールバック）

### 3.3 既知の罠（実装時に必ず踏む）

- `ChatPane.jsx:451,467` の「`session not found` なら作り直す」経路にも **同じ `profile` を渡す**。
  忘れると他プロファイルの会話が**黙って default に作られる**（一番危ない壊れ方）
- 添付は `session.create` の後・`prompt.submit` の前（既存順序）。profile でも同じ
- カンバン作業ログ `local-…` は profile とは別問題で従来どおり読み取り専用（`session.resume` が 4132）

## 4. リスク

| リスク | 内容 | 対策案 |
|---|---|---|
| worker 誤爆 | `mobile` はカンバン worker の実行プロファイル。同じ home で別ターンが走る | ヘッダーにプロファイル名 + `worker` バッジ、送信前の可視化 |
| 期待違い | モデル・設定・スキルは**そのプロファイルのもの**が効く（default を継承しない） | ヘッダーにプロファイル名を常設、初回に 1 行説明 |
| 同時実行 | 別プロファイルのターンが並走しうる | 許容（サーバは多重対応）／1 本ずつに絞る のどちらかを決める |
| 監査 | どのプロファイル宛かが追えない | audit + セッション行の `profile_name`（既に記録されている） |

## 5. 決定表（2026-11-12 すり合わせ完了）

| # | 論点 | 決定 | 理由 |
|---|---|---|---|
| D1 | 書き込みを許すプロファイル範囲 | **3 つすべて**（default / mobile / sample-app） | gateway が 1 プロセスで全部 serve 済み。役割分担「PWA=即時処理」を全プロファイルで成立させる |
| D2 | 新規会話のプロファイル指定 | **「＋」→ プロファイル選択シート**（default 先頭・1 タップで既定） | 誤爆しやすい mobile への送信に 1 クッション挟む。既定は押すだけ |
| D3 | 履歴・ヘッダーでの見分け | **一覧行に小さなチップ**（default は無印、他は名前）**＋ 会話ヘッダーにも常設** | 「今どのプロファイルに話しているか」を常に 1 箇所で読める |
| D4 | worker 誤爆対策の強さ | **ヘッダー常設表示のみ**（送信は 1 タップのまま） | 長押しは常用操作を重くする。可視化で足りる |
| D5 | 同時実行 | **許す**（別プロファイルのターンが並走してよい） | サーバは多重対応済み。止める仕組みは bridge への新規実装になり、得るものが少ない |

### 付随して決めたこと（実装時の裁量にしない）

- 並び順は既存の **lastActive 降順**のまま。default を先頭固定しない（並びの規則を壊さない）
- 新規シートは**前回選択を記憶しない**（毎回 default が先頭＝D2 のクッションを毎回効かせる）
- チップの色: `mobile` は warn 系（worker）、`sample-app` は neutral、`default` は無印。凡例は出さない
- 「読み取り専用」バナーは**他プロファイルでは廃止**し、`<profile> プロファイル` の常設表示に置換。
  `local-…`（カンバン作業ログ）は従来どおり読み取り専用のまま
- `profile` は **`/api/profiles` の served 名のみ許可**（注入・存在しない名前は `-32602`）


## 6. 非対象

- プロファイルの作成・削除・設定変更（`hermes profile` / ダッシュボードの仕事）
- プロファイル別モデル切替 UI、MoA 設定
- 1 画面での複数プロファイル同時ストリーム表示
- カンバン作業ログ（`local-…`）の送信解禁

## 7. 検証計画（実装時）

1. `npm test` に bridge の profile 許可/拒否テスト（既知 3 名 + 未知名 + 注入文字列）
2. 実機: `sample-app` の会話を resume → 送信 → **sample-app の state.db にだけ**メッセージが増えること（default は不変）
3. UI: 390×844 で一覧チップ・新規シート・ヘッダーの px 実測（一覧の可視領域を削らない）
4. 送信フォールバック: 存在しない session_id を resume させ、**default に作られない**ことを確認

## 8. 実装の分割（順序と受入条件）

| # | 対象 | 内容 | 受入条件 |
|---|---|---|---|
| A | bridge | `/ws/chat` で `session.create` / `session.resume` の `params.profile` を許可リスト検証して素通し・audit `chat.profile` | 未知名/注入が `-32602`、既知 3 名は通る。`npm test` に 4 ケース追加 |
| B | UI | 一覧チップ・ヘッダー常設・「＋」選択シート・resume 失敗時のみ読み取り専用フォールバック | 390×844 で一覧の可視領域を削らない（px 実測）。`mobile` 行にチップが出る |
| C | 実機 | sample-app の会話を resume → 送信 → **sample-app の state.db にだけ**増える | default の state.db の当該セッション行が不変 |

A → B → C の順（B は A が入るまで送信できない）。A と B で 1 タスクにまとめても良いが、
レビューしやすさのため **A / B を別タスク**にする。

