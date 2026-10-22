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

## ターミナルタブの定型コマンド（2026-10-23 追加）

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

## シート内の項目は `.list-item`（2026-10-23 修正）

`<button class="list-item">` にスタイルが無く、ブラウザ既定の**白背景・中央寄せ・アイコン改行**になっていた
（Android のダークモードで白いカードが並ぶ）。`styles.css` に `.list-item` を追加:

- `background: var(--surface)` / `border: 1px solid var(--line)` / `border-radius: 12px`
- `display:flex; align-items:center; gap:10px; text-align:left`、`appearance:none` で既定の装飾を打ち消す
- `:active` は `--surface-2` + `--line-strong`
- `.list` の gap を 6px に

対象: 定型スニペット / 添付 / ターミナルの定型コマンド / 会話。**シート内に装飾なしの `<button>` を置かない**のが原則。
追加時は `.list-item` か `.row` を使う。

## タスクの Git 可視化と Discord リンク（2026-10-23 追加）

### データ源（新規収集はしていない）

- コミット情報: `~/.hermes/state/kanban-sop/history.jsonl` の `done` エントリ
  `metadata.git = {repo, branch, head, dirty, changed_count}` と `metadata.session_anchor = {chat_id, message_id, session_id, user}`
- 差分: その `repo` と `head` に対して `git show --numstat`（`execFile`・シェル不使用）
- Discord: `~/.hermes/sessions/sessions.json` の `origin`（`guild_id` / `thread_id` / `message_id`）

### API

| エンドポイント | 返すもの |
| --- | --- |
| `GET /api/boards/:slug/tasks` | 各タスクに `git{head,branch,subject,dirty}` と `discord{url,threadId,chatName}` を付加（履歴にあるタスクのみ） |
| `GET /api/boards/:slug/tasks/:id` | 詳細 + 同じ `git` / `discord` |
| `GET /api/boards/:slug/tasks/:id/diff` | `{files:[{path,add,del,binary}], total:{add,del}, subject, dirty, truncated}` |
| `GET .../diff?file=<path>` | そのコミットの該当ファイルのパッチ（200行 / 60KB で打ち切り） |
| `GET /api/discord/session?session_id=` | `{link:{url,threadId,guildId,chatName,messageId}}` または `null` |

### 安全策

- `git` は `execFile` で引数配列渡し。`repo` / `head` は履歴の値のみ（クライアント入力を使わない）
- `file` パラメータは**そのコミットの numstat に含まれるパスだけ**許可（`../../etc/passwd` や `--upload-pack=...` は 404）
- 履歴に無いタスクはバッジも差分も出さない（推測で埋めない）
- 差分は**アコーディオンを開いたときだけ**取得（初回表示を待たせない）。`git show` のサマリは起動時に温める

### UI

- タスクカード: `222758b fix(ui): …` のバッジ、未コミットなら `未コミット`、Discord 由来なら `Discord` チップ
- 詳細シート: コミット / メッセージ →「変更ファイル +1249 −26」→ ファイル行 → タップでパッチをインライン表示
- チャット: Discord 由来の会話ではヘッダーに `#` ボタン（タップでスレッドを開く）
- タブ名を「端末」→「ターミナル」に変更（`App.jsx` / TermPane の文言 / docs）

### 実測（390×844 / :8444）

```
タブ: ['タスク','チャット','ターミナル','設定']
タスク一覧の git バッジ 20 件（DSH ボード）。例: 575ed26 feat(chat): 画像・ファイル添付（＋が主経路・ペースト補助）
詳細: コミット 575ed26 (main) / メッセージ表示 / 変更ファイル +1249 −26 / ファイル13行
パッチ: uploads.js をタップ → 200行・truncated=false・背景 rgb(5,18,26)
Discord: カードにチップ、詳細に「Discord スレッドで開く」、チャットヘッダーに # ボタン
  古いスレッド 20261016_184630_559bc3cb を resume → タイトル「開発環境構築の準備」+ # ボタン表示
API: /tasks/:id/diff → ok:true / files 2件 / total +60 −1
     ?file=../../etc/passwd → 404
```

## 横断検索と読み取り専用トランスクリプト（2026-10-23 追加 / PLAN-V3 の A）

### 検索

- `GET /api/search?q=&limit=30&hours=` → `{ok, q, tookMs, total, hits[]}`
- データ源: `~/.hermes/state.db` の `messages`（**読み取り専用**）。索引は FTS5 `messages_fts_trigram`
- 3文字以上は trigram、2文字以下は `LIKE` に落とす（trigram は 3 文字未満を索引できない）
- クエリは全体をフレーズ引用し `"` を `""` にエスケープ（`AND`/`NEAR(`/`-foo`/`*` でも構文エラーにしない）
- 返すのは**抜粋のみ**（前後60文字）。`discordUrl` は該当セッションが Discord 由来なら付く
- レート制限は書き込みと別枠（240回/分）。認証は `/api/*` の共通ゲート

UI: ヘッダーの虫めがね → シートで入力（280ms デバウンス）→ 行タップでその会話を開く。
検索シートは入力のたびに古い応答を捨てる（`seqRef`）ので、遅い応答が後から上書きしない。

### カンバン作業ログ（`local-…`）は読み取り専用で開く

`session.resume` は **Hermes が設計上拒否する**:

```
ERR 4132 ⛔ Session local-… is a Kanban worker transcript.
Resuming it here would create a writer the Kanban board cannot observe or supervise …
```

そこでフォールバックを持つ:

- `GET /api/sessions/:id/transcript?limit=80&before=` → `{ok, title, messages:[{id, role, text, at}], hasMore}`
- `messages` から `role IN ('user','assistant')` かつ `active=1` かつ非空のみ、古い順に返す
- UI は「読み取り専用」バナーを出し、**入力欄を隠す**（送れないことを明示）
- 検索から来た場合は該当メッセージを枠で強調し、画面の上寄りまでスクロールする
  - `scrollIntoView` は効かなかったため、`getBoundingClientRect` の差分で `scrollTop` を直接合わせる
  - レイアウト確定後に2回（120ms / 500ms）補正する（長い本文で高さが変わるため）

### 実測（390×844 / :8444）

```
検索「ドレイン」→ ok=true 4.7ms / 3件（discord由来は dc リンク付き）
検索「欠陥2件」→ 4件
2文字「検索」→ LIKE 経路 43.2ms（8,385件の全走査）
空クエリ → 400
カンバン由来ヒットをタップ → ROバナー表示 / composer display:none / 12メッセージ
  ヒット位置 top=160px（ヘッダー下）・scrollTop 3779・強調1件
TUI 由来ヒットをタップ → 通常表示（16メッセージ・composer flex・storedSid 保存）
タイトルも sessions.title から復元（「[M7.1] 障害実測で判明した欠陥2件の修正…」）
```

## クイック起票（2026-10-23 追加 / PLAN-V3 の B）

タスクタブの「＋ 起票」から、1行（または音声）でカンバンにタスクを作る。

### サーバ

- `POST /api/boards/:slug/tasks` → `{ok, created, task:{id,title,status,priority,assignee,board}}`
- **DB へ直接書かない**。`hermes kanban --board <slug> create <title> --json …` を `execFile`（シェル不使用）で実行する
- 検証: タイトル必須・200字まで、本文 4000字まで、priority は 0〜9 に丸め、assignee は `[\w.@-]{1,64}` のみ、ボード名は `[a-z0-9][a-z0-9._-]*`
- 二重起票の防止: `idempotencyKey`（シートを開いたときの乱数）を10分キャッシュ。未指定なら内容＋10分窓の sha1
- 書き込み扱い（レート制限 60/分）＋ 監査ログ `kanban.create`

### UI

- タスクタブの「＋ 起票」→ シート。ボードはチップで切替（**いま見ているボードが既定**）
- 音声: `webkitSpeechRecognition`（lang=ja-JP, interimResults）。途中経過もタイトルに反映、確定で終了。非対応端末ではボタンを出さない
- 「詳細」を開くと本文・優先度（なし/低/中/高）・担当
- Enter で送信（IME 変換中は送らない）。成功でトースト＋一覧を再取得

### 実測（390×844 / :8444）

```
POST /api/boards/hermes-mobile-pwa/tasks {"title":"API probe: 起票テスト",...}
  → ok:true created:true task.id=t_3fddc454 priority:5
同じ idempotencyKey で再送 → created:false / 同じ t_3fddc454（CLI は1回だけ）
タイトル空 → 400
UI: 一覧の「＋ 起票」→ マイク表示あり・ボードチップ4件 → 送信
  → 「UI probe: 音声起票のテスト」が一覧先頭（待機）・シートは自動で閉じる
検証用タスクは archive 済み（t_5a36bd3a / t_3fddc454）
```

## 使用量（コスト・トークン）表示（2026-10-23 追加 / PLAN-V3 の C）

### サーバ

- `GET /api/usage?hours=24` → `{ok, hours, totals, cacheHitRate, models[], topSessions[]}`
- `~/.hermes/state.db` を**読み取り専用**で開き、`sessions` と `session_model_usage` を集計するだけ（本文は読まない）
- 結果は**30秒キャッシュ**（画面は60秒ごとに取り直す）
- キャッシュ率 = `cache_read / (input + cache_read)`

### 表記ルール

| 値 | 例 |
| --- | --- |
| コスト | `$1.78` / `$0.123`（1未満は3桁）/ `$0.0042`（0.01未満は有効数字2桁） |
| トークン | `288.20M` / `981.5k` / `842` |
| 率 | `99.2%`（99.95以上は `100%`） |

### 既知のズレ（意図的）

- **モデル別の合計 ≠ セッション合計**（実測: `$1.78` vs `$2.09`）。
  `sessions.estimated_cost_usd` はセッション単位の見積り、`session_model_usage` は API 呼び出し単位の記録で、
  サブエージェントや再試行の数え方が違う。**一致を強制せず**、画面に注記を出している
- 期間の判定は両方とも `sessions.last_activity_at` に揃えた（`last_seen` で切ると窓がずれるため）

### UI

- タスクタブ上部の状態ストリップを **5列**に拡張（`SystemOps / 24h / メモリ / ディスク / 実行中`、390px で各69px）
- 「24h」タイルはボタン。タップで使用量シート（合計・キャッシュ率・モデル別・コスト上位5件）

### 実測（390×844 / :8444）

```
状態: SystemOps=Clean / 24h=$1.78 / メモリ=67.6% / ディスク=25.9% / 実行中=0
      タイル幅 69px ×5、はみ出しなし
シート: コスト $1.78 / 入力 2.19M / 出力 981.5k / キャッシュ読取 288.20M（99.2%）
        API呼び出し 1,292 / セッション 16件・1382msg・tool 726
        モデル別 deepseek-flash $2.09（in 2.83M / out 1.15M / cache 324.70M / 1608 calls）
        コスト上位: discord $1.43 → kanban $0.122 → tui $0.098
API: 16 セッション・$1.778・cache 99.2%・1285 calls（1回目）→ 292/1,382（再取得時）
```
