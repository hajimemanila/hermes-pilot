# SPEC: Hermes Pilot v3 (`SPEC-PILOT-V3`) — バッジ同期整合・チャット履歴/Markdown強化・設定＆標準Web UI刷新仕様書

状態: **仕様確定（2026-11-14 監査 ＆ Q&A D16〜D19 合意済み）**
前提仕様: [SPEC-PILOT-V2.md](./SPEC-PILOT-V2.md)（Batch P1〜P5 完走済み）
想定実装ランナー: **Hermes Agent / DeepSeek V4.1 Flash**（Batch V3-1 〜 V3-5 カンバン自走 ＋ 実機相当検証）

> **注意（プロジェクト制約）**:
> - `apps/web/src/` 配下では `apps/web/test/noHardcodedJapanese.test.js` により JSX/JS への生日本語リテラル記述が禁止されている。UI 文言は必ず `apps/web/src/i18n/en.json`・`ja.json` に定義し `t(...)` 経由で参照すること。
> - 一方、`apps/dashboard/index.js`（標準 Hermes ダッシュボード用プラグイン）はバンドラ無しの単一 IIFE 構成であり、同ファイル内の `STRINGS.en` / `STRINGS.ja` オブジェクトに文言を保持する。
> - `apps/bridge/src/specs.js`（Spec Launchpad）がカンバンバッチとして誤認しないよう、バッチ以外の `###` 見出しは必ず数字で始めること（バッチ見出しのみ `### Batch V3-x:`）。

---

## 1. 実機使用 ＆ コード監査レポート（違和感の根本原因）

実機運用（PWA 公開版 v0.1.0）での違和感およびソースコード精査により、以下の 8 つの根本原因を特定した。

| # | 箇所 (`file:line`) | 現象・根本原因 |
|---|---|---|
| **I1** | `apps/web/src/App.jsx:374-382` | **OS アプリアイコンバッジの不整合**<br>`navigator.setAppBadge(overview?.runningTasks ?? 0)` が「実行中カンバンタスク数」をそのまま出しているため、Review や Inbox にユーザーの判断待ちがあっても OS バッジが `0` のままになる（逆にバックグラウンド稼働中だけ数値が残る）。 |
| **I2** | `apps/web/src/App.jsx:210-264, 386-511` | **スリープ復帰・タブ切替時のバッジ更新ラグ（最大 15 秒）**<br>`/api/overview` には `visibilitychange` リスナーがある（`:364-365`）が、`/api/review`・`/api/review/feed`・`/api/inbox`・`/api/review/chat-reports`・`/api/live` には `visibilitychange` / `focus` / タブ切替時の即時同期トリガーが無い。 |
| **I3** | `apps/web/src/features/ChatPane.jsx:568-571, 1014-1074, 2026` | **Quick Review ワーカーチャット閲覧時のドロワーアクティブ不整合 ＆ 親チャット情報リーク**<br>① `openSession` (`:1060-1067`) で `local-...` 等のワーカーチャットを開くと `resumeInto` が code `4132`（Kanban worker transcript）で拒否され `storedSid` を更新しないまま `loadTranscript` (`:1014-1046`) へフォールバックする。<br>② `loadTranscript` は `setSid(null)` + `setReadonly({ sessionId, ... })` を行うが `storedSid` に**起票元の親チャット ID が残る**。<br>③ ドロワー行のハイライト（`:2026`）が `s.id === storedSid` のみを見るため親チャットが選択状態に見え、さらに `currentIds`（`:569` `[storedSid, sid, readonly?.sessionId]`）に親チャットが混ざるため親の `linkedReview` バナーや完了報告まで表示される。 |
| **I4** | `apps/web/src/features/ChatPane.jsx:1236-1246, 2019-2044` | **チャット履歴ドロワーの未読視認性不足**<br>完了報告の未読（`unreadIds`）があってもヘッダの `≡` ボタンは小さな緑点のみで、個別セッションへの返信新着（`message_count` 増分）や実行中（`is_active`）インジケータ、未読件数バッジが視覚的に分かりにくい。 |
| **I5** | `apps/bridge/src/transcript.js:27, 51-73`<br>`apps/web/src/features/ChatPane.jsx:322, 1018` | **ツール多用セッションで履歴が 2〜3 ターンしか見えない**<br>`transcript.js` が `user` / `assistant` / `tool` の全ロール合算で `LIMIT`（PWA 側指定 `limit=100` / サーバ上限 `300`）を適用しているため、1 ターンで 30 回ツールを呼ぶと 2〜3 ターン分で上限に達する。また `ChatPane.jsx` に `before=<id>` を使って過去の履歴を遡る「過去の履歴を読み込む」UI が無い。 |
| **I6** | `apps/bridge/src/transcript.js:50, 65-71`<br>`apps/web/src/lib/toolProgress.js:137-147`<br>`apps/web/src/features/ChatPane.jsx:1405, 1436` | **過去のツール折りたたみ行とライブ表示の不一致・JSON 断片露出・React Key 不安定**<br>① `transcript.js` の `SELECT` が `tool_name` のみを取得し、`assistant` 行の `tool_calls` および `tool` 行の `tool_call_id` を読んでいない。<br>② そのため `foldTranscriptMessages()`（`toolProgress.js:138-146`）がライブ時の `toolDetail(name, args)`（実行コマンド・ファイルパス）を使えず、ツール結果本文の先頭 1 行（`{"output": "...", "exit_code": 0}` 等の JSON 断片）を表示している。<br>③ `ChatPane.jsx:1405, 1436` が `key={i}` / `prefix={msg-${i}}`（配列添字）を使っており、履歴追加時に開閉状態（`expandedTools`）がズレる。 |
| **I7** | `apps/web/src/features/ChatPane.jsx:66-102` | **チャット本文の Markdown 非対応**<br>`renderFormattedText` が ```` ```code``` ```` フェンスブロックのみを分解し、見出し（`#`〜`###`）、太字（`**...**`）、インラインコード（`` `...` ``）、箇条書き・番号リスト、引用（`>`）、リンク（`[text](url)`）を平文のまま表示している。 |
| **I8** | `apps/web/src/features/SettingsPane.jsx:491-914`<br>`apps/dashboard/index.js` | **設定タブと標準 Web UI（`apps/dashboard`）のナビ・情報密度・言語切替の課題**<br>① `SettingsPane.jsx` にセクション間のショートカットナビが無く、カード（`.card`）と裸の要素が混在し、監査ログ（`:837`）が最大 80 件そのまま縦に展開されて下部設定（スニペット・About）へ到達しづらい。<br>② 標準 Web ダッシュボード（`apps/dashboard/index.js:1389`）は `detectLang()` でブラウザ言語を読むのみで手動の **EN / 日本語 切替 UI** が無く、`config.json` の `lang` とも同期していない。またセクション移動チップや監査ログ 8 件折りたたみも無い。 |

---

## 2. 合意決定表（Q&A D16〜D19）

| # | 論点 | 決定内容 |
|---|---|---|
| **D16** | チャット履歴ドロワーのフォーカス整合 ＆ 未読/進行中バッジ | ① 実際に表示中のセッション ID（`readonly?.sessionId \|\| sid \|\| storedSid`）をドロワーのアクティブ行として強調し、`readonly` 閲覧中は `currentIds` に親チャット `storedSid` を混ぜない。<br>② ドロワー内のセッション行に**未読バッジ**（完了報告の未読 `unreadReportCount` ＋ 返信新着 `NEW` ピル）と**実行中インジケータ**（青ドット `.row-dot.running`）を表示する。<br>③ チャットヘッダのドロワーボタン（`≡`）にも未読総数バッジ（`.drawer-btn-badge`）を出す。 |
| **D17** | バッジ更新タイミング ＆ OS アプリアイコンバッジ基準 | ① `navigator.setAppBadge` の値は `waitingTotal = reviewWaiting + inboxPending`（人間の対応・判断待ち合計）に統一し、`0` のときは `clearAppBadge()` する。<br>② `visibilitychange`（`visible` 復帰時）・`focus`・`online`・タブ切替時に、1.5 秒デバウンス付きで全バッジ API（`/api/overview`, `/api/review`, `/api/review/feed`, `/api/inbox`, `/api/review/chat-reports`）を即時並列同期する。 |
| **D18** | チャット履歴の表示改善（3 点フル対応） | ① **履歴取得量拡大 ＋ 過去履歴の段階読み込み**: 初回取得上限を引き上げ、上端に `↑ 過去の履歴を読み込む / ↑ Load older messages`（`before=<oldestId>`）を追加する。<br>② **ツール引数の復元 ＆ サマリ整形**: `state.db` の `tool_calls` / `tool_call_id` から引数を復元し、履歴展開時もライブ時と同じコマンド/パス表示を揃える＋JSON 結果のクリーン整形＋`b.mid` 安定キー化。<br>③ **軽量・安全 Markdown レンダラ**: 見出し・太字・インラインコード・リスト・引用・安全リンク（`http:` / `https:` / `mailto:` 限定）・コードブロックを XSS 安全に描画する。 |
| **D19** | 設定タブ ＆ 標準 Web UI（`apps/dashboard/*`）の UI/UX 改善 ＋ 多言語対応 | ① `SettingsPane.jsx` 上部に **ショートカットナビバー（6 セクション）** を配置し、**外観・端末 / ペアリング / スニペット / リポジトリ / 監査＆ログ / システム状態・診断** の 6 カードへ整理する。監査ログは **最新 8 件のみ既定表示** し、9 件目以降はアコーディオンで収納・展開する。<br>② **標準 Web ダッシュボード（`apps/dashboard/*`）** でも同じくショートカットナビとログ/監査 8 件折りたたみを導入し、ヘッダ＆設定欄に **EN / 日本語 言語切替スイッチ**（`config.json` `lang` ＆ `localStorage` 連動）を実装する。 |

---

## 3. 詳細技術仕様

### 3.1 チャット履歴ドロワー整合性 ＆ 未読/進行中バッジ（D16）

対象: `apps/web/src/features/ChatPane.jsx`, `apps/web/src/lib/chatReports.js`, `apps/web/src/lib/sessionUnread.js`（新規・純関数推奨）, `apps/web/src/styles.css`, `apps/web/src/i18n/{en,ja}.json`

1. **表示中セッションの隔離とハイライト（`ChatPane.jsx`）**:
   - `activeDrawerSid` を以下のように定義する:
     ```js
     const activeDrawerSid = readonly?.sessionId || sid || storedSid || null
     ```
   - `currentIds`（完了報告カード `reports` と `linkedReview` バナーの紐づけ対象）は **`readonly` 閲覧中に親チャットを混ぜない**よう切り離す:
     ```js
     const currentIds = useMemo(
       () => (readonly?.sessionId ? [String(readonly.sessionId)] : [storedSid, sid].filter(Boolean).map(String)),
       [readonly?.sessionId, storedSid, sid],
     )
     ```
   - ドロワーリスト（`:2026`）のアクティブ判定を `s.id === storedSid` から **`s.id === activeDrawerSid`** に変更する。
   - `readonly` 表示中の行には小さな `RO` / 閲覧専用タグ（`t('chat.readonlyShort')`）を添え、なぜ入力欄が非表示かを一覧上でも一目で分かるようにする。
   - **回帰防止**: 読み取り専用チャット（`local-...` 等）を閉じて新規チャットまたは通常チャットへ戻る導線として、`openSession` 自体は親の `storedSid` を破壊しない（別チャットを開いたときのみ `resumeInto` が `storedSid` を更新し、`loadTranscript` は `readonly` だけを切り替える）ため、リロード時は最後の通常会話へ復帰する既存挙動も維持される。

2. **セッション別未読追跡（`apps/web/src/lib/sessionUnread.js`）**:
   - localStorage キー `hm.session.seen.v1` に `{ [sessionId]: { count: number, at: number } }`（上限 100 件、古い順に間引き）を保持する純関数群を定義する:
     - `bootstrapSessionSeen(prevMap, sessions, now)`: `prevMap` にまだ存在しないセッションが初回リスト読み込みで一斉に未読扱いされないよう、初見のセッションは現在の `message_count` でベースライン登録する（ただし `activeDrawerSid` を除く別セッションで、**既に記録済みの `count` より `s.message_count` が増えたときだけ**返信新着 `hasNewReply = true` と判定する）。
     - `markSessionSeen(prevMap, sessionId, messageCount, now)`: セッションを開いたとき（`openSessionSafe` / `resumeInto` / `loadTranscript`）・アクティブ状態で `message.complete` を受けたときに記録を更新する。
     - `sessionRowBadges({ session, unreadReportMap, seenMap, activeDrawerSid, liveSessionIds })`:
       - `isActive`: `String(session.id) === String(activeDrawerSid)`
       - `isRunning`: `Boolean(session.is_active || liveSessionIds.has(String(session.id)))`
       - `unreadReports`: 当該 `sessionId` の未読完了報告件数（`chatReports` の `at > (seenMap[sid] || 0)` の件数）
       - `unreadReplies`: `!isActive && seenRecord && Number(session.message_count) > Number(seenRecord.count)` のとき `Math.max(1, session.message_count - seenRecord.count)`（上限表示 `NEW` または `+N`）
   - **UI 表示**:
     - ドロワー行右側に `isRunning` なら青い稼働ドット（`.row-dot.running`）、`unreadReports > 0` なら緑の完了ピル/ドット（`🔔` または数値ピル `.row-badge.done`）、`unreadReplies > 0` なら新着ピル（`.row-badge.new`: `NEW`）を表示する。
     - ヘッダの `≡` ドロワーボタン（`ChatPane.jsx:1236-1246`）に、未読のあるセッション数（`otherUnreads.length` と別セッション返信新着の合算ユニークセッション数 `drawerUnreadCount`）があるときコンパクトなバッジ `<span className="drawer-btn-badge">{drawerUnreadCount}</span>` を表示する（`position: relative` 済みの `.icon-btn` 右上に重ねる）。

---

### 3.2 バッジ即時同期エンジン ＆ OS アプリアイコンバッジ（D17）

対象: `apps/web/src/App.jsx`, `apps/web/src/lib/reviewView.js`, `apps/web/test/reviewView.test.js`

1. **OS アプリアイコンバッジ基準の修正（`App.jsx:374-382`）**:
   - `overview?.runningTasks` ではなく、`waitingTotal = reviewWaiting + inboxPending`（人間の対応待ち総数）を `navigator.setAppBadge` / `navigator.clearAppBadge` に反映する。
   - 純関数 `appBadgeCount({ reviewWaiting, inboxPending })` を `reviewView.js`（または `telemetry.js`）にエクスポートし、ユニットテストで固定する。

2. **即時並列同期（`App.jsx`）**:
   - 独立している 5 つの同期待ちループ（`/api/overview`, `/api/review`, `/api/review/feed`, `/api/inbox`, `/api/review/chat-reports` ＋ `/api/live`）に対し、最小間隔 **1,500 ms スロットル**付きの `syncAllBadges({ force = false })` 関数を `App.jsx` に導入する:
     - 発火トリガ:
       1. `document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && syncAllBadges())`
       2. `window.addEventListener('focus', () => syncAllBadges())`
       3. `window.addEventListener('online', () => syncAllBadges({ force: true }))`
       4. 下部タブ `tab` 切替時（`useEffect(..., [tab])` — 画面表示直後にバッジ最新化）
     - バックグラウンドから復帰したとき `window.dispatchEvent(new CustomEvent('hm:wake-sync'))` も発火し、`ChatPane` のセッション一覧および `TasksPane` のボード状態も即座にリフレッシュできるようにする。
   - 従来の 12s / 15s ポーリング間隔はフォアグラウンド常時監視用として残し（`visibilityState === 'visible'` 時のみ実行）、Wake 時の待ち時間（最大 15 秒）を実質 0 秒へ短縮する。

---

### 3.3 チャット履歴のページネーション・ツール引数復元・Markdown 描画（D18）

対象: `apps/bridge/src/transcript.js`, `apps/bridge/test/transcript.test.js`, `apps/web/src/lib/toolProgress.js`, `apps/web/test/toolProgress.test.js`, `apps/web/src/lib/markdown.js`（新規）, `apps/web/test/markdown.test.js`（新規）, `apps/web/src/features/ChatPane.jsx`, `apps/web/src/styles.css`, `apps/web/src/i18n/{en,ja}.json`

1. **履歴件数上限の拡張 ＆ ページネーション（`transcript.js` + `ChatPane.jsx`）**:
   - `apps/bridge/src/transcript.js`:
     - `limit` 上限を `300` → **`1000`** に引き上げ、既定値も `200` にする。
     - `ORDER BY id DESC LIMIT ?` で返すメッセージの最古 ID を `oldestId: messages[0]?.id ?? null` としてレスポンスに含める（`hasMore` は `rows.length >= limit`、さらに精度を上げるなら `LIMIT ? + 1` を取得して余分な 1 件の有無で判定し、厳密な `hasMore` を返すのが望ましい）。
     - **注意**: 従来の `AND length(COALESCE(content, '')) > 0` に加え、`tool_calls` のみを持つ `assistant` 行があるケースに備え、メッセージ取得とは別に（または選択列に `tool_calls` を含めて）`tool_call_id -> { name, args }` マップを構築する。
   - `apps/web/src/features/ChatPane.jsx`:
     - 初回取得（`hydrateTranscriptTools` および `loadTranscript`）の `limit` を `100` → **`300`** に引き上げる。
     - state `transcriptMeta`（`{ sessionId, profile, hasMore, oldestId, loadingMore }`）を保持し、会話の先頭（`.chat-scroll` 最上部、`timeline` の直前）に `transcriptMeta.hasMore && transcriptMeta.oldestId` のときボタン **`↑ 過去の履歴を読み込む`**（EN: `↑ Load older messages`）を表示する。
     - クリック時に `loadOlderTranscript()` が `/api/sessions/${target}/transcript?limit=250&before=${oldestId}&tools=1` を取得して `foldTranscriptMessages()` で畳み込み、`scrollHeight` の差分分だけ `el.scrollTop` を補正してから `setBlocks` の先頭へ重複 ID（`mid`）を除外して連結する。
     - **ちらつき防止（`ChatPane.jsx:364-375`）**: `resumeInto` が `hydrateTranscriptTools` を非同期で呼ぶ際、既に表示中の直近ブロックの末尾ツール等を維持しつつマージするか、メッセージ `mid` が確定した時点で再描画しても開閉状態が壊れないよう、ブロックの React `key` と `ToolRows` の `prefix` を `b.mid ? \`mid-${b.mid}\` : \`at-${b.at || i}\`` に統一する（配列添字 `i` を廃止）。

2. **`state.db` からのツール引数復元 ＆ クリーンサマリ整形（`transcript.js` + `toolProgress.js`）**:
   - `apps/bridge/src/transcript.js`:
     - `pragma_table_info('messages')` で `tool_name`、`tool_call_id`、`tool_calls` の存在を安全にチェック（旧スキーマ後方互換）。
     - `tool_calls` カラムがある場合は、対象セッション（または取得範囲＋直前ターン）の `assistant` 行の `tool_calls` JSON（`[{ id, function: { name, arguments } }]` 等、またはオブジェクト形式）をパースして `Map<toolCallId, { name, args }>` を組み立てる。
     - 各 `role === 'tool'` 返却オブジェクトに以下を付与する:
       - `toolName`: `r.tool_name || matchedCall?.name || null`
       - `toolArgs`: `matchedCall?.args` の主要表示用キーのみを抽出した軽量オブジェクト（`command`, `path`, `file_path`, `query`, `goal`, `code`, `url`, `pattern`, `title`, `text`, `task_id` — 各値は最大 500 文字へトリム）。トークン・環境変数等の機密を丸ごと載せない。
   - `apps/web/src/lib/toolProgress.js`:
     - 純関数 `cleanToolResultPreview(text)` を追加する:
       - ツール返却値 `text` が `{` で始まる JSON 文字列（例: `{"output": "foo\nbar", "exit_code": 0}` / `{"error": "..."}` / `{"result": "..."}`）の場合、パースして `error || output || stdout || result || message || status` の先頭有意味行を取り出す（壊れた/途中で切れた JSON の場合は `"(?:output|result|error|message)"\s*:\s*"([^"]+)"` 等で文字列値を抽出）。
     - `foldTranscriptMessages(messages, toEpochMsFn)` において:
       - `const argDetail = m.toolArgs ? toolDetail(name, m.toolArgs) : ''`
       - `const argFull = m.toolArgs ? toolFullDetail(name, m.toolArgs) : ''`
       - `const resultPreview = shortenPath(cleanToolResultPreview(m.text), 56)`
       - `detail` は **`argDetail || resultPreview`** を優先し、`full` は `argFull && m.text ? \`${argFull}\n→ ${cleanToolResultPreview(m.text, 300)}\` : (argFull || String(m.text ?? '').slice(0, 300))` として、ライブ実行中（`tool.start`）と履歴読み込み後の表示が一致するようにする。

3. **軽量・安全 Markdown レンダラ（`apps/web/src/lib/markdown.js`）**:
   - 外部ライブラリを増やさず（バンドルサイズ肥大防止）、純粋なトークナイザ / パーサ関数群と React コンポーネント `renderMarkdown(raw, { onCopyCode, copyLabel })` を実装する:
     - **ブロック要素**:
       1. フェンスコードブロック ```` ```lang ... ``` ````（既存 `.code-block` UI ＋ Copy ボタンを維持）
       2. 見出し `# ` / `## ` / `### `（`.md-h1`, `.md-h2`, `.md-h3`）
       3. 引用 `> `（`.md-quote`）
       4. 箇条書き `- ` / `* `（`<ul className="md-list">`）・番号リスト `1. `（`<ol className="md-list">`）
       5. 段落・空行区切り（改行は適切に保持）
     - **インライン要素**（正規表現スキャンでネスト破綻しない安全処理）:
       1. インラインコード `` `...` `` → `<code className="md-code">`（最優先でエスケープし、コード内の `*` や `[` を展開しない）
       2. 太字 `**...**` → `<strong>`
       3. リンク `[label](url)` → `sanitizeUrl(url)` が `http://`, `https://`, `mailto:` のみ許可し、`javascript:` / `data:` / `vbscript:` 等は拒否して平文フォールバックする `<a className="md-link" target="_blank" rel="noopener noreferrer">`
   - ユーザー発言バブルは平文（またはインラインコード/リンク破損しない軽量整形）のままとし、アシスタントバブルの `renderFormattedText` を `renderMarkdown` に差し替える。
   - **検証**: `apps/web/test/markdown.test.js` で XSS スキーム拒否・コードブロック内エスケープ・全構文のパースを網羅テストする。

---

### 3.4 設定タブ（`SettingsPane.jsx`）の UI/UX 刷新（D19-A）

対象: `apps/web/src/features/SettingsPane.jsx`, `apps/web/src/styles.css`, `apps/web/src/i18n/{en,ja}.json`

1. **上部ショートカットナビゲーションバー**:
   - `SettingsPane` 先頭に水平スクロール可能な粘着ナビチップバー（`.settings-nav` / `.settings-nav-chip`）を配置し、タップで対象セクションカードへ `scrollIntoView({ behavior: 'smooth', block: 'start' })` する:
     1. `#sec-appearance` — 🎨 外観・端末（Appearance）
     2. `#sec-pairing` — 📱 ペアリング（Pairing）
     3. `#sec-snippets` — ⚡ スニペット（Snippets）
     4. `#sec-repos` — 📁 リポジトリ（Repositories）
     5. `#sec-audit` — 🛡️ 監査＆ログ（Audit & Logs）
     6. `#sec-status` — 🩺 システム状態・診断（Status & Diagnostics）
   - 各セクションに `scroll-margin-top: 56px` を設定し、粘着ナビバーの下にタイトルが隠れないようにする。

2. **6 カード構成の統一**:
   - 従来裸の `.list-head` + `.list` で並んでいた「外観（言語/テーマ/触覚）」「最近のセッション」「リポジトリ＆スキャン先」「システムログ＆監査ログ」「スニペット」「状態・診断・About」を、明確な枠・余白・見出し（`.settings-card-head`）を持つ **6 つの `.card.settings-card` コンポーネント** へ統合・整頓する:
     1. **外観・端末カード (`#sec-appearance`)**: 言語（Auto/EN/JA）・テーマ（Dark/Light/System）・触覚フィードバック（Haptics スイッチ）
     2. **ペアリングカード (`#sec-pairing`)**: QR ペアリング表示ボタン ＋ 説明
     3. **スニペットカード (`#sec-snippets`)**: `SnippetsSection`（チャット/端末定型文管理）を `.card.settings-card` 枠として統一
     4. **リポジトリ管理カード (`#sec-repos`)**: 再スキャン・登録済みリポジトリ一覧・スキャン対象ディレクトリ・追加フォーム
     5. **監査＆ログカード (`#sec-audit`)**:
        - サーバーログチップ（`gateway.log`, `errors.log`, `agent.log`）
        - **監査ログ 8 件折りたたみ（アコーディオン）**: 最新 **8 件**（`AUDIT_PREVIEW_LIMIT = 8`）だけを既定表示し、9 件目以降（`audit.length > 8`）はアコーディオントグルボタンで開閉できるようにする:
          - 閉時: `▼ 他 {count} 件の監査ログを表示` / `▼ Show {count} more audit entries`
          - 開時: `▲ 9件目以降を折りたたむ` / `▲ Collapse older entries`
     6. **システム状態・診断カード (`#sec-status`)**: バージョン・モデル・メモリ・ディスク・Bridge・PWA 診断（`diagnosePwa`）・インストール・最近のセッション概要（最大 5 件）・About（トークンパス）

---

### 3.5 標準 Hermes ダッシュボード（`apps/dashboard/*`）の UI/UX 改善 ＆ 多言語対応（D19-B）

対象: `apps/dashboard/index.js`, `apps/dashboard/style.css`, `apps/dashboard/pilot_dashboard.py`, `apps/bridge/test/dashboard-plugin.test.js`

1. **EN / 日本語 言語切替 UI ＆ `config.json` 連動（`apps/dashboard/index.js`, `pilot_dashboard.py`）**:
   - 現在 `App()`（`apps/dashboard/index.js:1389`）は `var lang = detectLang()` でブラウザ言語のみを参照している。これを state `uiLang` + `hasLocalPref` に改める:
     - 初期値: `localStorage.getItem("hp.dashboard.lang")` が `"en"` / `"ja"` ならそれを採用し、無ければ `detectLang()`。
     - `App` マウント時（または `SettingsSection` の `GET /config` 完了時）に `config.lang` が `"en"` / `"ja"` であり `hp.dashboard.lang` が未設定なら `config.lang` に追従する。
     - `.hp-header` 右側（`Refresh` ボタンの隣）に **セグメント言語切替（`EN` / `日本語`）** を配置する。さらに `SettingsSection` 内にも `lang` フィールド（`en` / `ja` / `auto`）を追加する。
     - ヘッダで言語を切り替えると即座に画面全体（`STRINGS[uiLang]`）および `SnippetsSection` の既定表示言語が切り替わり、`localStorage["hp.dashboard.lang"]` に保存しつつ、`PUT /config`（既存フィールド保持で `lang` 更新、失敗時はサイレント無視）で `config.json` とも同期する。
   - `STRINGS.en` / `STRINGS.ja` に今回の新 UI 用文言（言語名・ナビラベル・監査 8 件展開ボタン・コピー結果・設定フィールドラベル等）を漏れなく追加する。

2. **標準 Web UI のナビ・カード・監査ログ 8 件展開（`apps/dashboard/index.js`, `style.css`）**:
   - `StatusBar` 直下に横並び・折り返し可能な **セクションショートカットチップ（`.hp-nav`）** を配置し、各セクションカード（`#hp-sec-pairing`, `#hp-sec-repos`, `#hp-sec-settings`, `#hp-sec-snippets`, `#hp-sec-logs`, `#hp-sec-service`, `#hp-sec-links`）へスムーズスクロールできるようにする。
   - `LogsSection` で `name === "audit"` のとき、生 JSONL 文字列だけでなく構造化リストとしても見やすく整形し、**最新 8 件のみ既定表示＋9 件目以降をアコーディオン（`▼ 他 N 件を表示` / `▲ 折りたたむ`）** で展開・収納できるようにする（通常ログ `gateway` / `errors` / `pilot` は従来の `<pre className="hp-log">` 末尾スクロール枠を維持し、`audit` でも Raw 表示切替を残す）。

---

## 4. Hermes Agent 自走用カンバンタスク分割（Batch V3-1 〜 Batch V3-5）

Hermes Agent（DeepSeek V4.1 Flash）は以下の **5 バッチ（V3-1 → V3-2 → V3-3 → V3-4 → V3-5）** を順番に実行し、各バッチ完了時に `npm run verify` を通し、最後に `npm run deploy` 後のマルチビューポート検証を行うこと。

---

### Batch V3-1: バッジ即時同期エンジン・OSバッジ修正・ドロワー整合＆未読バッジ

- **目的**: OS アプリアイコンバッジを人間対応待ち合計（`reviewWaiting + inboxPending`）へ修正し、`visibilitychange` / タブ切替時の即時並列同期を実装、さらに Chat ドロワーの `readonly` 閲覧時フォーカス不整合・親チャット混入を解消し未読/進行中バッジを実装する（Section 3.1 / 3.2）。
- **変更・新規ファイル**:
  - 新規: `apps/web/src/lib/sessionUnread.js`, `apps/web/test/sessionUnread.test.js`
  - 変更: `apps/web/src/lib/reviewView.js`, `apps/web/test/reviewView.test.js`
  - 変更: `apps/web/src/App.jsx`, `apps/web/src/features/ChatPane.jsx`, `apps/web/src/styles.css`, `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ja.json`
- **受入条件（Verify）**:
  - `navigator.setAppBadge` が `reviewWaiting + inboxPending` を渡し、`0` のとき `clearAppBadge()` が呼ばれる（`reviewView.test.js` で純関数検証）。
  - `readonly` ワーカーチャット表示中、`activeDrawerSid === readonly.sessionId` となりドロワーで親チャットではなく閲覧中チャットがハイライトされ、`currentIds` に親チャットが混ざらない。
  - 別チャットへの完了報告・返信増分・実行中セッションにドット/バッジが出て、`≡` ボタンにも未読数が表示される。
  - `npm run verify` が全件パスし、`noHardcodedJapanese` 違反ゼロ。

---

### Batch V3-2: チャット履歴のターン拡張・過去履歴ページネーション・ツール引数復元

- **目的**: `state.db` の `tool_calls` / `tool_call_id` からツール引数を復元して履歴表示をライブ実行時と揃え、JSON 結果断片をクリーン整形し、初回取得件数拡大＋「↑ 過去の履歴を読み込む（`before=<id>`）」ページネーションと安定キー化を実装する（Section 3.3 ①②）。
- **変更ファイル**:
  - `apps/bridge/src/transcript.js`, `apps/bridge/test/transcript.test.js`
  - `apps/web/src/lib/toolProgress.js`, `apps/web/test/toolProgress.test.js`
  - `apps/web/src/features/ChatPane.jsx`, `apps/web/src/styles.css`, `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ja.json`
- **受入条件（Verify）**:
  - `createTranscript().read()` が `toolArgs` / `toolName` を復元し、`oldestId` と正確な `hasMore` を返すこと（`transcript.test.js` で旧スキーマ後方互換・`tool_calls` 結合・`before` ページングを検証）。
  - `foldTranscriptMessages()` が `toolDetail(name, toolArgs)` を優先し、JSON ツール結果の `{"output":...}` 文字列から生括弧を出さず先頭行を整形すること（`toolProgress.test.js`）。
  - `ChatPane.jsx` でメッセージリストの `key` と `ToolRows` `prefix` に配列添字ではなく `b.mid` 等の安定キーを使い、「↑ 過去の履歴を読み込む」でスクロール位置を保ったまま先頭追加できること。
  - `npm run verify` が全件パスすること。

---

### Batch V3-3: チャットメッセージの軽量・安全 Markdown レンダラ実装

- **目的**: 外部依存を増やさず XSS 安全な Markdown レンダラ `apps/web/src/lib/markdown.js` を構築し、`ChatPane.jsx` のアシスタント応答で見出し・太字・インラインコード・リスト・引用・安全リンク・コードブロックを美しく読みやすく描画する（Section 3.3 ③）。
- **変更・新規ファイル**:
  - 新規: `apps/web/src/lib/markdown.js`, `apps/web/test/markdown.test.js`
  - 変更: `apps/web/src/features/ChatPane.jsx`, `apps/web/src/styles.css`
- **受入条件（Verify）**:
  - 見出し（`#`〜`###`）、`**bold**`、`` `inline` ``、リスト（`-` / `1.`）、引用（`>`）、リンク（`[label](https://...)`）、```` ```code``` ```` ブロックが崩れずレンダリングされること。
  - `javascript:` や `data:` などの危険スキームリンクは `<a>` にならず無害化され、コードブロック内の Markdown 記号は二重変換されないこと（`markdown.test.js` で検証）。
  - `390px` 幅のスマホ画面で長い URL やコードが気泡外へ横溢れしない（`overflow-wrap: anywhere` 等）。
  - `npm run verify` が全件パスすること。

---

### Batch V3-4: 設定タブのショートカットナビ・6カード構造化・監査ログ8件折りたたみ

- **目的**: `SettingsPane.jsx` 上部に粘着セクションナビバーを導入し、全設定を 6 つの明確なカード（外観・端末 / ペアリング / スニペット / リポジトリ / 監査＆ログ / システム状態・診断）に整理、さらに監査ログの初期表示を最新 8 件に制限して 9 件目以降をアコーディオンで開閉できるようにする（Section 3.4）。
- **変更ファイル**:
  - `apps/web/src/features/SettingsPane.jsx`, `apps/web/src/styles.css`
  - `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ja.json`
- **受入条件（Verify）**:
  - 設定タブ上部の 6 つのショートカットチップで各カードへスムーズスクロールでき、各カードが明確な境界・アイコン・見出しを持つこと。
  - 監査ログが 9 件以上ある場合、初期状態では 8 件のみ表示され、`▼ 他 N 件を表示` ボタンで全件展開・再折りたたみできること（8 件以下ならボタン非表示）。
  - `npm run verify` が全件パスし、日英ともに文言欠落・横溢れが無いこと。

---

### Batch V3-5: 標準Web UI（apps/dashboard）の EN/JA 言語切替・UI/UX改善 ＆ 総仕上げ検証

- **目的**: 標準 Hermes ダッシュボードの Hermes Pilot タブ（`apps/dashboard/*`）に **EN / 日本語 言語切替スイッチ**（`config.json` `lang` と双方向同期）・セクションショートカットチップ・監査ログ 8 件アコーディオンを導入し、全バッチ実装後のビルド・デプロイ・マルチビューポート（390×844 / 820×1180・EN/JA・Dark/Light）実機相当検証を完了する（Section 3.5）。
- **変更ファイル**:
  - `apps/dashboard/index.js`, `apps/dashboard/style.css`, `apps/dashboard/pilot_dashboard.py`
  - `apps/bridge/test/dashboard-plugin.test.js`
  - 必要に応じたスタイル・文言微調整（`apps/web/src/styles.css` 等）
- **受入条件（Verify）**:
  - 標準 Web UI ヘッダおよび設定フォームで `EN` ↔ `日本語` を切り替えると全ラベルとスニペット既定言語が即時切替され、`PUT /config` 経由で `config.json` に永続化されること（`redact()` でトークン非漏洩）。
  - 標準 Web UI のセクションジャンプナビと監査ログ 8 件折りたたみが動作すること。
  - `npm run verify`（全テスト＋PWA検査＋Viteビルド）および `npm run deploy` が成功し、`390×844` / `820×1180`（EN/JA・Dark/Light）で横溢れ `0` 件・主要画面に視覚破綻がないこと（`hermes-pilot init --force` 互換確認含む）。

---

## 5. Hermes Agent 自律実行プロンプト（コピペ用）

以下のプロンプトをチャットへそのまま貼り付けるか、PWA「Tasks → 🚀 Spec Launchpad」から `docs/SPEC-PILOT-V3.md`（Batch V3-1 〜 V3-5）を一括起票して実行してください:

```text
docs/SPEC-PILOT-V3.md を精読し、Section 4 の Batch V3-1 から Batch V3-5 までを順番に自律実装・検証してください。

厳守事項:
1. 各バッチの開始前に既存コードと関連テストを読み、設計・制約（特に apps/web/test/noHardcodedJapanese.test.js や dashboard 側の redact() 境界、specs.js の仕様）を壊さないこと。
2. 1 バッチごとに必ず `npm run verify`（全ユニットテスト＋check:pwa＋vite build）を通し、通ってから次のバッチへ進むこと。
3. 全バッチ完了後、`npm run deploy` を実行し、ヘッドレスブラウザ等で PWA（390x844 / 820x1180・EN/JA・Dark/Light）と主要コンポーネント（Drawerアクティブ整合、過去履歴ページネーション、Markdown描画、Settings 6カード＋監査8件折りたたみ、Dashboard の EN/日本語 切替）の実画面・横溢れゼロ検証を行い、修正が必要なら直して再 verify すること。
4. 判断が必要な論点が出た場合のみ quick-review または annotation タスクを起票し、それ以外は完走まで止まらず走り切ること。
```
