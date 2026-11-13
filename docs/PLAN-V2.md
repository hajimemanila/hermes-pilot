# v2 提案の評価と実装方針（2026-10-23）

対象: Hermes Mobile PWA（`127.0.0.1:4097` / 公開 `:8444`）
前提: 実装は未着手。本文書は**評価と段階計画**であり、承認後に着手する。

---

## 0. 現状の実測（判断の根拠）

| 項目 | 実測値 | 備考 |
| --- | --- | --- |
| バンドル | `index-BW6W9YD3.js` 479 KB（gzip 133 KB）/ dist 合計 524 KB | これ以上の機能追加は1回あたり +5〜20 KB 想定 |
| タブ名 | `apps/web/src/App.jsx:12` の `label: '端末'` | 改名は1行＋文言数箇所 |
| SystemOps 検知 | `check_blocked_processes.py` **0.13 秒**（844プロセス走査）、出力に `security_agent.pids` を含む | すでに PID まで特定済み。`pkill -x` のワイルドカードは不要 |
| SystemOps の設計 | `blocked.detect()` は **ps / pgrep のみ**（読み取り専用）。キル機能は無い | 書き込み系は新規に足す＝設計変更として扱う |
| カンバン参照 | SQLite 1クエリ **0.00 秒** | 60秒ポーリングしても負荷は無視できる |
| タスクのgit情報 | `~/.hermes/state/kanban-sop/history.jsonl` の `metadata.git` = `{repo, branch, head, dirty, changed_count, diff_stat, status_porcelain[]}` | `done` 実行時のスナップショット。**既に存在する**（新規収集不要） |
| 差分の素材 | `git show --numstat 222758b` → `47 1 apps/web/src/styles.css` | 実データで確認済み。+47 −1 を算出できる |
| Discord ルーティング | セッションキーが `agent:main:discord:thread:<channel>:<thread>` 等で保存済み | スレッドID → guild_id を API で解決できることを実測（`111111111111111111` / parent `222222222222222222`） |
| 通知基盤 | `sw.js` に `push` ハンドラ無し、`web-push` 依存無し | Web Push は完全な新規実装 |
| 実在するロック | `gateway.lock` / `gateway.pid` / `auth.lock` / `kanban.db.dispatch.lock` / `kanban/.dispatcher.lock` / `processes.json.lock` 等 **18個以上** | 一括削除は稼働中の相互排他を壊す |

---

## 1. 「端末」→「ターミナル」改名 — **採用（即）**

- 変更点: `App.jsx` の nav ラベル、`TermPane` のヘッダ/シート文言、`docs` の該当箇所
- コスト: 15分。リスクなし。他機能と同時に入れる

---

## 2. インフラ即応ボタン — **条件付き採用（SecurityAgent キルのみ）／TCCリセットは却下**

### 2-1. SecurityAgent キル — 採用（ただし PID 限定・段階シグナル）

**実装方針**
- ブリッジに `POST /api/ops/release-blocked`（`X-Client: mobile` 必須、レート制限、監査ログ）
- サーバ側で `check_blocked_processes.py` と同等の検知を実行（0.13秒）し、
  **`state === 'Blocked'` かつ `security_agent.present === true` のときだけ**、
  報告された `security_agent.pids` に `SIGTERM` → 3秒待って残存すれば `SIGKILL`
- `pkill -x SecurityAgent` のワイルドカードは**使わない**（対象が増えたときに無差別になる／監査に PID を残せない）
- UI: 端末タブに「Blocked を解放」ボタン。**Blocked でないときはグレーアウト**（誤タップで無関係なプロセスを触らない）
- 押下は長押し1.2秒（既存のキルスイッチと同じ操作系）。実行後に再検知して結果（Clean/Blocked）を表示

**効果**: TCC ダイアログ待ちで永久ハングしているツール呼び出しが、**エラーで返る**（ハングではなく失敗）。
これは「画面を繋ぐ必要性をゼロにする」に実際に効く。

### 2-2. `tccutil reset` — **却下（逆効果）**

理由（設計上の帰結）:
- `tccutil reset` は「許可済み」の記録を**消す**。次回アクセス時に**新しい許可ダイアログ**が出る
- このホストはヘッドレスでダイアログを承認できない → **同じハングを再生産する**
- つまり「止まったときの解除」ではなく「次に必ず止まる状態を作る」操作になる

代替: TCC の状態は読み取り API が無いため可視化も不可。**触らない**のが正解。
必要になったら「特定 bundle の許可を入れ直す」手順（`tccutil reset` ではなく GUI 前提）として別途ドキュメント化する。

### 2-3. キャッシュ・一時ファイルパージ — **設計変更して採用**

提案の `rm -f ~/.hermes/*.lock ~/.hermes/.drain*` は**そのままでは危険**:
`gateway.lock` / `auth.lock` / `*.dispatcher.lock` / `kanban.db.*.lock` が実在し、
消すと gateway の二重起動やカンバン dispatcher の競合を招く。

**採用する形（許可リスト方式・シェル不使用）**
- 対象は固定リストのみ。Node の `fs` で削除（glob 展開をさせない）
  - `~/.hermes/.drain_request.json`
  - `~/.hermes/.hermes-update-in-progress.lock`（更新中断の残骸。実在確認済み）
  - `~/.hermes/.hermes-update-paused-gateways.lock`（同上）
  - `~/.hermes/mobile-pwa/*.tmp`（原子的書き込みの取り残し）
- `GET /api/ops/purge?dry=1` で**先に対象とサイズを返す**（プレビュー）。`POST` で実行
- 削除禁止リストをコードに明記（`gateway.*`, `*.dispatcher.lock`, `kanban.db.*.lock`, `locks/`, `.env*`）
- 監査ログに `{removed:[{path,bytes}], skipped:[]}` を残す

---

## 3. タスクタブの Git 可視化 — **両方採用（低リスク・高頻度）**

### 3-1. コミットバッジ（カード上）
- データ源: `~/.hermes/state/kanban-sop/history.jsonl` の最後の `done` エントリ（`metadata.git`）
- ブリッジが task_id → git 情報のマップを起動時に読み、`/api/tasks` のレスポンスに `git: {head, branch, dirty, repo}` を同梱
- カードに `222758b fix(ui): シート内の項目が…` を1行（`git log -1 --format=%s` 相当は履歴に無いので、
  初回のみ `git -C <repo> log -1 --format=%s <head>` を実行してキャッシュ）
- 履歴に無いタスク（DISpatcher 経由で done していない等）は**バッジを出さない**（推測で埋めない）

### 3-2. Git Diff プレビュー（詳細シート・アコーディオン）
- `GET /api/tasks/:id/diff` を**開いたときだけ**呼ぶ（遅延）
- サーバ: `git -C <repo> show --numstat --format=%h%x09%s <head>` → ファイル毎の `+add -del`、合計行数
- `head` が無い/リポジトリが消えている場合は理由を返してアコーディオンに表示
- 表示: `apps/web/src/styles.css  +47 −1` のような一覧＋合計。行をタップでそのファイルの差分
  （`git show -- <path>` の先頭 200 行、モノスペース・横スクロール）まで開く
- 注意: これは**コミット済みの差分**。未コミット変更は `dirty: true` のとき `git diff --stat` を別枠で出す

---

## 4. Discord ディープリンク — **採用（実測で成立を確認）**

- セッションキーから `channel_id` / `thread_id` を抽出（`agent:main:discord:thread:<ch>:<th>`）
- guild_id は Discord API `GET /channels/<id>` で解決し、`~/.hermes/mobile-pwa/discord-cache.json` にキャッシュ（TTL 7日）
  - 実測: thread `222222222222222222` → guild `111111111111111111`
  - トークンは `~/.hermes/.env` の `DISCORD_BOT_TOKEN` をブリッジ内でのみ使用（端末に渡さない）
- リンク形式: `https://discord.com/channels/<guild>/<channel>`（Discord アプリが入っていればアプリで開く）
- 置き場所: 会話ヘッダーの小さなアイコン＋タスクカード（`session_anchor` があるもの）
- 失敗時（guild 解決不可・DM 等）は**リンクを出さない**

---

## 5. Web Push — **条件付き採用（最後に実施）**

### 判断
- 効果は大きい（アプリを閉じていても Blocked / タスク完了が届く）
- ただし新規面積が最大: VAPID 鍵、購読保存、送信、サービスワーカーの `push`、権限 UI、無効購読の掃除

### 実装方針
1. 起動時に VAPID 鍵を生成・保存（`~/.hermes/mobile-pwa/vapid.json` 0600）。依存は `web-push` 1つ（**サーバ専用**、クライアントのバンドル増は 0）
2. 設定タブに「通知を有効化」→ `Notification.requestPermission()` → `pushManager.subscribe()` → `POST /api/notifications/subscribe`
3. `sw.js` に `push` / `notificationclick` を追加（+25行程度）。クリックで該当タブを開く（`?tab=term&focus=ops`）
4. ブリッジのウォッチャ（常駐・60秒間隔）
   - **Blocked 検知**: 0.13秒/回 → CPU 影響は無視できる。Clean→Blocked の遷移時のみ送る
   - **タスク完了**: カンバンDBの `completed_at` 差分。`git.head` を本文に含める
   - 既存 cron（Discord 通知）とは**役割を分ける**（Discord はそのまま、PWA は push のみ）＝二重通知を避ける
5. 通知本文は設定で「詳細を出す / 出さない（"タスクが完了しました" のみ）」を選べる（VPN 外の中継を経由するため）
6. 失敗購読（410/404）は自動削除

### 前提条件（実測済み）
- `:8444` は `tailscale serve` の正規証明書 → **secure context 成立**（Push の必須条件）
- Android Chrome はインストール済み PWA で push を受ける。Tailscale VPN 常時接続なら要件を満たす

---

## 6. 実装バッチと見積り

| # | 内容 | 工数 | リスク | 前提 |
| --- | --- | --- | --- | --- |
| 1 | タブ改名 + コミットバッジ + Diff プレビュー | 1.4日 | 低 | なし（データ源が既にある） |
| 2 | Discord ディープリンク | 0.7日 | 低 | bot トークン読取（サーバ内のみ） |
| 3 | インフラボタン（Blocked 解放 + 許可リスト掃除、dry-run 付き） | 1.0日 | 中 | Blocked 時の実機確認が1回必要 |
| 4 | Web Push（VAPID + 購読 + 2トリガ） | 1.5日 | 中 | 端末での通知許可・インストール済みPWA |
|  | **合計** | **4.6日** |  |  |

推奨順: **1 → 2 → 3 → 4**。1と2は既存データの表示だけで、破壊的操作が無いため先に価値を出す。
3は「誤操作で壊れない」設計（PID限定・許可リスト・dry-run・長押し）を先に固めてから入れる。
4は面積が大きいので最後。1〜3 だけでも「画面を繋ぐ必要性」はほぼ解消する。

### 分割の選択肢
- **最小（1.4日）**: 1のみ。日常の進捗確認がPC不要になる
- **推奨（3.1日）**: 1+2+3。運用の一次対応がスマホで完結
- **全部（4.6日）**: 4まで。閉じていても気づける

---

## 7. やらないこと（明示）

- `tccutil reset`（§2-2）
- `~/.hermes/*.lock` の一括削除（§2-3）
- `pkill -x SecurityAgent` のワイルドカード実行（PID 限定にする）
- カンバンDBへの書き込み（読み取り専用のまま）
- 既存ダッシュボード（9119）とDSH（8787）への変更
