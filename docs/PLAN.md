# Hermes Agent モバイル専用 PWA — 実装計画（V1 / V2）

- 作成: 2026-10-22
- 状態: **計画のみ（実装未着手）**
- 前提: 既存の標準ダッシュボード（`hermes dashboard` / `hermes serve` = 127.0.0.1:9119）は**一切変更しない**

---

## 1. 目的と非目標

### 目的
Android（Tailscale 経由）から、外出先で Hermes Agent の状態を見て、介入できる軽量 PWA を持つ。

1. **見る**: Discord から投げたタスクの進行（カンバン / 最新コミット / 実行中セッション / ログ）
2. **知る**: SystemOps の異常（ブロック中プロセス・負荷）をバッジで即把握
3. **止める**: Bot が暴走したときの 1 タップ介入（drain / restart / stop）

### 非目標（V1 では作らない）
- 標準ダッシュボードの全機能移植（MCP 管理・プラグイン市場・プロファイル編集・課金/分析の詳細）
- デスクトップ並みの情報密度。**スマホ縦画面で 3 タップ以内**を優先する
- マルチプロファイルの切替 UI（V2。API は `?profile=` を受けるので拡張可能）

---

## 2. 現状確認（実測 / 2026-10-22）

| 項目 | 実測結果 |
|---|---|
| サーバ | `hermes serve` = headless JSON-RPC/WS gateway、`hermes dashboard` = 同サーバ + Web UI。既定 `127.0.0.1:9119` |
| REST 認証 | `X-Hermes-Session-Token`。トークンは `HERMES_DASHBOARD_SESSION_TOKEN` か**起動時乱数**（plist 未設定 → SPA の HTML から取得する必要） |
| WS 認証 | loopback なら `?token=`。ブラウザ用は 30 秒 TTL の `?ticket=` |
| 認証済みで 200 を確認した API | `/api/health` `/api/status` `/api/system/stats` `/api/sessions` `/api/sessions/{id}` `/api/config` `/api/cron/jobs` `/api/ops/hooks` `/api/tools/toolsets` `/api/plugins/system-ops/blocked-processes` |
| 制御系 API | `POST /api/gateway/drain` → `{ok:true, draining:true}` / `POST /api/gateway/restart` → `{ok:true,pid}` / `start` / `stop?interrupt=true` |
| WebSocket | `/api/ws`（JSON-RPC 2.0。`message.delta` `reasoning.delta` `thinking.delta` `gateway.ready` `session.context_breakdown`）、`/api/pty`（端末）、`/api/console`、`/api/events` |
| カンバン | **HTTP API なし**。`~/.hermes/kanban/boards/<slug>/kanban.db`（ボードごとに独立 SQLite）＋ `board.json`。`tasks` / `task_runs` / `task_events` / `task_comments` |
| モデル一覧 | `/api/models` は無い。`/api/config`（現在モデル + providers）と `/api/tools/toolsets/{name}/models` |
| プロセス | 標準ダッシュボードは launchd `ai.hermes.dashboard`、ゲートウェイは `ai.hermes.gateway` |

（生の出力は `docs/EVIDENCE.md`）

---

## 3. アーキテクチャ

```
[Android PWA]
   │ https（Tailscale）
   ▼
[Tailscale serve :443 /m  … または 8443]     ← 既存の / と共存
   ▼
[mobile bridge  127.0.0.1:4097]  Node 24（web-console と同一構成）
   ├─ 静的配信（React + Vite の PWA / SW / manifest）
   ├─ REST プロキシ  → http://127.0.0.1:9119/api/*  （トークンをサーバ側で注入）
   ├─ WS プロキシ    → /api/ws, /api/pty（?token= をサーバ側で付与）
   ├─ カンバン読み取り（SQLite, read-only, WAL）
   ├─ ログ tail（~/.hermes/logs/*.log → SSE）
   └─ キルスイッチ（drain / restart / stop + 確認 + 監査ログ）
```

### なぜ「自作ブリッジ」なのか

| 案 | 判定 | 理由 |
|---|---|---|
| A. PWA から 9119 を直接叩く | ✗ | CORS、`Origin`/`Host` ゲート（WS 4403）、**セッショントークンを端末に露出** |
| B. 2つ目の `hermes dashboard --port 4097` | ✗ | 重量級 SPA の二重起動で「軽量」に反する。設定・DB も二重管理になる |
| C. Tailscale serve のパス分割（`/m`） | ✗ | オリジンが分離されず、SW / manifest が既存ダッシュボードと衝突する（DSH で実証済みの罠） |
| **D. 4097 に軽量ブリッジ + PWA** | **採用** | 既存は不変、トークンは端末に渡らない、モバイル専用の加工（kanban/ログ/キルスイッチ）を足せる |

### 技術スタック（DSH アプリの実績をそのまま使う）
- Node 24 + 素の `node:http`（Express 等を入れない。DSH で実測済みの構成）
- React 18 + Vite、単一 npm ルート、`manifest.webmanifest` + Service Worker
- テストは `node:test`（DSH で 63 件運用中）
- 配信: launchd `ai.hermes.hermes-mobile`（`~/Library/LaunchAgents/`、plist はユーザーシェルで設置）
- 認証: Tailscale 限定 + アプリトークン Cookie（`HttpOnly` `SameSite=Strict`）+ `X-Client` ヘッダ（CSRF 多層防御）

### トークン解決（重要）
`HERMES_DASHBOARD_SESSION_TOKEN` が未設定だとトークンは毎起動で変わる。ブリッジは次の順で解決する:
1. `process.env.HERMES_DASHBOARD_SESSION_TOKEN`
2. `GET http://127.0.0.1:9119/` の HTML から `window.__HERMES_SESSION_TOKEN__` を抽出
3. 401 を受けたら 2 を 1 回だけ再実行（ダッシュボード再起動に自動追随）

より決定的にしたい場合は plist に `HERMES_DASHBOARD_SESSION_TOKEN` を追加する（1 行。設置はユーザーシェル）。

---

## 4. V1 — DSH アプリの仕様を Hermes 向けに

DSH アプリの「4 タブ + 入力欄まわり」をそのまま持ってくる。**画面は作り直さず、ブリッジの口だけ差し替える**。

### 4.1 チャット
- `/api/ws`（JSON-RPC 2.0）で `session.create` → 送信 → `message.delta` / `reasoning.delta` / `thinking.delta` / ツール呼び出しを受け、SSE 相当をブリッジで正規化して UI に流す
- 中断・承認（`user_questions` / 承認要求）は V1 では**表示のみ**、操作は V2
- 過去セッションの閲覧は `/api/sessions` + `/api/sessions/{id}`（`state.db` の `messages` を read-only で読む補助経路も用意）
- リスク: `tui_gateway` の WS プロトコルは内部実装。**バージョン固定 + プロトコル探針テスト**（DSH の `probe-sdk.mjs` と同じ手法）で検知し、壊れたら「ビューアのみ」に退避する

### 4.2 モデル
- `/api/config` の `model` / `providers` を表示。切替は V2（`config set` 相当の書き込みは誤操作コストが高い）

### 4.3 ターミナル
- `/api/pty`（WS）を xterm.js で表示。DSH と同じく**フルシェル + 監査ログ**
- 誤操作防止に、貼り付け時は確認、`rm -rf` 等のパターンは警告のみ（ブロックしない: 緊急時に止められなくなるため）

### 4.4 設定（読み取り中心）
- `/api/status` `/api/config` `/api/cron/jobs` `/api/ops/hooks` の主要値をカード表示
- 書き込みは V2（プロファイル・モデル・ツールセット）

### 4.5 DSH から引き継ぐ UX
- 入力欄まわりの定型スニペット（Hermes 用の文言に差し替え）
- 添付（画像・ファイル）。Hermes 側は `/api/chat/image-upload` があるので DSH より素直に実装できる
- 接続断バナー + 15 秒ポーリング、下部ナビ、safe-area 対応、ダークティール

---

## 5. V2 — Hermes 固有の 3 機能

### 5.1 Discord 連動リアルタイム・タスクビューア（本命）
- データ源: `kanban.db`（タスク / 実行 / イベント）と `/api/sessions`（source=discord のセッション）
- 表示: ボードごとの in_progress / ready を並べ、タップで `task_events` の時系列 + 最新コミット（`git log -1`）+ セッションの `last_activity_description`
- 「プッシュ通知感覚」: SW + Web Push ではなく、**5 秒ポーリング + 差分のみ再描画**（Tailscale 内なので十分。Web Push は iOS/Android の制約と鍵管理が重い）
- 通知: Discord 側の `kanban_notify_subs` は既にあるので、V2 では「更新があったら端末にバッジ（PWA の `setAppBadge`）」まで

### 5.2 SystemOps クイックパネル
- `GET /api/plugins/system-ops/blocked-processes` → **Clean / Blocked / Unknown** のバッジ（実測: `data.ok` と `generated_at`）
- `GET /api/system/stats` → メモリ / CPU / ディスク
- 再起動ボタンは 5.3 と共通の確認フローを通す

### 5.3 緊急停止・介入（キルスイッチ）
実測で確認した 3 段階。**いずれも Hermes 自身の API を叩く**（生の `launchctl` は使わない）。

| ボタン | API | 挙動（実測） |
|---|---|---|
| 新規受付停止 | `POST /api/gateway/drain` | `{ok:true, draining:true}`。ターンは完走し、新規は受けない |
| 再起動 | `POST /api/gateway/restart` | `{ok:true,pid}`。SIGUSR1 → **実行中ターンの完了を待って**再起動（最大 1800 秒） |
| 強制停止 | `POST /api/gateway/stop?interrupt=true` | 実行中も含めて停止（Dial 中は 409 で拒否される仕様） |
| カンバン中断 | `hermes kanban reclaim` → `block` | worker を終了して claim を解放し、再実行を止める（§11） |

安全装置（必須）:
- 1 タップでは実行しない。**長押し 1.5 秒 + 確認シート**（DSH の長押し実装を流用）
- 実行前に「実行中のターン数」と「対象プロファイル」を表示
- 実行結果を `audit.jsonl` に残し、設定タブから確認できる
- **レート制限**（1 分 3 回まで）と冪等キー（二重送信で 2 回再起動しない）
- 誤爆時を考え、`drain` の解除（`/api/gateway/start`）も同じ画面に置く

---

## 6. セキュリティ

- 待受は `127.0.0.1:4097`。外部公開は Tailscale serve のみ（tailnet 限定）
- 端末には**アプリトークンのみ**。Hermes のセッショントークンはブリッジから外に出さない
- 書き込み系は `X-Client` ヘッダ必須 + `Origin` 検査 + レート制限（DSH と同じ多層防御）
- 破壊的操作は確認 + 監査ログ。**「消す」系は V1 に置かない**
- 添付は DSH と同じ内容アドレス保存 + 90 日 GC

## 7. リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| `/api/ws` の JSON-RPC がマイナー更新で変わる | チャットが壊れる | プロトコル探針を CI 相当の cron で毎日実行。壊れたら UI をビューアモードに自動フォールバック |
| セッショントークンが起動ごとに変わる | ブリッジが 401 | HTML から再取得（1 回リトライ）+ 推奨設定として env 固定を案内 |
| `kanban.db` のスキーマ変更 | タスクビューが空になる | 列名を直書きせず `pragma table_info` で存在確認。失敗時は「カンバン API 未対応」表示 |
| キルスイッチの誤爆 | ゲートウェイ停止 | 長押し + 確認 + 実行中ターン数の提示 + drain 解除ボタン + 監査ログ |
| スマホでの情報過多 | 使われなくなる | 1 画面 1 目的。V2 の 3 機能はそれぞれ独立タブにし、ホームは「状態 3 行 + ボタン 3 つ」に固定 |
| Tailscale 断 | 無反応 | DSH と同じ接続断バナー + 再試行。SW は「殻だけ」キャッシュ |

## 8. WBS

| # | 作業 | 見積 |
|---|---|---|
| M0 | ブリッジ雛形（静的配信 / 認証 / トークン解決 / ヘルス） | 0.5 日 |
| M1 | REST プロキシ + `/api/status` `/api/system/stats` `/api/sessions` | 0.5 日 |
| M2 | WS プロキシ + チャット（送信・ストリーミング・ツールカード） | 1.5 日 |
| M3 | ターミナル（`/api/pty` + xterm） | 0.5 日 |
| M4 | PWA 化（manifest / SW / アイコン / インストール検証） | 0.5 日 |
| M5 | カンバン読み取り（board.json + tasks + task_events） | 1 日 |
| M6 | SystemOps パネル + キルスイッチ（ゲートウェイ 3 種 + カンバン中断、確認・監査・レート制限） | 1.5 日 |
| M7 | 障害系（401 再取得 / WS 切断 / DB ロック / 誤爆）と運用 docs | 1 日 |
| 計 | | **約 7.0 日**（V1 4.0 日 / V2 3.0 日） |

## 9. 検証計画（実装時に必ず実測する）

- 390×844 の実機サイズで、ホーム→タスク→停止 まで**3 タップ以内**
- チャット送信→ストリーミング→中断 の往復
- ターミナルで `tty` / `ls` が実 PTY に載る
- カンバン: `web-console` ボードの実タスクが表示され、件数が `sqlite3` の実数と一致
- キルスイッチ: drain → 新規ターンが拒否される / restart → graceful に再起動（実測済みの挙動と一致）
- 標準ダッシュボード（9119）が**無傷**であること（`/api/health` と画面表示）
- 端末の DevTools で **Hermes のセッショントークンが見えない**こと

### 決定事項（2026-10-22 承認）

| 論点 | 決定 |
|---|---|
| 公開 URL | **別オリジン `https://<host>:8444`**（8443 は DSH が使用中のため 8444 を新規に使う） |
| V1 の範囲 | **チャットを含む**（V1 = 4 タブすべて） |
| キルスイッチの範囲 | ゲートウェイ操作 **＋ カンバンの実行中タスク中断** まで |
| 通知 | **5 秒ポーリング**（Web Push は使わない） |

Tailscale serve の現状（実測）:

```
https://hermes-host.tail1234.ts.net        → 127.0.0.1:9120（既存ダッシュボード）
                                          /dsh  → 127.0.0.1:8787（DSH Web UI）
https://hermes-host.tail1234.ts.net:8443   → 127.0.0.1:8787（DSH の別オリジン）
https://hermes-host.tail1234.ts.net:8444   → 127.0.0.1:4097（本案・新規）
```

別オリジンにする効果:
- **PWA のアイデンティティが完全に分離**される（DSH / 既存ダッシュボードと WebAPK が衝突しない。DSH で踏んだ罠を回避）
- `manifest` の `start_url` / `scope` を `https://<host>:8444/` に固定でき、Service Worker のキャッシュも混ざらない
- 端末側のアイコン名は「Hermes Mobile」など別名にする（同名だと Android が既存 PWA と誤認する）

## 10. 未決事項（決定済み）

1. ~~公開 URL~~ → **`https://<host>:8444`（別オリジン）**。8443 は DSH が使用中のため 8444 を新規使用（上表）
2. ~~V1 にチャットを含めるか~~ → **含める**（WS プロキシが V1 の中心。プロトコル探針で守る）
3. ~~キルスイッチの到達範囲~~ → **カンバンの実行中タスク中断まで**（下記 5.4）
4. ~~通知~~ → **5 秒ポーリング**。`navigator.setAppBadge()` で未読件数だけ出す

## 11. 追加検討: カンバン実行中タスクの中断（5.4）

カンバンに「中断」API は無いが、**worker を止めて claim を解放する正規コマンド**がある（実測）:

```
$ hermes kanban reclaim --help
usage: hermes kanban reclaim [-h] [--reason REASON] task_id
  --reason REASON  Human-readable reason (recorded on the reclaimed event)
```

`hermes_cli/kanban_db.py: reclaim_task()` が `_terminate_reclaimed_worker(worker_pid, ...)` を
呼ぶため、**claim 解放と同時に worker プロセスを終了**し、`tasks.worker_pid` を NULL に戻す。
生の `kill -9` を打つ必要はない（失敗カウンタやイベント記録も整合する）。

ただし reclaim 後は `retry_status`（通常 ready）に戻るため、そのままだと**dispatcher が再実行**する。
「止めたい」場合は 2 段階にする:

```
1) hermes kanban reclaim <task-id> --reason "mobile kill switch"
2) hermes kanban block  <task-id> "モバイルから中断" --kind needs_input
```

ブリッジ側の実装（`POST /api/kanban/tasks/:id/abort`）:

- 実行中でなければ 409（`status != running`）
- 1) → 2) を順に実行し、`task_events` を 1 件読んで結果を返す
- 監査ログに `{task_id, worker_pid, reason, at}` を残す
- UI は長押し 1.5 秒 + 確認シート + 「実行中ターン/経過時間」の表示（ゲートウェイのキルスイッチと共通部品）

