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

## 端末の認証は再起動で切れない（2026-10-23 修正）

端末セッションは `~/.hermes/mobile-pwa/sessions.json`（0600）に**永続化**している。
ブリッジの再起動・launchd の kickstart・Mac の再起動ではログアウトしない。実測:

```
auth → 302（Cookie 発行）
sessions.json: {sessions: 1, tokenFingerprint: 37f068f8781b5482}
kill → launchd が自動復帰（pid 1877）
同じ Cookie で GET /api/overview → 200
もう一度 kill/復帰 → 200（維持）
```

**再認証が必要になるのは次の 4 つだけ**:

1. トークンをローテーションした（`rm ~/.hermes/mobile-pwa/token` → 再起動）。`tokenFingerprint` が変わるので全端末が自動失効
2. 30日間その端末を使っていない（最終利用からスライディング）
3. `npm run revoke` で明示的に失効
4. 端末側でサイトデータを消した / PWA を入れ直した（Cookie が消える）

```bash
npm run revoke -- --list   # 発行済み端末の一覧（Cookie の値は出さない）
npm run revoke             # 全端末をログアウト（トークンはそのまま、再起動不要）
```

書き込みは 5 秒に 1 回までに抑えてある（`authorized()` のたびにディスクへ書かない）。

## チャットの切断復帰とレイアウト（2026-10-23 修正）

### 再接続（画面OFF→復帰 / 回線断 / ブリッジ再起動）

`apps/web/src/lib/useChatSocket.js` が担当する。

- 切断で指数バックオフ再接続（1s → 2s → 4s … 最大15s）
- `visibilitychange`（復帰）/ `online` / `pageshow` で即再接続
- 復帰したら `session.resume` で**元の会話に繋ぎ直す**（`localStorage` の `hm.storedSid` を使用）
- 未解決の RPC は切断時に解放する（呼び出し側が20秒待たない）

実測（ブリッジを kill → launchd が自動復帰）:

```
conn=ready → kill → conn=closed (t=18.1s) → conn=ready (t=20.0s)   ← リロード無しで復帰
```

### 赤帯（未接続バナー）の出し方

- **切断から2秒以上**つながらないときだけ出す。タブ切替時の一瞬のフラッシュは出さない
- 実装の注意: 「再接続のたびにタイマーを張り直す」とバックオフ中に一度も発火しない。
  **切断開始時刻からの経過**で判定する（`offlineSince` + 400ms 間隔の判定）
- 実測: タブ切替15回でバナー表示 0 回 / ブリッジ復帰は約1.9秒なのでバナーは出ない（正常）

### 下部ナビが消える問題への対策

端末（Android）で再現した事象の再発防止。ナビが消えない構造にした:

- `html, body, #root { overflow: hidden }` + `.app { height:100%; max-height:100dvh; overflow:hidden }`
  → ページ自体がスクロールしてナビが画面外に出る経路を塞ぐ
- `.nav { flex: 0 0 auto; position: sticky; bottom: 0 }`
- タブ内の描画エラーは **ErrorBoundary** で 1 画面に閉じ込める（ナビは残る）
- 万一の原因調査用に、端末の例外を `~/.hermes/mobile-pwa/client-errors.log` に記録する
  （`POST /api/client-error`、30件/分まで）
