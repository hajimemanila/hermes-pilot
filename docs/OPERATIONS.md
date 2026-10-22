# 運用（Hermes Mobile PWA）

## 起動・停止

### 常駐（launchd）

```bash
# 1) 設置（このリポジトリの deploy/ から）
cp ~/Projects/hermes-mobile-pwa/deploy/ai.hermes.hermes-mobile.plist ~/Library/LaunchAgents/

# 2) 登録（ゲートウェイ内からは実行できないため、通常のターミナルで）
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.hermes.hermes-mobile.plist

# 再起動 / 停止
launchctl kickstart -k gui/$(id -u)/ai.hermes.hermes-mobile
launchctl bootout gui/$(id -u)/ai.hermes.hermes-mobile
```

ログ: `~/.hermes/logs/hermes-mobile.log` / `.error.log`

### `launchctl bootstrap` が `5: Input/output error` になる

**すでに登録済み**のときに出る（二重 bootstrap はエラー 5）。まず状態を見る:

```bash
launchctl print gui/$(id -u)/ai.hermes.hermes-mobile | head -6   # state = running なら登録済み
launchctl list | grep hermes-mobile                              # 2列目が直近の終了コード
```

- 2列目が **75**（EX_TEMPFAIL）= ポート 4097 が埋まっていて起動できていない。
  手動起動したブリッジが残っているのが原因。`lsof -nP -iTCP:4097 -sTCP:LISTEN` で PID を確認して止める
  （launchd は10秒間隔で自動再試行する）
- 登録をやり直したいときは先に外す:

```bash
launchctl bootout gui/$(id -u)/ai.hermes.hermes-mobile
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.hermes.hermes-mobile.plist
```

- 反映したいだけなら `kickstart -k`（plist を書き換えた場合もこれで再読込される）


### 手動起動（動作確認）

```bash
cd ~/Projects/hermes-mobile-pwa
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm start
```

## 公開（Tailscale）

```bash
# 別オリジン :8444 → ブリッジ :4097（既存 443 / 8443 は触らない）
/Applications/Tailscale.app/Contents/MacOS/Tailscale \
  serve --bg --https=8444 http://127.0.0.1:4097

# 確認
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve status
```

- 端末から `https://<host>:8444/` を開くと **ログイン画面**が出る
- トークン: `~/.hermes/mobile-pwa/token`（0600）。`/auth?t=<token>` を一度開けば Cookie が入る
- ブリッジの起動ログにも「管理画面: …/auth?t=…」として出る

## 認証と安全装置

- 端末に渡るのは**アプリトークンのみ**。Hermes のセッショントークンはブリッジの外に出ない
- 書き込み系は `X-Client: mobile` ヘッダ必須（無いと 401）
- キルスイッチは**長押し1.5秒 + 確認語**（API 側でも `confirm` を検査）
- 実行結果は `~/.hermes/mobile-pwa/audit.jsonl` に追記（設定タブから閲覧）
- レート制限: 書き込み 60 回/分

## API（このブリッジの口）

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/healthz` | 死活（認証不要） |
| GET | `/api/overview` | Hermes 状態 + メモリ/ディスク + SystemOps + 実行中タスク数 |
| GET | `/api/boards` | カンバン一覧（`current` フラグ付き） |
| GET | `/api/boards/:slug/tasks` | タスク一覧 |
| GET | `/api/boards/:slug/tasks/:id` | タスク詳細（events / runs / comments） |
| POST | `/api/boards/:slug/tasks/:id/abort` | 実行中タスクの中断（reclaim → block） |
| POST | `/api/gateway/:action` | `drain` / `restart` / `stop` / `start`（`confirm` 必須） |
| GET | `/api/sessions` | Hermes セッション一覧（整形） |
| GET | `/api/logs?file=gateway&lines=200` | ログ末尾 |
| GET | `/api/audit?lines=80` | 監査ログ |
| WS | `/ws/chat` | Hermes `/api/ws` への中継（JSON-RPC 素通し） |
| WS | `/ws/term` | 実 PTY（zsh） |

## チャットのプロトコル（実測）

```
session.list                                   → {sessions:[{id,title,preview,message_count}]}
session.create {title}                         → {session_id, stored_session_id, messages:[], info}
session.resume {session_id: <stored>}          → {session_id: <ui>, messages:[{role,text}]}  ← 履歴はこれ
prompt.submit  {session_id, text}              → {status:"streaming", user_row_id}
session.interrupt {session_id}
通知: gateway.ready / message.start / message.delta{text} / thinking.delta{text}
      reasoning.delta{text} / message.complete{text,usage} / session.title / sessions.changed
```

- `session.history` は resume 前だと `4001 session not found` を返す（罠）
- 会話は**最初の送信時に作る**（空セッションを作らない）。`session not found` が返ったら 1 度だけ作り直す

## PWA の更新反映

- Service Worker は **画面遷移だけ network-first**、ハッシュ付きアセットは cache-first
- キャッシュ名は `hermes-mobile-v2`。破壊的変更時はここを上げる
- 端末で古い画面が出たら、アプリを完全終了 → 再起動（Android）

### インストールできないとき（重要）

Android の WebAPK 生成は **Google のサーバーが認証なしで** `start_url` / `manifest` / アイコンを取得する。
そのため殻（`/`, `/assets/*`, `/manifest.webmanifest`, `/sw.js`, `/icon-*`）は**公開**し、
データ（`/api/*`, `/ws/*`）だけを認証の内側に置いている。

```
$ curl -s -o /dev/null -w "%{http_code}\n" https://<host>:8444/manifest.webmanifest
200        # これが 401 だと「This app cannot be installed」になる
```

未ログインで開くとアプリ内にトークン入力画面が出る（旧: サーバー側の HTML ログイン）。
`isPublicPath()` の判定を狭めるとインストールが壊れるので、触るときはこの節を確認する。


## 既知の制約

- チャットは WS プロトコル依存。Hermes 更新で壊れたら `node scripts/probe-bridge.mjs` で即検知できる
  （`COMPLETE="BRIDGE_OK"` が出れば健全）
- 端末は**ブリッジが持つ実 PTY**（Hermes 側に汎用シェルの口が無いため）。監査ログは `audit.jsonl`
- node-pty の `spawn-helper` に実行権限が必要。`npm install` 後の `postinstall` が自動で直す
  （欠けると `posix_spawnp failed`）
- 別オリジン（:8444）なので、既存ダッシュボード / DSH の WebAPK とは独立してインストールできる

## 障害時の切り分け

| 症状 | 見るところ |
|---|---|
| ログイン画面から進まない | `~/.hermes/mobile-pwa/token` と Cookie の有効期限 |
| 「ブリッジに接続できません」 | `lsof -nP -iTCP:4097` / `~/.hermes/logs/hermes-mobile.error.log` |
| チャットだけ失敗 | `node scripts/probe-bridge.mjs`（上流 9119 の生存も確認） |
| 端末が `closed` | PTY 起動失敗。`audit.jsonl` の `term.error`、`spawn-helper` の権限 |
| タスクが出ない | ボード slug と `~/.hermes/kanban/boards/<slug>/kanban.db` の存在 |
