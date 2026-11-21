# SPEC: Hermes Pilot v4 (`SPEC-PILOT-V4`) — パイプライン完走統合レポート ＆ チャットドロワー既読/更新UX改善仕様書

- **Status**: archived
- **アーカイブ日**: 2026-11-21（COH-4・全バッチ完了済み。以後は参照用に保持し、新規起票の対象外）

状態: **仕様確定（2026-11-15 実機監査 ＆ Q&A D20〜D22 合意済み）**
前提仕様: [SPEC-PILOT-V3.md](./SPEC-PILOT-V3.md)（Batch V3-1 〜 V3-5 / `c547918` 完走済み）
想定実装ランナー: **Hermes Agent / DeepSeek V4.1 Flash**（Batch V4-1 〜 V4-4 カンバン自走 ＋ 実機相当検証）

> **注意（プロジェクト制約）**:
> - `apps/web/src/` 配下では `apps/web/test/noHardcodedJapanese.test.js` により JSX/JS への生日本語リテラル記述が禁止されている。UI 文言は必ず `apps/web/src/i18n/en.json`・`ja.json` に定義し `t(...)` 経由で参照すること。
> - 一方、`apps/bridge/src/` 配下の既存ログ/エラー設計は変更範囲外を壊さないこと（外部パッケージ追加なし・Node built-in `node:sqlite` / React Built-ins だけで完結させる）。
> - `apps/bridge/src/specs.js`（Spec Launchpad）がカンバンバッチとして誤認しないよう、バッチ以外の `###` 見出しは必ず数字で始めること（バッチ見出しのみ `### Batch V4-x:`）。

---

## 1. 実機検証・コード監査レポート（課題と根本原因）

V3 実機確認で判明した 2 大課題のソースコード上の根本原因は以下の通り。

| # | 箇所 (`file:line`) | 現象・根本原因 |
|---|---|---|
| **I9** | `apps/web/src/lib/sessionUnread.js:90-99, 183`<br>`apps/web/src/features/ChatPane.jsx:429, 784-828, 1212, 1426-1429` | **チャットを開いて閲覧した後も未読バッジ（`NEW` / `+N` / 緑バッジ）が残る・再点灯する＋ドロワー更新遅れ**<br>① **マスクのみで永続化されない `isActive`（`sessionUnread.js:183` / `ChatPane.jsx:817-828`）**: `sessionRowBadges` は `!isActive && record && count > record.count` で未読を隠すだけ。一方 `ChatPane.jsx:817` の `useEffect([sessions])` は未登録 ID のみ初期化する `bootstrapSessionSeen` を呼ぶだけで、**現在表示中のセッション（`activeDrawerSid`）の `message_count` が増えたときに `sessionSeen[activeDrawerSid].count` を更新・保存しない**。そのため別のチャットへ切り替えた瞬間 `isActive` が `false` になり、さきほど読んでいたチャットに `NEW` / `+N` バッジが復活する。<br>② **開封時の古い `sessionsRef` 参照（`ChatPane.jsx:429, 1212`）**: `resumeInto` / `loadTranscript` 時に `sessionsRef.current.find(...)?.message_count` を渡しているが、ドロワーを開いたときに `loadSessions` が走らないため `sessionsRef.current` が数分前の古い `message_count` を持っている（または新着セッションが一覧に未反映で `undefined` になる）。直後のポーリングで最新 `message_count` が届くと差分で再点灯する。<br>③ **完了報告の時刻スキュー（`ChatPane.jsx:784-795`）**: `markReportsSeen(id)` が無条件にクライアントの `Date.now()` を書き込むため、サーバ側 `at` が端末時計より数秒先だと `r.at <= seenMap[id]` が偽になり緑の完了件数バッジが消えない。<br>④ **ドロワー開封時の自動更新＆手動更新/一括既読 UI の欠如（`ChatPane.jsx:1426, 2230`）**: `≡` を押して `setDrawer(true)` する際に `/api/sessions` や `/api/review/chat-reports` を再取得しないため、タスク稼働中にドロワーを開いても一覧やバッジが古い。 |
| **I10** | `apps/bridge/src/review-watcher.js:115`<br>`apps/bridge/src/specs.js:191-207`<br>`apps/bridge/src/review.js:1217-1250` | **Spec Launchpad / チャット起票タスク一括完走後の統合完了報告が返らない**<br>① `review-watcher.js:115` が SQL を `WHERE body LIKE '%[review]%' OR body LIKE '%[akapen]%'` に限定しており、Spec Launchpad（`specs.js`）やチャット通常起票のカンバンタスクを一切監視していない。<br>② `specs.js` の `buildTaskBody`（`:191`）が起票元の `originSessionId`（`Chat:`）やラン記録（`pipeline-runs.json`）を残していない。<br>③ 各ワーカーの `tasks.result`・Git コミット（`gitinfo.js`）・残課題は個別のワーカーチャット（`local-...`）や Kanban DB に散らばったままで、全タスク終了（または `blocked`/`failed` 停止）時に横断集計して Markdown サマリを生成し親チャットや新規レポートチャット・Tasks タブへ届ける仕組みが存在しない。 |

---

## 2. 合意決定表（Q&A D20〜D22）

| # | 論点 | 決定内容 |
|---|---|---|
| **D20** | パイプライン完走時の統合完了報告と「次の一手」導線（ハイブリッド方式） | ① **統合 Markdown サマリの自動生成・配信**: 完了時に各タスクの `result`・Git コミット/変更ファイル概要・抽出された未実施項目/発見課題/ブロック要因・推奨ネクストステップを集約した構造化 Markdown レポートを生成し、`chat-reports.jsonl`（`kind: 'pipeline'`）へ自動追記する。<br>② **届け先チャット解決**: `Chat:` 指定 / `pipeline-runs.json` の `originSessionId` → 無ければ対象リポジトリ `cwd` に一致する最新の通常セッション（`state.db`）→ それも無ければ `'__latest__'`（チャットタブでバナー表示＋ワンタップで当該リポのチャット作成・開示）。<br>③ **リッチカード ＆ ワンタップ相談**: `ChatPane` のタイムライン上で折りたたみ/全文閲覧可能な統合レポートカードを描画し、**「💬 次の一手を相談」** ボタン（相談用プロンプトを下書きセット/送信準備＋未読解除）を付与する。同時に `TasksPane` 上部にも同ボード直近の完走サマリバナーを表示する。 |
| **D21** | 完了検知の単位と異常/ブロック終了時の扱い | ① **両方検知**: (A) **Spec Launch 単位**（同一 `board` ＋ 同一 `Spec: <specRelPath>` / `pipeline-runs.json` 登録ラン）と、(B) **ボードウェーブ単位**（`Spec:` を持たないチャット起票等の通常タスク群で、稼働/待機中タスクがあった波が `running === 0 && ready === 0 && todo === 0` に収束した瞬間）の双方を監視・統合報告する。<br>② **`blocked` / `failed` 停止時**: 残タスクが `blocked` または `failed` のみで `running === 0 && ready === 0 && todo === 0` に達した場合も、**「⚠️ 要確認サマリ（中断/ブロックあり）」** として完了分と停止理由・未実施分を明確に分けて報告する。 |
| **D22** | チャットドロワーの未読解消バグ修正 ＆ 更新UX（全3点実装） | ① **表示中セッションの継続既読同期 ＋ 開封時の最新 count 取得**: `syncActiveSessionSeen` と `Math.max(existing, sessionCount, msgCount)` により開いて見た会話の未読が別会話切替後に再点灯しないようにする（`markReportsSeen` も時計スキュー対策）。<br>② **ドロワー開封時の自動更新 ＋ ワーカー完了時自動更新**: `≡` でドロワーを開いた瞬間（1.5s スロットル付き）および `liveTurns` 減少時に `loadSessions` ＋ `hm:refresh-reports` を自動実行する。<br>③ **ドロワー内マニュアル操作バー**: ドロワー上部に **「↻ 更新」**（スピナー付き）と **「✓ すべて既読」** ボタンを配置する。 |

---

## 3. 詳細技術仕様

### 3.1 チャットドロワー未読解消バグ修正・自動更新・一括操作UI（D22）

対象: `apps/web/src/lib/sessionUnread.js`, `apps/web/test/sessionUnread.test.js`, `apps/web/src/features/ChatPane.jsx`, `apps/web/src/styles.css`, `apps/web/src/i18n/{en,ja}.json`

1. **`apps/web/src/lib/sessionUnread.js` の拡張（純粋関数群）**:
   - **`syncActiveSessionSeen(prevMap, sessions, activeDrawerSid, now)`**:
     - `activeDrawerSid` が指定されており、`sessions` 内に該当セッション `s` が存在する場合、`s.message_count`（数値化・`>= 0`）を現在記録値 `prev.count` と比較し、`count > (prev?.count ?? -1)` なら `{ count: Math.max(prev?.count ?? 0, count), at: stamp }` に更新した新 map を返す（該当が無ければ元を破壊しない）。
     - **意義**: 会話 `B` を開いている最中に外部・ポーリングで `B.message_count` が増えた分を、リアルタイムで `localStorage` の `hm.session.seen.v1` に永続化し、別会話 `A` へ移ったときに `B` が再び `NEW` に戻るバグを根絶する。
   - **`markSessionSeen(prevMap, sessionId, messageCount, now)` の強化**:
     - 渡された `messageCount` が欠損・小さい値であっても、既存の `prev.count` より小さくならないよう **`Math.max`** で単調増加オプション（`floor` 既定維持つつ、明示的に有効な数値が入った場合も既存同 ID の stale count で後退させないよう呼び出し側で `Math.max(prevCount, sessionCount, loadedMsgCount)` を渡せるシグネチャを維持）。
   - **`markAllSessionsSeen(prevMap, sessions, now)`**:
     - 引数 `sessions` の全要素について `{ count: Math.max(0, Math.floor(Number(s.message_count) || 0), prev?.count ?? 0), at: stamp }` を一括記録して `pruneSessionSeen` した map を返す（「✓ すべて既読」用）。

2. **時刻スキュー耐性のある完了報告既読化（`ChatPane.jsx` + `chatReports.js`）**:
   - `apps/web/src/lib/chatReports.js` に **`maxReportAtFor(items, sessionId)`** および **`markAllReportsSeenMap(prevSeenMap, items, now)`** を追加する（純関数としてテスト可能にする）。
   - `ChatPane.jsx` に `chatReportsRef`（最新 `chatReports` を保持）を持ち、`markReportsSeen(id)` では:
     ```js
     const latestAt = maxReportAtFor(chatReportsRef.current, id)
     const stamp = Math.max(Date.now(), latestAt)
     ```
     を記録する。サーバ時刻とモバイル端末時計が数秒〜数分ズレていても、一度開いた/確認した完了報告の緑バッジが消えない問題を完全に防ぐ。
   - 同様に **「✓ すべて既読（`markAllDrawerRead`）」** では、`markAllReportsSeenMap` で全報告（`sessionSeen` には `markAllSessionsSeen`）を一括更新し、`hm.chatReportSeen` と `hm.session.seen.v1` の両方を `localStorage` に保存する。

3. **セッション開封時の最新カウント同期と即時リフレッシュ（`ChatPane.jsx`）**:
   - `resumeInto`（`:429` 付近）および `loadTranscript`（`:1212` 付近）で、対象セッションを「見た」として記録する際:
     - `const knownCount = sessionsRef.current.find((s) => String(s.id) === String(targetId))?.message_count`
     - `const visibleCount = Array.isArray(msgs) ? msgs.length : 0`
     - `markReadRef.current?.(targetId, Math.max(Number(knownCount) || 0, visibleCount))`
     を実行する（さらに `hydrateTranscriptTools` 完了時にも `Math.max` で補強可）。
   - `useEffect([sessions, active, activeDrawerSid])`: `active`（Chat タブが表示中）かつ `activeDrawerSid` がある間は `bootstrapSessionSeen` に続けて `syncActiveSessionSeen(next, sessions, activeDrawerSid, Date.now())` を適用し、`localStorage` に反映する。
   - **ドロワー開封時の自動リフレッシュ（`openDrawer`）**:
     - `≡` ボタンの `onClick` を `openDrawer()` 関数に切り出し、`setDrawer(true)` と同時に `refreshDrawerData()`（最低 **1,500ms スロットル**）を呼ぶ:
       - `window.dispatchEvent(new CustomEvent('hm:refresh-reports'))`
       - `connRef.current === 'ready'` かつ `sockRef.current?.rpc` があれば `loadSessions(sockRef.current.rpc)` を並列実行し、`drawerRefreshing` state で控えめな状態反映を行う。
   - **ライブターン完了時の自動更新**:
     - `prevLiveCountRef` で `liveTurns.length` を記憶し、`liveTurns.length < prevLiveCountRef.current`（稼働中のワーカー/セッションが 1 つ以上終了）を検知したら（接続中なら）バックグラウンドで `loadSessions(rpc)` ＋ `hm:refresh-reports` を発火する。

4. **ドロワー上部アクションバー（`ChatPane.jsx` + `styles.css` + `i18n`）**:
   - `<Sheet title={t('chat.drawerTitle')} onClose={() => setDrawer(false)}>` 直下にコンパクトな `.drawer-actions` バーを配置する:
     - 左: `RefreshButton`（`variant="btn"`, `label={t('chat.drawerRefresh')}`, `busy={drawerRefreshing}`, `onRefresh={() => refreshDrawerData({ force: true })}`）
     - 右: `✓ {t('chat.markAllRead')}` ボタン（`className="btn drawer-mark-read"`, `disabled={!drawerUnread && !otherUnreads.length}`, `onClick={markAllDrawerRead}`）
   - 390px 幅でも折り返し・横溢れしないよう `display: flex; gap: 8px; padding: 4px 2px 10px;` ＋ `flex: 1` レイアウトにする。

---

### 3.2 ブリッジ・パイプライン完走ウォッチャー ＆ 統合 Markdown サマリ生成（D20 / D21）

対象: `apps/bridge/src/specs.js`, `apps/bridge/src/pipeline-watcher.js`（新規）, `apps/bridge/src/review.js`, `apps/bridge/src/server.js`, `apps/bridge/test/pipelineWatcher.test.js`（新規）

1. **起票元チャットの記録（`apps/bridge/src/specs.js` & `server.js`）**:
   - `buildTaskBody({ specRelPath, repoPath, board, batch, chat })`:
     - `chat`（サニタイズ済み `session_id`）が渡された場合、メタヘッダ末尾（`Batch:` の次行）に `Chat: ${chat}` を含める。
   - `launchSpec(input)`（および `POST /api/specs/launch`）:
     - `body?.chat` を受け取り（`/^[A-Za-z0-9_.:-]{1,128}$/` でサニタイズ）、`buildTaskBody` に渡すとともに、実際に 1 件以上起票または既に紐づけ対象があるランを `~/.hermes/plugin-data/hermes-pilot/review/pipeline-runs.json` に記録する（`recordRun` はテスト時 DI 可能）:
       ```json
       {
         "runs": [
           {
             "id": "run_20261115T001000_ab12",
             "board": "hermes-mobile-pwa",
             "repoPath": "/path/to/repo",
             "specRelPath": "docs/SPEC-PILOT-V4.md",
             "title": "SPEC: Hermes Pilot v4 ...",
             "batchIds": ["V4-1", "V4-2", "V4-3", "V4-4"],
             "taskIds": ["t_...", "t_..."],
             "originSessionId": "ses_...",
             "createdAt": 1794800000000,
             "reportedAt": null
           }
         ]
       }
       ```
     - 上限 50 ランを保持し古い完了済みランから自動剪定する（`.tmp` → `renameSync` でアトミック書込）。

2. **パイプライン完走ウォッチャー（`apps/bridge/src/pipeline-watcher.js`）**:
   - `createPipelineWatcher(cfg, opts = {})` を新規作成し、`server.js` で `reviewWatcher.start()` と並べて起動する（間隔既定 `10_000 ms`）。`review/feed.jsonl`（Review タブの通知専用）には**書かない**（Review タブへのノイズ防止）。
   - 監視対象 DB は `review-watcher.js` と同様に `cfg.kanbanRoot/boards/*/kanban.db` ＋ ルート `kanban.db` を読み取り専用（`DatabaseSync(dbPath, { readOnly: true })`）で走査し、`status != 'archived'`（直近 300 件）を取得する。取得列: `id, title, body, status, result, created_at, started_at, completed_at, session_id`。
   - **完了判定グループ化**:
     - **A. Spec Run グループ**:
       - タスク本文の `^Spec:\s*(.+)$` 行（または `pipeline-runs.json` の `taskIds` 一致）で `(board, specRelPath)` ごとにグループ化。`title` や `originSessionId` は `pipeline-runs.json` / 本文の `^Chat:\s*(.+)$` から引ける。
     - **B. Board Wave グループ**（`Spec:` に属さない通常タスク — チャットからの一括起票など）:
       - 同一 `board` 上の非アーカイブ・非 Spec タスク群を 1 つの「進行ウェーブ」として評価する（ただし全タスクが `[review]` のみの場合は個別レビュー報告と重複しないよう除外するか、複数タスクのウェーブだった場合のみ・または非 `[review]` タスクを含む場合に対象とする）。
   - **発火条件（スパム防止 ＋ 高速完了取りこぼし防止）**:
     1. **初回起動（`pipeline-watcher-state.json` 不在時）**:
        - 開始時点の `startedAtSec = Math.floor(now() / 1000)`、およびその時点で存在していた全タスク ID を `knownTaskIds` として登録し、**既存の完了済みタスク/Spec に対しては一切通知せず**ベースライン確立のみ行う（既存 Spec に既に `running/ready/todo` が居る場合は `activeGroups` に載せて完了を待つ）。
     2. **稼働中 → 収束検知**:
        - あるグループ `G` について、`openCount = running + ready + todo` を数える。
        - 前ティックで `G` がアクティブ（`openCount > 0`）だった、**または** `G` に `knownTaskIds` に含まれない新規タスク（`completed_at >= state.startedAtSec` または `pipeline-runs.json` に `reportedAt === null` で記録されたラン）が存在し、かつ現在 `openCount === 0` かつ `(doneCount + blockedCount + failedCount) > 0` になったとき、**完了トリガー**を発火する！
        - 状態キー（`Spec` なら `spec:${board}:${specRelPath}:${latestCompletedAt}`、ウェーブなら `wave:${board}:${sortedTaskIdsHash}`）を `reportedKeys` に保存し、`pipeline-runs.json` の `reportedAt` も更新して**二度と重複送信しない**。
        - その後同じボードに新しいタスクが追加されて再度 `openCount > 0` になれば次のウェーブとして自然に再トラッキングされる。
   - **ステータス判定（D21②）**:
     - `blockedCount > 0 || failedCount > 0` の場合 → `status = 'halted'`（⚠️ 要確認サマリ）
     - すべて `done`（`blockedCount === 0 && failedCount === 0`）の場合 → `status = 'done'`（🎉 パイプライン完走レポート）

3. **統合 Markdown サマリの構成（`buildPipelineReport` 純関数）**:
   - 各タスクに対し、`gitinfo.forTask(task.id)` および `gitinfo.diffSummary(task.id)`（利用可能なら上位変更ファイル名・`+add/-del`）を取得して肉付けする。
   - `task.result` および `task.status` から以下を自動抽出する純関数群を `pipeline-watcher.js` に持たせる:
     - **`extractIssuesAndRemaining(tasks)`**:
       - `blocked` / `failed` タスク（優先表示：理由サマリ付き）
       - 各 `task.result` 本文内から `TODO`, `FIXME`, `未実施`, `残課題`, `スキップ`, `blocked`, `skipped`, `failed`, `remaining`, `warning`, `⚠` 等を含む行を最大 8 件まで抽出・重複除去。
     - **`buildNextSteps({ status, board, specRelPath, tasks, issues })`**:
       - 状況に応じた実行可能な推奨ネクストステップを生成（例: halted なら `Blocked タスクの確認・指示` / done なら `npm run verify・実機/画面の最終確認`、未実施残項目があればその着手提案、Git コミット済みなら確認・リリース判断）。
   - **出力 Markdown テンプレート（EN/JA 混在環境でも一目で把握でき、見出し・記号が明快な形式）**:
     ```markdown
     ### 🎉 Pipeline Completed: <SpecTitle or Board> (4/4 done · 12m)
     <!-- status === 'halted' の場合: ### ⚠️ Action Required: <SpecTitle or Board> (2 done · 1 blocked · 1 skipped) -->

     #### ✅ 完了タスク / Completed Tasks
     - **[V4-1] チャットドロワー未読解消…** (`abc1234`, +84/-12 · 4 files)
       - `<task.result の要約 1〜2 文>`
     ...

     #### ⚠️ 未実施項目・発見課題 / Issues & Remaining Items
     - **無し（全項目クリーン完走）** または 抽出されたブロック/警告/残課題箇条書き

     #### 🚀 次のステップ / Recommended Next Steps
     - 推奨アクション 1〜3 件（そのままチャットに相談できる具体案）
     ```
   - **宛先チャット `session_id` の自動解決 (`resolveTargetSessionId`)**:
     1. グループ内タスク本文の `Chat:` または `parseReviewLine(body)?.chat`
     2. `pipeline-runs.json` の該当ラン `originSessionId`
     3. いずれも無ければ、`state.db`（デフォルト ＋ `profiles/*/state.db`）の `sessions` テーブルから **`id NOT LIKE 'local-%'` かつ `cwd` がボードの `default_workdir`（`normalizePath` 一致）に最も近い最新セッション**（`ORDER BY last_activity_at DESC LIMIT 1`）を 1 件解決する。
     4. 上記すべて見つからない場合（完全に初回起動で Launchpad から回した場合など）は `session_id: '__latest__'` をセットする。
   - **永続化**:
     - `review/chat-reports.jsonl` に 1 行 JSON として追記:
       ```json
       {
         "at": "2026-11-15T00:30:00.000Z",
         "kind": "pipeline",
         "status": "done",
         "session_id": "<resolved or __latest__>",
         "task_id": "pipeline:<board>:<runId>",
         "label": "<SpecTitle or BoardName>",
         "board": "<board>",
         "spec": "<specRelPath or null>",
         "repo_path": "<workdir or null>",
         "text": "🎉 <title> (4/4 done)",
         "markdown": "<full markdown report>",
         "follow_up_prompt": "<pre-filled prompt to ask Hermes Agent about results / next steps>",
         "counts": { "done": 4, "blocked": 0, "failed": 0, "total": 4 }
       }
       ```
     - あわせて `review/pipeline-reports.jsonl` にも直近 100 件として同じ構造体を追記（または共通読み取り）し、`server.js` に **`GET /api/specs/reports?board=<slug>&limit=<n>`** を新設する（`TasksPane.jsx` がボード別レポートを軽量に 1 回で取れるようにする）。

4. **`apps/bridge/src/review.js` の後方互換拡張**:
   - `readChatReportRows()`（`:1217-1250`）で既存の `at, sessionId, taskId, label, text` に加え、`kind`, `status`, `board`, `spec`, `repoPath`, `markdown`, `followUpPrompt`, `counts` が存在すればオブジェクトに透過的に保持して返す。既存の review 1 行レポートには影響を与えない。

---

### 3.3 統合レポートカード（Chat タイムライン ＆ Tasks タブ）＋ ワンタップ相談（D20）

対象: `apps/web/src/lib/chatReports.js`, `apps/web/test/chatReports.test.js`, `apps/web/src/features/ChatPane.jsx`, `apps/web/src/features/TasksPane.jsx`, `apps/web/src/App.jsx`, `apps/web/src/styles.css`, `apps/web/src/i18n/{en,ja}.json`

1. **`apps/web/src/lib/chatReports.js` の拡張**:
   - `reportLines(items, sessionIdOrIds, limit = REPORT_LINES)`:
     - 既存フィルタに加え、渡された ID 配列に `'__latest__'` を含める（あるいは現在アクティブな通常チャットがあり他に宛先が無かった `__latest__` 報告も表示対象に含める）か、または明示的に呼び出し元が `[...currentIds, ...(!readonly ? ['__latest__'] : [])]` を渡せる設計にする（既存テストの単純 ID マッチは壊さず、`currentIds` に `'__latest__'` を含めた場合だけ拾う純粋な挙動にすれば既存テスト 100% 互換）。
     - 返却オブジェクトに `kind`, `status`, `board`, `spec`, `repoPath`, `markdown`, `followUpPrompt`, `counts` をそのまま引き継ぐ。
   - `otherUnreadReports(items, seen, currentIds = [])`:
     - 同様に `kind`, `status`, `board`, `spec`, `followUpPrompt` を引き継ぐ。
     - `seenMap['__latest__']` も通常のセッション ID と同様に既読管理できる。
   - 新規純関数:
     - `maxReportAtFor(items, sessionId)`: 対象 `sessionId` の最大 `r.at` を返す（無ければ `0`）。
     - `markAllReportsSeenMap(prevSeen, items, now)`: `items` に登場する全 `sessionId` に対して `Math.max(now, maxReportAtFor(items, sid))` をセットした新 map を返す（上限剪定維持）。

2. **`ChatPane.jsx` タイムライン内のリッチ統合レポートカード**:
   - `timeline.map`（`:1584-1606`）で `r.kind === 'pipeline'` を分岐描画する:
     - **カード見た目（`.msg.report-card` / `.is-halted`）**:
       - ヘッダ帯: アイコン（🎉 / ⚠️）＋ `r.label || t('chat.pipelineReport')` ＋ ステータスチップ（`done` は緑、`halted` は黄赤）＋ 時刻 ＋ **折りたたみトグル（既定は最新 1 件を展開、2 件目以降は折りたたみ可）**。
       - 本文: 既存の安全レンダラ **`MarkdownBody`**（`V3-3` 実装済み）で `r.markdown || r.text` をそのまま美しく表示（コミット SHA やコード、箇条書きが綺麗に読める）。
       - フッタアクション行（`.report-card-actions`）:
         1. **`💬 {t('chat.discussNextSteps')}`**（`.report-card-btn.primary`）: クリックで `prefillComposer(r.followUpPrompt || ...)` を呼び、入力欄へフォローアップ質問・ネクストステップ相談文を挿入＆オートリサイズ＆フォーカスする（即誤送信はせず、ユーザーが 1 タップで確認・追記して送信できる安全な 1-tap 下書き展開）。
         2. **`📋 {t('chat.openBoard')}`**（`.report-card-btn`）: `window.dispatchEvent(new CustomEvent('hm:open-board', { detail: { board: r.board } }))` を発火して Tasks タブの該当ボードへ遷移する。
   - **`otherUnreads` バナーでの `'__latest__'` 対応（`:1495-1516`）**:
     - `u.sessionId === '__latest__'` のレポートで「開く（Open）」が押された場合:
       - いま既に通常チャットを開いているならそのタイムラインへ合流しつつ `markReportsSeen('__latest__')` ＋ スクロール末尾へ移動。
       - まだ会話が開いていない（または別チャットから切り替えたい）場合、`u.repoPath` に一致する `repos` を探して `startSession(profile || DEFAULT_PROFILE, matchedRepo, { slug: u.board })` を開き、必要に応じて報告内容を相談できる状態にして `markReportsSeen('__latest__')` する。

3. **`TasksPane.jsx` 上部の「直近の完走サマリ」バナー ＆ Spec Launchpad 起票連携**:
   - **`POST /api/specs/launch` 呼び出し（`TasksPane.jsx:420`）**:
     - `readActiveChatId(globalThis.localStorage)` を読んで `{ board, specRelPath, batchIds, assignee: 'mobile', chat: activeChat || undefined }` を送る（`ChatPane` から直近操作していた会話へ自動紐づけするため）。
   - **直近パイプラインレポート取得・バナー表示**:
     - ボード切替時・`loadTasks(board)` 完了時・タスクの稼働状態（`running + ready + todo`）が `> 0` から `0` に変わった直後に `GET /api/specs/reports?board=${encodeURIComponent(board)}&limit=1` をフェッチし、`latestReport` state に保持する。
     - `latestReport` があり（かつ起動中 `openTasks === 0`、あるいは直近 24 時間以内のレポート）、`.pipeline-summary-card` バナーを `spec-bar` の直下へ控えめかつ見やすく表示する（`<details>` 形式で 1 行要約＋展開すると `MarkdownBody` 全文が読める）。
     - バナー内ボタン **「💬 {t('tasks.discussReport')}」** を押すと、`window.dispatchEvent(new CustomEvent('hm:discuss-pipeline', { detail: { sessionId: report.sessionId, repoPath: report.repoPath, board: report.board, prompt: report.followUpPrompt, title: report.label } }))` を発火する。
   - **`App.jsx` 連携**:
     - `hm:discuss-pipeline` を受信したら `setTab('chat')`（まだ `!chatMountedRef.current` なら `pendingDiscuss` として `ChatPane` に渡す）。`ChatPane` は受け取った `sessionId`（有効 ID ならそれを開く / `'__latest__'` や空なら該当 repo で `startSession`）を開いたうえで `followUpPrompt` を入力欄にセット＆フォーカスする。
     - `hm:open-board` を受信したら `setTab('tasks')` ＋ `hm.board` をセットする。

---

### 3.4 検証・ビルド・実機相当監査

対象: 全ユニットテスト、`npm run verify`, `npm run deploy`, ヘッドレスブラウザマルチビューポート監査（390×844 / 820×1180・EN/JA・Dark/Light）

---

## 4. Hermes Agent 自走用カンバンタスク分割（Batch V4-1 〜 Batch V4-4）

Hermes Agent（DeepSeek V4.1 Flash）は以下の **4 バッチ（V4-1 → V4-2 → V4-3 → V4-4）** を順番に実行し、各バッチ完了時に `npm run verify` を通し、最後に `npm run deploy` 後の実画面検証まで完走すること。

---

### Batch V4-1: チャットドロワー未読解消バグ修正・自動更新・一括操作UI

- **目的**: 会話を開いて閲覧した後に別会話へ戻っても未読バッジ（`NEW` / `+N` / 緑件数）が再点灯しないよう永続既読同期と時刻スキュー対策を実装し、ドロワー開封時・ライブ完了時の自動リフレッシュ、ならびにドロワー上部の「↻ 更新」「✓ すべて既読」操作バーを実装する（Section 3.1 / D22）。
- **変更ファイル**:
  - `apps/web/src/lib/sessionUnread.js`, `apps/web/test/sessionUnread.test.js`
  - `apps/web/src/lib/chatReports.js`, `apps/web/test/chatReports.test.js`
  - `apps/web/src/features/ChatPane.jsx`, `apps/web/src/styles.css`
  - `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ja.json`
- **受入条件（Verify）**:
  - `syncActiveSessionSeen` と `markAllSessionsSeen` が単体テスト（`sessionUnread.test.js`）で検証され、表示中セッションの `message_count` 増加時に既読カウントが進み、別セッションへ切り替えても `NEW` / `+N` が復活しないこと。
  - `maxReportAtFor` / `markAllReportsSeenMap` がテスト（`chatReports.test.js`）で検証され、報告 `at` が端末時刻より未来（時計スキュー）であっても `markReportsSeen` 後に未読件数が `0` になること。
  - ドロワーを開くと即座に `loadSessions` ＋ `hm:refresh-reports` が走り（1.5s スロットル）、ドロワー上部バーから「↻ 更新」と「✓ すべて既読」が使えること。
  - `npm run verify`（`noHardcodedJapanese` 含む）が全件パスすること。

---

### Batch V4-2: ブリッジ パイプライン完走ウォッチャー ＆ 統合 Markdown サマリ生成

- **目的**: Spec Launchpad（`specs.js`）のラン追跡と新規 `apps/bridge/src/pipeline-watcher.js` を実装し、Spec 実行またはボード上のタスクウェーブが全件完了（または `blocked`/`failed` 停止）したとき、結果・Git コミット・残課題・次の一手を構造化 Markdown として自動合成し、起票元チャット（または最新同一 repo チャット / `__latest__`）へ届ける（Section 3.2 / D20 / D21）。
- **変更・新規ファイル**:
  - 新規: `apps/bridge/src/pipeline-watcher.js`, `apps/bridge/test/pipelineWatcher.test.js`
  - 変更: `apps/bridge/src/specs.js`, `apps/bridge/test/specs.test.js`
  - 変更: `apps/bridge/src/review.js`, `apps/bridge/src/server.js`, `apps/bridge/test/review.test.js`
- **受入条件（Verify）**:
  - `POST /api/specs/launch` が `chat` を受け取り `Chat:` 行と `pipeline-runs.json` を記録できること（`specs.test.js`）。
  - `pipelineWatcher.test.js` で ①初回ベースラインで過去分を送らない ②Spec 全件 `done` 時の統合 Markdown 生成と Git 情報・`followUpPrompt` 付与 ③一部 `blocked`/`failed` 停止時の `status: 'halted'` 要確認サマリ ④非 Spec（チャット起票）ボードウェーブの収束検知 ⑤高速完了タスク取りこぼし防止 ⑥同一ラン/ウェーブの重複通知抑止 ⑦`state.db` cwd マッチフォールバック＆`__latest__` フォールバック ⑧`review/feed.jsonl` を汚さないこと、を全件テストする。
  - `GET /api/specs/reports?board=` が 200 JSON で直近レポートを返すこと。
  - `npm run verify` が全件パスすること。

---

### Batch V4-3: チャット統合レポートカード・Tasks完了バナー・ワンタップ「次の一手を相談」

- **目的**: `kind: 'pipeline'` の統合レポートを `ChatPane.jsx` 内で Markdown リッチカードとして描画し、「💬 次の一手を相談」「📋 ボードを見る」ボタンを実装、さらに `TasksPane.jsx` に直近完走サマリバナーと `chat` 紐づけ Launch 送信、および `App.jsx` 経由のシームレス遷移（`__latest__` ハンドリング含む）を実装する（Section 3.3 / D20）。
- **変更ファイル**:
  - `apps/web/src/lib/chatReports.js`, `apps/web/test/chatReports.test.js`
  - `apps/web/src/features/ChatPane.jsx`, `apps/web/src/features/TasksPane.jsx`, `apps/web/src/App.jsx`
  - `apps/web/src/styles.css`, `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ja.json`
- **受入条件（Verify）**:
  - `ChatPane` タイムライン上で `kind: 'pipeline'` レポートが `MarkdownBody` 付きカード（折りたたみ切替対応）として描画され、「💬 次の一手を相談」タップで相談プロンプトが入力欄にセット＆フォーカスされること。
  - `'__latest__'` 宛のレポートに対して `otherUnreads` バナー「開く」や `TasksPane`「💬 チャットで次の一手を相談」から適切なチャットを開いて相談を開始できること。
  - `TasksPane` の Spec Launchpad がアクティブチャット ID（`readActiveChatId`）を送信し、ボード上の最新パイプライン完了バナーを表示できること。
  - `npm run verify` が全件パスし、`noHardcodedJapanese` 違反ゼロ・日英 i18n キー整合が取れること。

---

### Batch V4-4: 全体結合検証・実画面マルチビューポート監査 ＆ デプロイ

- **目的**: Batch V4-1〜V4-3 の全機能を結合検証し、`npm run verify` および `npm run deploy` を実行したうえで、ヘッドレスブラウザによりモバイル/タブレット幅（390×844 / 820×1180）・日英（EN/JA）・テーマ（Dark/Light）でのドロワー未読/更新/一括既読および統合完了レポートカードの表示・横溢れゼロを検証する。
- **変更・確認対象**:
  - `npm run verify`（全ユニットテスト ＋ `check:pwa` ＋ Vite 本番ビルド）
  - `npm run deploy`（実環境デプロイ・サービス反映）
  - ヘッドレスブラウザ実画面検査（オーバーフローゼロ・コンソールエラーゼロ・EN/JA・Dark/Light）
- **受入条件（Verify）**:
  - `npm run verify` および `npm run deploy` がエラーゼロで完了すること。
  - `390×844`・`820×1180`（EN/JA・Dark/Light）でドロワー操作バーおよび統合 Markdown レポートカードの文字切れ・横スクロール溢れ（`scrollWidth <= clientWidth`）が `0` 件であること。
  - テスト用一時ファイルやスクショゴミをリポジトリ内に残さないこと（または `git status` をクリーンに保つこと）。

---

## 5. Hermes Agent 自律実行プロンプト（コピペ用）

以下のプロンプトをチャットへそのまま貼り付けるか、PWA「Tasks → 🚀 Spec Launchpad」から `docs/SPEC-PILOT-V4.md`（Batch V4-1 〜 V4-4）を一括起票して実行してください:

```text
docs/SPEC-PILOT-V4.md を精読し、Section 4 の Batch V4-1 から Batch V4-4 までを順番に自律実装・検証してください。

厳守事項:
1. 各バッチの開始前に既存コード（ChatPane.jsx / sessionUnread.js / chatReports.js / TasksPane.jsx / review-watcher.js / specs.js / review.js / server.js）と関連テストを読み、V3 までの既存動作・制約（特に apps/web/test/noHardcodedJapanese.test.js と review/feed.jsonl を汚さない境界）を壊さないこと。
2. 1 バッチごとに必ず `npm run verify`（全ユニットテスト＋check:pwa＋vite build）を通し、通ってから次のバッチへ進むこと。
3. 全バッチ完了後、`npm run deploy` を実行し、ヘッドレスブラウザ等で PWA（390x844 / 820x1180・EN/JA・Dark/Light）と主要コンポーネント（Drawer開封時の自動更新＋「↻ 更新」「✓ すべて既読」、開いたチャット切替後も未読が復活しないこと、統合 Pipeline Completion Report カードと「💬 次の一手を相談」導線）の実画面・横溢れゼロ検証を行い、修正が必要なら直して再 verify すること。
4. 判断が必要な論点が出た場合のみ quick-review または annotation タスクを起票し、それ以外は完走まで止まらず走り切ること。
```
