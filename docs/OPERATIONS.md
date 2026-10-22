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

## 添付（画像・ファイル）と定型スニペット（2026-10-23 追加）

### 画像・ファイルの送り方（Hermes 側の口を使う）

自前のアップロード置き場は持たない。Hermes には**添付専用の WS メソッド**があり、
ブラウザからブリッジ越しにそのまま呼べる（`~/.hermes/hermes-agent/tui_gateway/contracts/prompt_voice.py`）。

| 種別 | メソッド | 実体の行き先 |
| --- | --- | --- |
| 画像 | `image.attach_bytes {session_id, content_base64, filename}` | `~/.hermes/attachments/`（次のターンに載る） |
| ファイル | `file.attach {session_id, data_url, name}` | セッションのワークスペース。戻りの `ref_text` が `@file:` 参照 |
| PDF | `pdf.attach` | 1ページずつ画像化（UI 未実装） |

- 送信順序: `session.create` → attach を全部 → `prompt.submit`。添付はセッションに紐づくので、
  **セッションを作り直した直後でも取りこぼさない**（従来は送信時に attach するところで失敗しうる）
- ファイルは `ref_text` を本文末尾に `添付ファイル:` として足してから送る
  （例: `- @file:~/.hermes/attachments/hm-note.txt`）。エージェントは普通に読める
- 画像は送信前に**長辺1600pxへ縮小**（WebP 0.9）。縮小後が元より大きければ元を使う。GIF はそのまま
- 上限: 1メッセージ **6個**まで、画像 10MB / ファイル 25MB（クライアント側で弾く）
- 入力欄へのペーストでも画像を取り込める（`clipboardData.items`）。「クリップボードから」は `navigator.clipboard.read()` で、
  Android Chrome は許可ダイアログが出るので補助経路に留める

### 定型スニペット

- `GET /api/snippets` … 組み込み14件 + マイ（`hot` がバーに出る）
- `PUT /api/snippets {custom: [...]}` … マイ定義を保存（最大12件、名前20字・本文400字、`~/.hermes/mobile-pwa/snippets.json` 0600）
- バーは**5個 + ＋**。タップで入力欄に挿入（送信しない）、**長押し550msで即送信**
- 挿入時 `{{...}}` は選択状態にする（そのまま打ち替えられる）
- 長押し送信では**書きかけの下書きを消さない**（`sendText(override)` は `override != null` のとき `setText('')` をしない）
- マイスニペットは設定タブで追加・削除。保存後 `hm:snippets` イベントでチャット側のバーが即更新される

### 実測（2026-10-23, 390×844 / :8444）

```
チップ: ['まとめ','別解','承認','git diff','git status','＋']
画像+ファイル同時送信 → 16.4s
  画像: 緑 64×64 → 応答「#00C85A（RGB 0,200,90）」  ← 実データ一致
  ファイル: hm-note.txt（合言葉 ZX-9999）→ 応答「ZX-9999（~/.hermes/attachments/hm-note.txt 2行目）」
  吹き出し内: サムネ1 + ファイルチップ1、空バブル0
  使用量: in 20723 / out 1521
タップ挿入 → 入力欄に文言が入りフォーカスは TEXTAREA
長押し550ms → streaming=true、送信内容はスニペット文言、下書き「書きかけの下書き」は残存
設定で「議事録」追加 → 件数 1/12、チャットのバーに即出現（hm:snippets）
```

## 端末タブの定型コマンド（2026-10-23 追加）

`apps/bridge/src/term-snippets.js` の 21 件。`GET /api/snippets/term` で配る。

- **タップ = 入力欄に挿入のみ**（Enter は送らない）。確認してから自分で Enter
- **長押し550ms = 実行**。実行時は先に `Ctrl-U`（`\x15`）を送って**入力中の行を捨ててから**流す
  → 打ちかけの文字にコマンドが連結される事故を防ぐ（実測で確認）
- 破壊的コマンド（再帰削除・pkill・killall・sudo など）は**入れない**。
  `test/term-snippets.test.js` が禁止パターンとマーカー文字列を機械的に検査する
- 再起動系は端末 PTY（`ai.hermes.hermes-mobile`）が gateway と別プロセスなので、
  **gateway を再起動しても端末と画面は切れない**

### 収録（バー6件 + シート15件）

| バー | 内容 |
| --- | --- |
| GW状態 | `hermes gateway status` |
| ドレイン解除 | `rm -f ~/.hermes/.drain_request.json && echo ...` |
| GW再起動 | `hermes gateway restart` |
| 解除+再起動 | `rm -f <marker> && hermes gateway restart` |
| DASH再起動 | `launchctl kickstart -k gui/$(id -u)/ai.hermes.dashboard` |
| GWログ | `tail -n 80 ~/.hermes/logs/gateway.log` |

シート: ドレイン状態 / launchd一覧 / エラーログ / GWエラー / 疎通3点 / ポート確認(9119・4097・8787) /
プロセス / 負荷 / ディスク / PWA再起動 / DSH再起動 / カンバン状態 / git状態 / 版・モデル / drain API状態

### ドレインで止まる現象の手順

1. 「ドレイン状態」で `~/.hermes/.drain_request.json` の有無を見る（無ければ drain 起因ではない）
2. あれば「ドレイン解除」→ マーカー削除のみ。gateway はそのまま動き続ける
3. 解除しても戻らないときは「解除+再起動」
4. それでも駄目なら「GWログ」「GWエラー」で原因を見る

`hermes dashboard --status` は launchd 管理の実体を検出できず "No hermes dashboard or serve processes running." を返すため**スニペットにしていない**。
代わりに HTTP 疎通（`curl` で 9119 / 4097 / 8787）を「疎通3点」として用意した。

### 実測（390×844 / :8444）

```
バー: ['GW状態','ドレイン解除','GW再起動','解除+再起動','DASH再起動','GWログ']  シート 21 件
タップ「GW状態」→ プロンプトに "hermes gateway status" が入るだけ（未実行）
長押し「ドレイン解除」→ "drain marker を削除しました"（入力中の行は破棄される）
シート「ポート確認」→ 9119(python3.1 68539) / 4097(node 9983) / 8787(node 95564) が LISTEN
シート「疎通3点」→ dashboard 200 / mobile 200 / dsh 200
長押し「GW状態」→ "Gateway is supervised by launchd (PID 97432)" / nanokvm PID 68042
レイアウト: action-bar 36px、term-host 614px（33行）、nav top 786、scrollY 0
```
