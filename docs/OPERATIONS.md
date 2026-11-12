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

## ワンタップ一時停止（2026-10-23 追加 / PLAN-V3 の D）

「まず止めたい」ための操作。既存の drain / restart / stop とは意味が違う。

| 操作 | 実行中のターン | 主な用途 |
| --- | --- | --- |
| **pause（これ）** | **完走する** | 新規の受付だけ止めたい |
| drain | 完走する | 新しいターンを止める（gateway は動かしたまま） |
| restart | 完走を待ってから再起動 | 反映・再起動 |
| stop | 途中でも切る | 強制停止 |

### サーバ

- `POST /api/gateway/pause {confirm:"PAUSE", reason}` → `hermes pause --reason …` を実行
- `POST /api/gateway/resume {confirm:"RESUME"}` → `hermes resume`
- センチネルは **`~/.hermes/ESTOP`**（JSON `{engaged_at, reason}`）。ブリッジは**読むだけ**で、書き込みは必ず CLI に任せる
- `GET /api/overview` に `paused: {engaged, reason, engagedAt}` を同梱（全タブで状態が見える）
- 確認語が無い/違う場合は 400。書き込みレート枠＋監査（`gateway.pause` / `gateway.resume`）

### UI

- 一時停止中は**タスクタブ上部に黄色のバナー**（理由つき）＋「再開」ボタン
- 緊急操作シートの先頭に状態カード。未停止なら「一時停止（新規のみ）」を**長押し1.5秒**、停止中なら「再開する（ESTOP 解除）」の1タップ
- 解除は安全方向なので確認語を要求しない（押し間違いの実害が「止め続ける」だけ）

### 実測（390×844 / :8444）

```
誤った確認語 → 400
pause → ok:true / state.engaged:true / reason:"mobile test"
        ~/.hermes/ESTOP = {"engaged_at":"2026-10-22T19:52:46.768707+00:00","reason":"mobile test"}
overview.paused → 同じ内容
resume → ok:true / state.engaged:false / ESTOP 消滅（ls で確認）
UI: 長押し → バナー「一時停止中（新規の受付を止めています ・ mobile）」＋再開ボタン（45×25px・1行）
    シート内も「再開する（ESTOP 解除）」に切替 → 押下でバナー消滅・ESTOP 削除を確認
```

## ライブ進捗（2026-10-23 追加 / PLAN-V3 の E）

「Discord で投げた依頼が今どこまで進んだか」を1画面で見る。書き込みはしない。

### サーバ

- `GET /api/live` … 5秒ポーリング前提。読取レート枠（240/分）を共有
- 実行中ターン: `state.db` の **`session_turn_leases`**（本体が張るリース）を読む。
  列は `conversation_id / holder / acquired_at / expires_at`。`holder` から `platform=discord` を取り出す
- 最後のツール: `messages` の直近 `tool_name`（そのセッション）
- 実行中タスク: 既存 `kanban` モジュールで `status='running'` を横断収集
- Discord 由来のターンにはスレッドURLを付加

### UI

- 状態ストリップの **「稼働」タイル**（= 実行中タスク + 実行中ターン）。実行中ターンがあると黄色の点が点滅
- タップで **ライブシート**（5秒更新）。実行中ターン（platform・経過・最後のツール・リース残・Discordリンク）と実行中タスク（ボード・経過・pid）
- 実行中タスクがあるときは「実行中タスク N 件を中断」を**長押し1.5秒**（reclaim → block）

### 実測（390×844 / :8444）

```
GET /api/live:
  turns[0] = { sessionId: 20261022_163552_3305cfe1, title: "DeepSeek Harness 向け Android Web UI 実装方針",
               platform: "discord", elapsedSec: 60, expiresInSec: 300,
               lastTool: { name: "terminal", at: … }, discordUrl: … }
  counts = { turns: 1, tasks: 0 }

UI: タイル「稼働=1」＋点滅ドット
    シート: 実行中ターン 1 / 実行中タスク 0
      "DeepSeek Harness 向け Android Web UI 実装方針" ・ discord ・ 1m38s ・ tool: terminal
      最終ツール 12秒前 ・ リース残 4m22s ・ # リンク
      タスク: 「実行中のタスクはありません」
```

## 承認待ちインボックス（2026-10-23 追加 / PLAN-V3 の F）

エージェントが「これ進めていい？」と止まっているタスクを、ボード横断で読んで**コメントで答える**画面。
2026-11-12 から **不要な項目は「片付ける」で閉じられる**（完了 / 取消）。再開・アサインは従来どおり
Discord / ダッシュボード。

### サーバ

- `GET /api/inbox` → `{ok, at, items[], counts{kind: n}}`
  - 対象: 全ボード（アーカイブ除く）の `status='blocked'`
  - 1件ごとに `block_kind`（needs_input / failure / dependency / untyped）、`block_recurrences`、
    `last_failure_error`、**直近の `blocked` イベントの payload.message** を理由として採用、
    直近コメント（`task_comments`）
- `POST /api/boards/:slug/tasks/:id/comment {body}` → `hermes kanban --board … comment <id> <body> --author mobile`
  - 本文は 1〜2000 字（空は 400）、タスクIDは `t_[0-9a-z]+` のみ、書込レート枠、監査 `kanban.comment`
- `POST /api/boards/:slug/tasks/:id/close {action, note}` — **判断待ちを閉じる**（2026-11-12 追加）
  - `action: "done"` → `hermes kanban complete <id> --result <note|既定文言> --metadata {"closed_from":"mobile",…}`
  - `action: "cancel"` → `hermes kanban comment <id> "PWAから取消（アーカイブ）: <note>" --author mobile` → `hermes kanban archive <id>`
  - 既に `done` / `archived` なら **CLI を呼ばず `noop:true`**（連打しても二重に閉じない）
  - `action` は done/cancel のみ（他は 400）、存在しないタスクは 404、CLI 失敗は 502、監査 `kanban.close`

### UI

- 承認待ちが1件以上あるときだけ、タスクタブ上部に**黄色いバー**（`承認待ち N 件 / 回答する ›`）
- シート: タスク名・ボード・種別・再発回数・経過・理由（質問文）・直前のコメント・返信欄
- 返信は 2000 字まで。送信後は 15 秒ポーリングで一覧を取り直す
- 各カードの下に**「この判断待ちを片付ける」**。押すと `完了にする` / `取消（アーカイブ）` が出る。
  どちらも**長押し1.5秒で確定**（`HoldButton`）。理由は上の返信欄に書いた文がそのまま使われる
- 同じ `CloseActions` を赤ペンタブの判断待ちシート・注釈エディタの末尾にも置く

### 実測（390×844 / :8444）

```
検証用に blocked タスクを作成（block --kind needs_input ＋ hermes からのコメント）
GET /api/inbox → items 1 / counts {needs_input: 1}
  reason: "本番デプロイの可否を確認してください" / lastComment: "検証: エージェントからの質問です"
POST comment {"body":"モバイルから承認します。反映してください。"} → ok:true
空コメント → 400 / 監査 kanban.comment {board, task, chars:21}
UI: バー「承認待ち 1 件 / 回答する ›」→ シート
  「inbox-probe: 本番反映の可否」「hermes-mobile-pwa ・ 回答待ち ・ 再発1 ・ 18秒前」
  理由・直前コメント表示 → 返信「UIから: 承認します。反映OK。」送信 → 3秒前のコメントとして反映・入力欄クリア
アーカイブ後 → items 0（バーも消える）。コメント4件は DB に残存
```

### 実測: 片付け（2026-11-12・本番ブリッジ :4097）

```
POST /api/boards/hermes-mobile-pwa/tasks/<probe>/close {"action":"cancel","note":"endpoint probe"}
  → {ok:true, action:"cancel", status:"archived", changed:true}
再送（同じ action） → {ok:true, status:"archived", noop:true}   # CLI は呼ばれない
{"action":"delete"} → 400「action は done か cancel を指定してください」
tasks/..%2F..%2Fetc/close → 400「タスクIDが不正です」
{"action":"done"} → status:"done" / task.result = "判断不要だった"
UI（390×844）: 承認待ちシートのカード下「この判断待ちを片付ける」→ 完了にする / 取消（アーカイブ）
  長押し1.5秒 → トースト「取消（アーカイブ）しました」→ カードが一覧から消える
  赤ペンタブの注釈エディタ末尾でも同じ操作 → 「完了にしました」→ 判断待ち 0 件
監査: ~/.hermes/mobile-pwa/audit.jsonl に kanban.close {board, task, action, status, noop}
```

## アイコン（マスカブル対応 / 2026-10-23 修正）

### 原因

旧アイコンは**画像自体に白い余白**があり（角丸タイルの外側が白）、さらに `any` 用アイコンの四隅が
**透明**だった。HyperOS などがスキール（角丸）マスクを掛けると、その白／透明部分が
アプリの縁の白い枠として残っていた。

### 方針（フルブリード）

`scripts/make-icons.py`（外部依存なし）で**四隅まで背景色で塗り切る**アイコンを生成する。

- 背景: `#0b2f36 → #06161a` の縦グラデーション＋中央の淡いグロー
- 図柄: ブランドの「H」（`#46e0c8`）を角丸バー3本で描画。4倍スーパーサンプリングでアンチエイリアス
- 全ピクセル **alpha=255**（透明の縁を作らない＝白枠が出ない）

| ファイル | 用途 | 図柄の占有率 | 図柄の最大半径 |
| --- | --- | --- | --- |
| `icon-192.png` / `icon-512.png` | `any` | 幅 55% | 0.357（安全円 0.400 内） |
| `icon-maskable-192.png` / `icon-maskable-512.png` | `any maskable` | 幅 45% | **0.293**（安全円 0.400 内） |
| `icon-180.png` | apple-touch-icon | 幅 56% | — |

- 再生成: `python3 scripts/make-icons.py`（45秒）
- `icon.svg`（タブ用 favicon）も同じ比率でフルブリードに更新

### マニフェスト

```json
"icons": [
  { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
  { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
  { "src": "/icon-maskable-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
  { "src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
]
```

`any maskable` を付けるのは、**マスカブル用アートが両用途を満たしている**場合だけ。
`any` 用（図柄が大きい）に `maskable` を併記すると、円形マスクで図柄の端が切られる。

### Service Worker

アイコンのファイル名は固定（ハッシュ無し）で、SW はアセットを cache-first で返す。
**アイコンを差し替えたら `sw.js` の `CACHE` を必ず上げる**（今回 `v2 → v3`、SHELL にマスカブル2種を追加）。

### 実測（:8444）

```
manifest: Chrome のパーサで errors: [] / installabilityErrors: []
icons 解釈: any(192,512) + "any maskable"(192,512)
配信: icon-192 200 6,615B / icon-512 200 17,355B / icon-maskable-192 200 6,908B
      icon-maskable-512 200 17,555B / icon-180 200 6,217B / icon.svg 200 866B
画素検査: 全ファイルで四隅 rgba(11,47,54,255)・alpha 最小 255（透明なし）
        maskable の図柄最大半径 0.293（安全円 0.400）→ 円形/スクワークルで切れない
スクワークル（超楕円 n=4）でマスクした合成プレビューで白枠なし・図柄欠けなしを目視確認
```

### 端末側の注意

ホーム画面のアイコンは**インストール時に WebAPK へ焼き込まれる**。差し替えを反映するには
一度アンインストールして追加し直す（アプリ内のキャッシュだけでは変わらない）。

### 追記: 再インストールしても白枠が残った原因（2026-10-23 修正）

前項のアイコン差し替え後も端末に白枠が残った。原因は**配信ヘッダとキャッシュ**。

正常に動いていた DSH アプリとの違い:

| | DSH（正常） | Hermes Mobile（旧・不具合） |
| --- | --- | --- |
| `manifest.webmanifest` | `cache-control: no-cache` | **`public, max-age=604800, immutable`** |
| アイコンのURL | 固定名 | 固定名（**同じ**） |
| アイコンのヘッダ | `max-age=31536000, immutable` | `max-age=604800, immutable` |

つまり**マニフェストまで7日 immutable で返していた**ため、再インストール時も Chrome は
キャッシュ済みの古いマニフェスト＋古いアイコン（＝白枠つきの絵）を使い続けていた。

### 修正内容

1. **アイコンのファイル名をバージョン付きに変更**（`icon-512.png` → `icon-512-v2.png` 等 5 種）
   → URL が変わるので HTTP キャッシュ・WebAPK のアイコン記録のどちらも一致しない。旧URLは 404
2. **キャッシュ方針を DSH と同じに**（`apps/bridge/src/server.js`）
   - `.webmanifest` / `.json` / `.html` → `no-cache`
   - 固定名アセット（アイコン・SVG 等） → `public, max-age=3600, must-revalidate`
   - `/assets/`（ハッシュ付き）だけ `max-age=31536000, immutable`
3. `index.html` の `apple-touch-icon` も `icon-180-v2.png` に更新
4. Service Worker: `CACHE` を `v3 → v4`、SHELL を新URLに

### 今後のルール

- **`manifest.webmanifest` は絶対に immutable で返さない**（インストール時のアイコン解決に使われる）
- アイコンを差し替えたら **ファイル名のバージョンを上げる**（`-v3`, `-v4`…）。ヘッダだけでは
  端末側の WebAPK キャッシュを確実には更新できない
- `sw.js` の `CACHE` も同時に上げる

### 実測（:8444）

```
manifest: cache-control: no-cache / content-type: application/manifest+json
icons  : cache-control: public, max-age=3600, must-revalidate
配信バイト: 5ファイルすべて sha256 がディスクと一致（旧パスは 404）
Chrome パーサ: errors: [] / installabilityErrors: []
icons 解釈: /icon-192-v2.png(any) /icon-512-v2.png(any)
            /icon-maskable-192-v2.png(any maskable) /icon-maskable-512-v2.png(any maskable)
SW: caches.keys() = ['hermes-mobile-v4']
```

### 追記2: 根治（DSH との仕様差を合わせる / 2026-10-23）

再インストールしても白枠が残る件を、公式ドキュメントの記述から特定した。

> Android では、マスカブル形式に**対応していないアイコンは白い背景の上に配置される**
> （web.dev "Adaptive icon support in PWAs with maskable icons" / MDN "Define app icons"）

つまり白枠＝**Chrome がこのアイコンを「マスカブルでない」と判定した**結果であり、
画像の見た目やキャッシュの問題ではなかった。

#### DSH（正常）との差

| | DSH | 旧 Hermes Mobile |
| --- | --- | --- |
| maskable の purpose | `"maskable"`（単独） | **`"any maskable"`（併記）** |
| `any` アイコン | 不透明フルブリード | 不透明フルブリード |
| SVG アイコン | manifest に記載 | 記載なし |
| `display_override` | あり | なし |
| `theme_color` / `background_color` | 同一色 | 別色 |

web.dev は「`any maskable` の併記は非推奨（同じビットマップが両用途に使われ、余白が過剰/不足になる）」と明記しており、
DSH と同じ**単独 `maskable` + 別ファイル**に揃えた。

#### 併せて見つけた不具合

`/icon.svg` が認証必須のままで **401** を返していた（`isPublicPath` の正規表現が `icon-*.svg` しか許可していなかった）。
manifest に載っているアイコンが 401 を返す状態だったので、`/icon.svg` も公開に修正。

#### 変更内容

1. `purpose` を **`"maskable"` 単独**に（192 / 512）。`any` は別エントリ（192 / 512）
2. **`any` アイコンは透明背景のグリフ**に変更（ファビコン流）。万一マスカブルが使われなくても
   「暗いタイル＋白枠」にはならず、白背景に図柄だけが載る
3. maskable は**不透明フルブリード**（図柄は中心半径 0.293 < 安全域 0.400）
4. manifest に SVG アイコン・`display_override` を追加、`theme_color = background_color = #06161a`
5. **`id` を `/` → `/hermes-mobile` に変更**。WebAPK の識別子が変わるため、
   ランチャー側のアイコンキャッシュを確実に迂回して新規生成させる（今回の1回限りの措置）
6. アイコンは `-v3` に、SW は `v5` に更新
7. **設定タブに「起動元」を追加**: `WebAPK（org.chromium.webapk.…）` か `ブラウザ` かを表示。
   WebAPK でなくショートカットとして追加されている場合は、そもそもアイコン生成経路が違う

#### 実測（:8444）

```
manifest: id=/hermes-mobile / errors:[] / installabilityErrors:[]
icons: /icon-192-v3.png(any) /icon-512-v3.png(any)
       /icon-maskable-192-v3.png(maskable) /icon-maskable-512-v3.png(maskable) /icon.svg(none)
認証なしでも全て 200（icon.svg の 401 を修正）
画素: any = 四隅 alpha 0（透明グリフ 60%）/ maskable = 四隅 rgba(11,47,54,255)・alpha 最小 255
SW: caches.keys() = ['hermes-mobile-v5']
```

### 追記3: 画像の作りを DSH と同一に（単色ベタ）+ 起動形態の診断（2026-10-23）

ユーザーの指摘どおり、**画像の作りに差があった**。

| | DSH（白枠なし） | 旧 Hermes Mobile |
| --- | --- | --- |
| 背景 | **単色ベタ** `#08161a` | **グラデーション** `#0b2f36 → #06161a` |
| 光沢 | なし | **中央に淡いグロー** |
| 図柄 | 約40% | 約45〜55%（影付き） |

OS がアイコンを前景/背景レイヤーに分けて合成する場合、グラデーションの前景には
**矩形の境目**が出る。DSH は `background_color` と同じ単色なので境目が原理的に出ない。

#### 修正

- 背景を **単色 `#06161a`（theme_color / background_color と同値）** に。グロー・グラデーションを廃止
- 図柄を DSH 並みに縮小（maskable は中心半径 0.265 < 安全域 0.400）
- `icon.svg`（favicon）も同色の単色ベタに統一
- アイコンは `-v4`、SW は `v6`

#### 起動形態の診断（重要）

設定タブの「起動元」で、端末が **WebAPK かどうか**が分かる。
WebAPK は `document.referrer` が `android-app://org.chromium.webapk.…` になる。
実機の報告は **「スタンドアロン・referrer なし」** ＝ WebAPK ではなく
Chrome の「ホーム画面に追加」による**ショートカット**として入っている可能性が高い。

ショートカットのアイコンは Android がレガシーアイコンとして扱い、**白いカードの上に置く**。
これが白枠の正体で、manifest のアイコンをいくら直しても変わらない。
→ Chrome のメニューで「**アプリをインストール**」を選ぶ（「ホーム画面に追加」ではない）必要がある。

#### 実測（:8444）

```
manifest: id=/hermes-mobile / errors:[] / installabilityErrors:[]
icons: any(192,512) + maskable(192,512) + svg
配信: v4 5ファイル + icon.svg すべて 200
画素: maskable 四隅 (6,22,26,255)・単色判定=True・alpha最小255・図柄半径0.265
      any は四隅 alpha 0（透明グリフ）
SW: ['hermes-mobile-v6']
```

### 追記3: 画像の作りを DSH と同一に（単色ベタ）+ 起動形態の診断（2026-10-23）

ユーザーの指摘どおり、**画像の作りに差があった**。

| | DSH（白枠なし） | 旧 Hermes Mobile |
| --- | --- | --- |
| 背景 | **単色ベタ** `#08161a` | **グラデーション** `#0b2f36 → #06161a` |
| 光沢 | なし | **中央に淡いグロー** |
| 図柄 | 約40% | 約45〜55%（影付き） |

OS がアイコンを前景/背景レイヤーに分けて合成する場合、グラデーションの前景には
**矩形の境目**が出る。DSH は `background_color` と同じ単色なので境目が原理的に出ない。

#### 修正

- 背景を **単色 `#06161a`（theme_color / background_color と同値）** に。グロー・グラデーションを廃止
- 図柄を DSH 並みに縮小（maskable は中心半径 0.265 < 安全域 0.400）
- `icon.svg`（favicon）も同色の単色ベタに統一
- アイコンは `-v4`、SW は `v6`

#### 起動形態の診断（重要）

設定タブの「起動元」で、端末が **WebAPK かどうか**が分かる。
WebAPK は `document.referrer` が `android-app://org.chromium.webapk.…` になる。
実機の報告は **「スタンドアロン・referrer なし」** ＝ WebAPK ではなく
Chrome の「ホーム画面に追加」による**ショートカット**として入っている可能性が高い。

ショートカットのアイコンは Android がレガシーアイコンとして扱い、**白いカードの上に置く**。
これが白枠の正体で、manifest のアイコンをいくら直しても変わらない。
→ Chrome のメニューで「**アプリをインストール**」を選ぶ（「ホーム画面に追加」ではない）必要がある。

#### 実測（:8444）

```
manifest: id=/hermes-mobile / errors:[] / installabilityErrors:[]
icons: any(192,512) + maskable(192,512) + svg
配信: v4 5ファイル + icon.svg すべて 200
画素: maskable 四隅 (6,22,26,255)・単色判定=True・alpha最小255・図柄半径0.265
      any は四隅 alpha 0（透明グリフ）
SW: ['hermes-mobile-v6']
```

### 追記4: 白枠の真因（スクリーンショットで確定 / 2026-10-23）

実機のスクリーンショットを拡大した結果、**表示されているアイコンは `/icon.svg`（favicon）そのもの**だった。

旧 `icon.svg`:

```svg
<rect x="24" y="24" width="464" height="464" rx="96" fill="#0a262c"/>   <!-- 内側に角丸四角 -->
<rect x="24" y="300" width="464" height="188" rx="96" fill="#0d5a57"/>  <!-- 下部の青緑の塊 -->
```

周囲 **24px が透明**で、その中に角丸四角を描いていた。ランチャーはこの透明部分から
**白いカードを透かして**描くため、白枠に見えていた。
スクショの「下部の青緑の塊」まで一致しており、画像の同一性は確定。

DSH の `icon.svg` は `<rect width="512" height="512" fill="#08161a"/>` の**全面ベタ**なので枠が出ない。
これが「DSH では起きない」理由。

#### 教訓

- ホーム画面のアイコンの実体は、WebAPK でない場合は **favicon (`/icon.svg`)** になる。
  manifest の PNG だけ直しても意味がない。
- **Chrome の favicon キャッシュは「サイトデータ削除」では消えない**（グローバルな favicon DB）。
  そのため favicon を差し替えるときは **URL を変える**（`/icon.svg` → `/icon-v5.svg`）。
- アイコンは**外周1pxまで不透明**にすること。透明マージンは白枠になる。
- manifest の `any` アイコンも透明にしない（レガシー経路で白が出る）。全エントリ不透明＋全面ベタ。

#### 変更

- `icon-v5.svg`（余白ゼロ・全面 `#06161a`・透明画素ゼロ）
- `icon-*-v5.png` 5枚（すべて不透明・全面ベタ・外周透明画素0）
- manifest の icons を v5 に、`icon.svg` は削除（404）
- index.html の `rel="icon"` / `apple-touch-icon` を v5 に
- SW `CACHE` を v7 に

#### 実測

```
配信: manifest / icon-v5.svg / icon-*-v5.png(5枚) = 200、旧 /icon.svg = 404
画素: 4枚すべて 四隅 (6,22,26,255)・外周透明画素 0・単色
比較画像: docs/assets/icon-frame-compare.png（左=旧=白枠 / 右=新=枠なし）
```

### 追記5: chrome://webapks で判明した本当の構造（2026-10-23）

実機の `chrome://webapks` を読んだ結果:

```
Hermes Mobile
  Package name: org.chromium.webapk.aa61a1e4a30ad803f_v2
  Shell APK version: 194
  URL / Scope / Start URL: https://<host>:8444/
  Manifest Id: https://<host>:8444//          ← 旧 id「/」のまま
  Display Mode: standalone
  Last Update Check Time: 2026-10-23 12:56    ← チェックは走っている
  Last Update Completion Time: 1970-01-01     ← 更新は一度も完了していない
```

つまり:

1. **アプリは WebAPK として実在する**（ショートカットではない）
2. **WebAPK の更新が一度も完了していない**（Completion=1970）。だからアイコンが永久に初回のまま
3. インストール済みパッケージの Manifest Id は **`/`**。こちらが `id` を `/app/hm4` に変えたため
   **id が食い違い、`This site cannot be installed` になった**

#### 学び（重要）

- **WebAPK の同一性は scope で決まる**。`id` を変えても別アプリにはならず、
  既存 WebAPK と衝突してインストール不能になる。**`id` は触らない**
- アイコンを更新する唯一の確実な方法は **WebAPK を完全に削除して作り直す**こと。
  「アプリを削除 → chrome://webapks を再読込してエントリが消えたことを確認 → 再インストール」
  までやらないと、古いパッケージが再利用されてアイコンは変わらない
- `Last Update Completion Time` が 1970 のままなら、更新経路は機能していないと判断してよい

#### 現在の manifest（確定）

```
id = / （start_url と同じ。変えない）
icons = any192 / any512 / maskable512 / svg（すべて不透明・全面ベタ・v5）
```

### 追記6: 端末側でインストール可否を可視化（2026-10-23）

`This site cannot be installed` の切り分けのため、`beforeinstallprompt` を拾って
設定タブに **インストール可否 / Service Worker の状態 / 実行ボタン** を出すようにした。

- Chrome は「インストール可能」と判断したときだけ `beforeinstallprompt` を発火する。
  発火しなければ manifest・アイコン・SW のどれかが要件を満たしていない
- 発火していれば **「アプリとしてインストール」ボタンから直接 `prompt()` を呼べる**
  （メニュー経由の失敗を回避できる）
- **`/favicon.ico` を用意した**（404 を1つ減らす。32px を ICO に包んだだけ）

#### 端末のアクセスログから分かったこと

`05:03` / `05:08` に Android から **`/icon-192.png`・`/icon-maskable-512.png`・`/favicon.ico`** への
リクエストがあった。これらは**削除済みの旧ファイル名**（現在 404）。
つまり Chrome は**どこかに古い manifest を保持したまま**アイコンを取りに来ている。
（`manifest.webmanifest` 自体は `no-cache` で返しており、SW の SHELL からも外した）

インストールは Chrome が保持している manifest で判定されるため、
**キャッシュ削除 → タブを閉じる → 開き直す → 設定タブで「インストール可否」を確認**が最短の切り分け。

### 追記7: 端末側の診断結果 — ページ要件は全項目クリア（2026-10-23）

設定タブの「PWA 診断」を実機（Android Chrome）で実行し、結果を `client-errors.log` に受信した。

```
✓ manifest の link / 取得 (200 application/manifest+json) / JSON
✓ name / short_name
✓ start_url = https://<host>:8444/
✓ scope     = https://<host>:8444/
✓ id        = https://<host>:8444/
✓ start_url が scope 内 / id が同一オリジン
✓ display = standalone
✓ icons 4件 — icon-192-v5(192x192) / icon-512-v5(512x512) / icon-maskable-512-v5(512x512 maskable) / icon-v5.svg
✓ 192px 以上の any / 512px 以上の any / maskable あり
✓ Service Worker 制御 / scope カバー
```

**端末上でも Chrome のインストール要件はすべて満たしている。**
それでも `beforeinstallprompt` が発火せず（＝インストール不可）、メニューからは
`This site cannot be installed` になる。したがって原因は **ページ側ではなく Chrome の
WebAPK インストール基盤（Google Play Services 側）** にある。

傍証: 以前の WebAPK は `Last Update Completion Time = 1970-01-01`（更新が一度も成功していない）。

#### 実務的な結論

- アイコンの白枠は**画像側で解決済み**（全面ベタ・不透明・透明画素0）
- WebAPK として入れる経路が壊れているので、**「ホーム画面に追加」（ショートカット）**で入れる。
  ショートカットのアイコンは favicon（= 全面ベタの `/icon-v5.svg`）なので白枠は出ない。
  dsh / ダッシュボードと同じ見え方になる
- WebAPK を復旧したい場合は端末再起動 → 再インストール、それでも駄目なら
  Android 設定 → アプリ に残存 WebAPK パッケージが無いか確認

### 追記8: 解決と再発防止（2026-10-23）

**端末を再起動したらインストールできるようになり、アイコンも白枠なしで確定した。**
初回インストール直後はホーム画面にアイコンが出ず、Chrome を再読込してから PWA として
認識された（WebAPK の生成完了が遅延するため）。

再発防止として以下を追加した。

| 追加物 | 内容 |
| --- | --- |
| `scripts/check-pwa.py` | manifest / アイコン / SW / 未認証公開を一括検査。`--self-test` 付き |
| `npm run check:pwa` | ローカル `public/` を検査（0.08 秒） |
| `npm run check:pwa:live` | 公開 URL を未認証で取得して検査 |
| `npm run check:pwa:selftest` | 検出器が過去の白枠を拾えるか確認 |
| `npm run verify` | `test` + `check:pwa` + `build`（デプロイ前の必須コマンド） |
| `docs/PITFALLS.md` | P1〜P6 の症状・原因・検出・対策 |

検査項目: manifest の必須項目 / start_url ⊂ scope / id 同一オリジン / display /
**アイコンの実ピクセルと宣言サイズの一致** / any192・any512・maskable の存在 /
**外周1pxの透明画素 0** / **SVG が全面ベタ** / **背景が単色** / **図柄半径 ≤0.40** /
シェルが未認証で 200 / manifest が immutable でない / SW に fetch ハンドラ。

実測: `--dir` 30 項目合格、`--url` 32 項目合格、`--self-test` 3 項目合格、`npm test` 81 pass。

### 追記9: ボードチップの並び順と選択の保持（2026-10-23）

**並び順**: 旧実装は「current ボード → 非アーカイブ → 実行中 → 名前順」で、規則が見えなかった。
**最終活動の新しい順**（`tasks` の `COALESCE(completed_at, started_at, created_at)` の最大）に変更。
`current` は同着時の優先に降格（先頭固定だと並び順の意味が消えるため）。
アーカイブは常に末尾。`lastActivityAt`（epoch 秒）を `/api/boards` が返す。

**選択の保持**: TasksPane はタブ切替でアンマウントされるため、毎回 `~/.hermes/kanban/current`
のボードに戻っていた（実測で確認）。`localStorage['hm.board']` に保存し、再読込・アプリ再起動でも
直前に見ていたボードを復元する。保存値が消えた板なら current → 非アーカイブ → 先頭の順に落とす。

実測（390×844）:
```
並び: hermes-mobile-pwa(13:49) → dsh-web-ui(03:44) → nanokvm-dev-env → … → git-ops
選択: NanoKVM 開発環境構築 → チャット → タスク → 復元、再読込後も復元（localStorage=nanokvm-dev-env）
npm test 82 pass（boards-order.test.js 追加）
```

### 追記10: ボード選択シート（PLAN-V4 の A 案を実装 / 2026-10-23）

チップ列の左端に **30px の「▾」** を置き、押すと全ボードのシートが出る。
帯の高さは増やさず（**38px のまま**）、タスク一覧も **670px のまま**。

- 行は**1行構成**（アイコン / 名前 / 実行中・停止・保管・最終活動 / 選択中は ✓）。
  2行にすると 9 件でシート内スクロールが必要になったため（実測: 2行=692px でスクロール発生、
  1行=514px で **9件が収まる**）
- 選択すると閉じてチャット側と同じ `hm.board` に保存（タブ往復・再読込でも維持）
- シートは既存の `Sheet` + `.list-item` を再利用（新しい見た目を増やさない）
- `.list-item.on` を追加（選択中の行だけ accent 枠）

実測（390×844 / 820×1180）:
```
phone : chipRow 38px / task list 670px / ▾ 30px / 横スクロールなし / シート9件 fits=True (body 514px)
tablet: chipRow 38px / チップ表示幅 760px（スマホは366px） / 横スクロールなし
```

## チャット一覧のプロファイル横断（2026-10-24）

- 背景: タスクタブは全ボード横断だが、チャットタブは `session.list`（WS/JSON-RPC）が既定プロファイル固定のため、Default の会話しか出ていなかった。
- 対応: ブリッジの `GET /api/sessions` が `/api/profiles` で列挙し、各プロファイルへ `?profile=<name>` を付けて取得して合成（`profile` タグ付き・lastActive 降順）。トランスクリプトは `GET /api/sessions/:id/transcript?profile=<name>` でそのプロファイルの `state.db` を読む。
- PWA: ドロワーは `/api/sessions` を優先（失敗時のみ従来の RPC）。Default 以外の会話は読み取り専用で開き、バナーにプロファイル名を出す。
- **方針（決定 2026-10-24 / 2026-11-12 に改定）**: 旧「閲覧は全プロファイル／返信は既定プロファイルのみ」は
  **廃止**。`docs/SPEC-PROFILE-CHAT.md` の決定により **3 プロファイルすべてで送信可**（新規は「＋」→ プロファイル選択、
  一覧チップ＋ヘッダー常設で見分ける）。旧決定の理由は「PWA を複雑化させない」で、技術的制約ではなかった
  （実測: `/api/ws` の `session.list/create/resume` は `profile` を受ける）。

