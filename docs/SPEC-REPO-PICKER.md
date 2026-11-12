# SPEC: 新しい会話でリポジトリと板を選ぶ

状態: **実装済み（2026-11-12）** / 起票 `t_f7823266`
赤ペン: `~/Projects/akapen/sheets/repo-picker-01-1.html`（4 問すべて A）
実装: `apps/bridge/src/repos.js`（repo×board の合成）/ `apps/web/src/lib/repoPicker.js`（純関数）/ `apps/web/src/features/ChatPane.jsx`（シート・ヘッダー・`session.create` の cwd）

## 1. 決めたこと（赤ペン回答）

| # | 論点 | 決定 |
|---|---|---|
| Q1 | どこで選ぶか | **同じシートに節を足す（1 段）**。プロファイル 3 行 + リポジトリ節 |
| Q2 | 何を並べるか | **リポジトリから入る**。板が複数あるときだけ次の段（板を選ぶ） |
| Q3 | 板が無い repo | **確認してから作る**（「ボード <id> を作る」/「作らない」） |
| Q4 | どこまで覚えるか | **この会話だけ**。次回は前回の値を初期値に（`前回` の印） |

## 2. データの流れ

```
Git Ops repos.json ─┐
                    ├─→ /api/repos ─→ シート（4 行 + すべて 17 件）
kanban.boards() ────┘        │
  (default_workdir が一致)     ├─ 1 板 → そのまま開始
                              ├─ 複数 → 「ボードを選ぶ」段
                              └─ 0    → 「ボードを作る」段 → POST /api/repos/:id/board
```

- 一覧の出所は **Git Ops の `repos.json` ひとつ**（`akapen.targets()` を再利用。既存の赤ペン反映先と同じ集合）
- repo と板の対応は **板の `default_workdir` が repo の path と一致**するものだけ。推測で寄せない
  （どの repo にも属さない板＝`mobile`（akapen）や `hermes-widget` などは一覧に出ない）
- 比較は小文字・末尾スラッシュ落とし（macOS は大小文字を区別しない。実測で `~/projects` と `~/Projects` が混在）

## 3. 選ぶと何が起きるか

1. **作業ディレクトリ**: `session.create` に `cwd: <repo.path>` を渡す（実測: 応答の `info.cwd` が repo のパスで返る）
2. **起票の宛先**: `hm.board` にその板を書く → タスクタブ・クイック起票の既定ボードが切り替わる
   （実測: repo 選択後にタスクタブを開くと `hermes-mobile-pwa` が選択済み）
3. **見える化**: チャットのヘッダーに repo の札（押すとシートが開く）
4. **次回の初期値**: `hm.repo` / `hm.repoRecent`（6 件）を保存し、シートの先頭に `前回` の印で出す

## 4. 端末の保存キー

| キー | 内容 |
|---|---|
| `hm.repo` | 直前に選んだリポジトリ id（次回の初期値） |
| `hm.repoRecent` | 直近 6 件の id（新しい順。シートの 4 行の並び） |
| `hm.board` | 起票の既定ボード（既存のキー。repo を選ぶと上書きされる） |

## 5. API

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/repos` | `{repos: [{id,label,path,boards:[{slug,name,current}]}]}` |
| POST | `/api/repos/:id/board` | 板が無い repo に 1 つ作る（既にあれば `created:false` で返す） |

- 作成は `hermes kanban boards create <id> --name <label> --default-workdir <path>`（CLI 経由。DB に直接書かない）
- 未登録 id・危険な slug・CLI 失敗は `ok:false`（黙って作らない）。監査は `audit.jsonl` の `repos.board.create`

## 6. 非対象

- 既存の会話のリポジトリを後から変える（`session.set_cwd` は使わない）
- 板の削除・改名（カンバン CLI / ダッシュボードの仕事）
- 認証・権限（端末のトークンは従来どおり）

## 7. 検証

- `npm run verify` → `# tests 150 / # pass 150 / # fail 0`、`check:pwa` 30 項目、`build` 成功
- 390×844 の実レンダリング: シート（3 + 4 行 + すべて + 選ばない）、ボード選択の段、作成の確認の段、ヘッダーの repo 札
- 実測（bridge 4098 = 本番と同じ dist / 同じ `~/.hermes`）:
  - `session.create {profile:'mobile', cwd:'…/hermes-mobile-pwa'}` → `info.cwd` が同じパス
  - repo 選択 → `hm.board=hermes-mobile-pwa` → タスクタブの選択ボードが `hermes-mobile-pwa`
- **未検証**: 実際にボードを作る往復（本番のカンバンに板を増やさないため、確認画面の表示までで止めた）
