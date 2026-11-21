# SPEC: Hermes Pilot v6 (`SPEC-PILOT-V6`) — Architect進行可視化・agy自動フォールバック・Spec階層アコーディオン＆MDプレビュー・Demo Google Sites対応仕様書

- **Status**: archived
- **アーカイブ日**: 2026-11-21（COH-4・全バッチ完了済み。以後は参照用に保持し、新規起票の対象外）

状態: **仕様確定（2026-11-15 Q1〜Q4 インタビュー D28〜D32 合意済み）**
前提仕様: [SPEC-PILOT-V5.md](./SPEC-PILOT-V5.md)（`e1a8944` まで実装・実機検証済み）
想定実装ランナー: **Hermes Agent（Spec Launchpad 一括起票: Batch V6-1 〜 V6-5）**

> **注意（プロジェクト制約・実装時厳守）**:
> - `apps/web/src/` 配下では `apps/web/test/noHardcodedJapanese.test.js` により JSX/JS への生日本語リテラル記述が禁止されている。UI 文言は必ず `apps/web/src/i18n/en.json`・`ja.json` に定義し `t(...)` 経由で参照すること（`apps/web/src/lib/*.js` 内のコメント以外の文字列も ASCII のみ）。
> - `apps/bridge/src/specs.js` が誤認しないよう、バッチ以外の `###` 見出しはすべて数字で始めること（`### 3.1 ...` 等）。バッチ見出しのみ `### Batch V6-x:` とする。
> - **OAuth 境界の厳守**: `scripts/check-oauth-boundary.mjs` および `apps/bridge/test/architect.test.js` が機械検査を行うため、`agy` や `.gemini` の認証情報・トークン・プロファイルへ直接触れるコードは一切書かない。公式ローカル CLI のサブプロセス実行のみに留める。
> - **レスポンシブ監査とタッチ領域**: `npm run audit:responsive`（`scripts/audit-responsive.mjs`）が `390x844` 〜 `1180x820` の全タブ・全言語で横溢れと 44px 未満の新規タップ要素増加を検査する。新規ボタンは原則 `.btn`・`.pick-item`・既存ピルクラスを踏襲し、十分なタップ領域または既存 baseline との整合を保つこと。

---

## 1. コンセプトとV5実機検証からの課題解決

`SPEC-PILOT-V5` の実機検証を通じて、A2B（Architect-to-Builder）パイプライン全体の導線は機能した一方、実用上のボトルネックが 4 点判明した。`SPEC-PILOT-V6` はこれらを解消し、**「スマホだけで Spec 策定 → レビュー → 起票 → 自走完走 → 検証」が迷わず・止まらず完結する状態**へ仕上げる。

1. **`agy` Opt-in 停止の根本解消 ＆ 自動フォールバック + Architect 進行バー（Q1=A / D28）**
   - **判明した原因**:
     1. `capabilities.js` は `agyCliDirs` / `hermesCliDirs` からバイナリを検出できる一方、`architect.js` の `createCliRunner` が `process.env.PATH` のまま裸の `'agy'` / `'hermes'` を起動していた（`launchd` 環境では `~/.local/bin` や `~/.hermes/.../bin` が `PATH` に無い）。
     2. `createCliRunner` の CLI 引数不整合（`agy` へ存在しない `--workspace`、また macOS で `agy` が IDE ランチャーとして振る舞う場合はシートや SPEC を作らず即終了し、`awaiting_spec` のまま無音停止する）。
     3. `SpecSeedSheet.jsx` で送信直後にトーストを出してシートを閉じた後、バックグラウンドの Architect ジョブが `running` なのか、Review シート待ち（`awaiting_review`）なのか、`failed` で止まっているのかを画面に表示する UI が無かった。
   - **V6 の解決策**:
     - `capabilities.js` でバイナリ実パス解決（`resolveHermesBin` / `resolveAgyBin` / `buildAugmentedPath`）を共通化し、コマンド実行時の `PATH` を確実に補う。
     - `architect.js` は既定の `hermes` 実行・および `agy` 失敗/成果物未生成（非0終了または `0` 終了かつ Review タスク・SPEC どちらも未生成）時の**自動フォールバック**として、既存の確実なカンバン自走経路（`hermes kanban create --assignee mobile` による `[ARCH]` Architect タスク起票）で `spec-architect` プロトコルを確実に完走させる。
     - 画面上部（`TasksPane` / `ChatPane` の `SpecReadyBanner` 上部）に軽量な **`ArchitectJobBar`** を新設し、`running`（経過時間・ランナー表示）/ `awaiting_review`（**1タップで Quick Review へ遷移**）/ `awaiting_spec`（仕様書生成中）/ `failed`（エラー要約＋**1タップ「Hermes Native で再試行」**）をリアルタイム表示する。

2. **Spec Launchpad ＆ バッチ履歴シートの階層整理（Q2=A / D29）**
   - **判明した課題**:
     - Spec Launchpad（`specSheetOpen`）およびバッチ履歴（`specHistoryOpen`）の上部にある「SPEC 切り替え」が全 SPEC を常時縦に並べていたため、履歴が増えるほど本題のバッチ一覧が画面下へ押し流されていた。
     - 一方、完了バッチ履歴の各行は展開しても `ModePill` と完了時刻しか出ず、どんな目的で何をしてどう終わったのかが追いづらかった。
   - **V6 の解決策**:
     - 上部の SPEC セレクタは両シートとも**「現在選択中の SPEC 1 件のみ常時表示（`.pick-item.spec-now` ＋ ▾）」**に統一し、タップしたときだけアコーディオンで全 SPEC 一覧を展開する（選択したら自動で閉じる）。
     - 下部の各バッチ行（バッチ履歴）はタップで展開すると、**`ModePill`・状態・完了時刻・目的（Objective）・実行結果サマリ（`task.result`）・Git コミット（`sha` / `subject`）・「🔍 タスク詳細・差分を見る」ボタン・仕様/受入条件抜粋（Markdown）**を表示する。Spec Launchpad 側でもチェックボックス選択を維持したまま `詳細 ▾` で抜粋を確認できるようにする。

3. **アプリ内での仕様書（`SPEC-*.md`）Markdown プレビュー（Q3=A / D30）**
   - 完了前の Spec Launchpad・完了後のバッチ履歴・新着 SPEC 通知バナー（`SpecReadyBanner`）の **3 箇所すべて**から **`📄 仕様書(MD)をプレビュー`** ボタンを 1 タップで開き、`GET /api/specs/content` で取得した該当 `.md` の全文を既存の軽量安全レンダラ（`renderMarkdown`）で閲覧できるようにする。

4. **Spec 検知リフレッシュ改善 ＆ Interactive Demo V6 同期・Google Sites 埋め込み準備（Q4=A / D31・D32）**
   - Architect が新規 `docs/SPEC-*.md` を生成した瞬間や手動更新ボタン押下時に、`specsInfo`（Launchpad バー用一覧）も自動再取得されるよう改善。
   - `mockApi.js` とデモビルド機構に V6 機能（複数 SPEC 切替・MD プレビュー・バッチ詳細/差分・Architect Seed/進行バー）を同期させ、さらに Google Sites の「URL 埋め込み」「コード埋め込み（単一 HTML `dist-demo/google-sites-embed.html`）」の両方で安全に動くよう下地を整備する（デモビルド実行自体は V6 実装完了後にユーザー要望タイミングで実行する構成）。

---

## 2. 合意決定表（インタビュー D28〜D32）

| # | 論点 | 決定内容 | 根拠・背景 |
|---|---|---|---|
| **D28** | `agy` Opt-in 停止の修復方針と進行可視化 | **自動カンバンフォールバック ＋ 画面上部リアルタイム進行バー（Q1=A）**。<br>・`capabilities.js` にフルパス解決と拡張 `PATH` を集約。<br>・`agy` は正しいフラグ（`-p <prompt> --mode auto`、作業ディレクトリ `cwd: repoPath`）で実行し、非0終了または成果物（Review タスク / SPEC）未生成で終了した場合は自動で `Hermes Native` カンバン Architect タスク（`[ARCH]`）へフォールバック。<br>・通常時の `Hermes Native` も CLI 直接呼び出しではなく安定したカンバン起票（`hermes kanban create --assignee mobile`）経由とし、UI 上部の `ArchitectJobBar` で `running` / `awaiting_review`（1タップ Review 遷移）/ `failed`（再試行ボタン）を表示する。 | `launchd` の狭い `PATH`・macOS の `agy` ラッパー挙動・バックグラウンド無音停止の 3 つを同時に潰し、Opt-in をオンにしても絶対に進行が止まらないようにするため。 |
| **D29** | Launchpad / 履歴シートの SPEC 選択とバッチ詳細 | **上部 SPEC 選択は 1 件表示＋タップアコーディオン展開に統一し、下部バッチはタップ展開でリッチ詳細を表示（Q2=A）**。<br>・上部: 既定は選択中 SPEC のみ 1 行表示。タップで他 SPEC を選んで自動収納。<br>・下部（履歴）: 展開時に `ModePill`・日時・目的・実行結果（`result`）・Git commit・`🔍 タスク詳細・差分を見る`（`openTask` 遷移）・Verify 抜粋を表示。<br>・下部（Launchpad）: 1タップでの `☑/☐` 選択を妨げない独立の `詳細 ▾` トグルで Verify 抜粋を確認可能にする。 | SPEC 数が増えても画面上部が圧迫されず、履歴からは結果・差分まで 1 シートから即辿れるようにするため。 |
| **D30** | 仕様書 Markdown プレビュー導線 | **Launchpad シート・バッチ履歴シート・新着 SPEC バナーの 3 箇所すべてに配置（Q3=A）**。<br>・`GET /api/specs/content?board=&repo=&path=` で対象 `.md` 本文を取得（`resolveSpecPath` でリポジトリ外アクセスを完全遮断）。<br>・`renderMarkdown` を使い、元シートの上または切替ビューで全文を表示する。 | 承認前（バナー）、起票前（Launchpad）、完了後（履歴）のどの文脈からでも元の仕様書そのものをスマホ上で確認できるようにするため。 |
| **D31** | `specsInfo` の同期漏れ解消 | `TasksPane.jsx` で `loadSpecs` を独立 `useCallback` 化し、ボード切替時だけでなく **`refreshAll`（手動更新）、一括起票直後、`architectJobs` で新 SPEC が検知された瞬間**にも再取得する。 | Seed で新規 SPEC が作られてもタスクタブをリロードするまで `🚀 仕様ランチャー` に出ない不整合を防ぐため。 |
| **D32** | Interactive Demo の V6 同期と Google Sites 対応 | **デモデータに V6 機能（複数 SPEC・MD プレビュー・バッチ詳細・Architect 進行）を同期し、Google Sites 用の「URL 埋め込み」「コード埋め込み（単一 HTML）」両対応ビルドを準備（Q4=A）**。<br>・サンドボックス化された Google Sites iframe 内で相対 iframe URL や `localStorage` が制限されるケースに備え、自己完結インライン HTML（`dist-demo/google-sites-embed.html`）生成スクリプトおよび安全なストレージ・フォールバックを組み込む。 | V6 および微調整完了後、任意のタイミングで `npm run build:demo` を走らせるだけで即 Google Sites へデプロイ確認できる状態を整えるため。 |

---

## 3. 詳細技術仕様

### 3.1 CLI バイナリ解決の共通化（`apps/bridge/src/capabilities.js`）

対象: `apps/bridge/src/capabilities.js`, `apps/bridge/test/capabilities.test.js`, `apps/bridge/src/capture.js`, `apps/bridge/src/specs.js`, `apps/bridge/src/ops.js`

1. **ヘルパー関数の追加と公開**:
   - `findBinaryPath(name, dirsOrPathEnv)`:
     - `hasBinary` と同様に実行ビット（`fs.constants.X_OK`）を確認し、最初に見つかった実行ファイルの**絶対パス**（例: `/Users/.../.local/bin/agy`）を返す純関数に近いヘルパー。無ければ `null`。
   - `resolveHermesBin({ pathEnv = process.env.PATH ?? '', home = os.homedir(), accessSync } = {})`:
     - `pathEnv`（`path.delimiter` 区切り）および `hermesCliDirs(home)` を順に探し、見つかれば絶対パス、見つからなければ `'hermes'` を返す。
   - `resolveAgyBin({ pathEnv = process.env.PATH ?? '', home = os.homedir(), accessSync } = {})`:
     - `pathEnv` および `agyCliDirs(home)` を順に探し、見つかれば絶対パス、見つからなければ `'agy'` を返す。
   - `buildAugmentedPath({ pathEnv = process.env.PATH ?? '', home = os.homedir() } = {})`:
     - 既存 `pathEnv` の末尾（重複除外）に `hermesCliDirs(home)` と `agyCliDirs(home)` を連結した `PATH` 文字列を返す。
2. **境界（ToS / OAuth）維持**:
   - 探索するのは実行ファイル名（`hermes`, `agy`）の存在と実行権のみ。資格情報・プロファイル・トークンファイルには一切触れない。
3. **既存 CLI 呼び出しの `PATH` / バイナリ解決補強**:
   - `capture.js`・`specs.js`・`ops.js`・`architect.js` のデフォルト `execFile` でも `cfg.hermesBin ?? resolveHermesBin()` および `env: { ...process.env, PATH: buildAugmentedPath() }` を使えるようにし、`launchd` 下でもサブプロセスやその孫プロセスが `hermes` を見つけられない問題を根絶する。

---

### 3.2 Architect 実行の安定化・自動フォールバック・Review 状態連動（D28）

対象: `apps/bridge/src/architect.js`, `apps/bridge/test/architect.test.js`, `apps/bridge/src/server.js`

1. **`createCliRunner(cfg)` と 2 系統ディスパッチの刷新**:
   - **問題点の修正**:
     - 旧実装では `hermes` に `-z <prompt> --in <repo>`、`agy` に `--prompt <prompt> --workspace <repo>` を渡していたため、起動失敗や意図しない挙動を起こしていた。
   - **Hermes Native（既定、`runnerId === 'hermes'`）**:
     - `resolveHermesBin()` で `hermes kanban --board <board> create "<title>" --assignee mobile --json --body "<body with Execution Contract / spec-architect instructions>"` を実行し（既存の `capture.js` / `specs.js` と同じ正規ルート）、即座に自走ワーカーが着火するカンバンタスク `[ARCH] <seed要約>` を起票する。
     - ジョブには `taskId`（`parseCreatedTask` で取得）と `mode: 'kanban'` を記録する。
   - **Antigravity Opt-in（`runnerId === 'antigravity'`）**:
     - `resolveAgyBin()` を使い、正確な引数 `['-p', prompt, '--mode', 'auto']`（作業ディレクトリ `cwd: repoPath`、タイムアウト `RUNNER_TIMEOUT_MS`、`env.PATH = buildAugmentedPath()`）で公式 `agy` CLI をサブプロセス実行する。
     - **自動フォールバック検証**: `agy` サブプロセスが終了した後、以下の両条件をチェックする:
       1. `res.code !== 0`（コマンド失敗・認証未設定・非対応フラグ・タイムアウト等）
       2. `res.code === 0` であっても、`findJobSpec(job, listSpecsFn(repoPath))` で新 SPEC が見つからず、かつ `findJobReviewTask(job, readTasks(job.board))` で新規 `[review]` タスクも見つからない場合（macOS で IDE ランチャーがウィンドウだけ開いて即 exit 0 したケース等）。
     - 上記のいずれかに該当した場合、ジョブをいきなり `failed` にせず、**同一ジョブ内で自動的に Hermes カンバン Architect ランナー（`dispatchKanbanArchitect`）へフォールバック**する！
       - 成功時: `job.runner = 'hermes'`（`job.requestedRunner = 'antigravity'`、`job.fallbackFrom = 'antigravity'`、`job.fallbackReason = <短い英語コードまたは抜粋>`、`job.taskId = <taskId>`）に更新し、ステータスを `running`（`awaiting_review` / `awaiting_spec` 遷移可）として継続する。
       - フォールバック先（カンバン起票）自体も失敗した場合のみ `job.status = 'failed'` とし、理由を `job.error`（先頭 600 文字）に保存する。
2. **ライブ段階判定（`awaiting_review` 検知）と `jobsFor()` の拡張**:
   - `findJobReviewTask(job, tasks)`:
     - `board` のタスク一覧から、① `job.taskId` と一致するタスク（または同じラベル・同じ `createdAt >= job.startedAt - 5000` の `[review]` タスク）を探索する純関数を追加する。
     - タスクが存在し、`status === 'blocked'` で本文に `[review]`（または `review.label`）が含まれている場合、`{ taskId, title, status }` を返す。
   - `jobsFor()` 内で `running` / `awaiting_spec` のジョブに対して次を順番に評価する:
     1. まず `findJobSpec` で新 SPEC が見つかった → `spec_ready`（既存動作 + `autoStart`）。
     2. まだ新 SPEC が無く、対応するカンバンタスクまたは `[review]` タスクが `blocked` 状態 → ジョブの公開表現上の `stage`（または `status`）を `'awaiting_review'` とし、`reviewTaskId`・`reviewTitle` を返す（注意: 既存の `architect.test.js` が `runner` モック直後に `status === 'awaiting_spec'` を期待するケースを壊さないよう、CLI 正常終了で `taskId` 無し・blocked レビューも無い従来ケースは従来通り `'awaiting_spec'` とする）。
     3. カンバン起票した `job.taskId` のタスクが `failed` になっている場合 → ジョブも `status: 'failed'`・`error: task.result || 'Architect task failed'` へ同期する。
     4. ジョブが `running`（カンバンタスク進行中）なら `stage: 'running'`、レビュー回答済みで `running` / `ready` へ戻ったなら `stage: 'awaiting_spec'`（仕様書執筆中）が分かるよう `taskStatus` を載せる。
   - `publicJob(job)` に以下を追加する（すべて非機密）:
     - `requestedRunner`: 元の選択（`'hermes' | 'antigravity'`）
     - `fallbackFrom`: フォールバック元のランナー（無ければ `null`）
     - `fallbackReason`: 短い理由（無ければ `null`）
     - `taskId`: カンバン Architect タスク ID（無ければ `null`）
     - `reviewTaskId`: 待ち受け中の Quick Review タスク ID（無ければ `null`）
     - `reviewTitle`: 待ち受け中の Quick Review タスクタイトル（無ければ `null`）
3. **リトライ互換と既存 API 契約**:
   - `POST /api/architect/seed` は、新規シードに加え、画面の「Hermes Native で再試行」ボタンから `{ repo, board, seedText, runner: 'hermes', autoStart, chat, lang }` でそのまま再投入できる。
   - `server.js` 側で `createArchitect(cfg, { ... })` に渡す runner 等が上記 DI（`execFile` の PATH 補完と `readTasks` 参照）を通るよう配線する。

---

### 3.3 Architect 進行バー UI ＆ リフレッシュ同期（D28 UI / D31）

対象: `apps/web/src/components/ArchitectJobBar.jsx`（新規）, `apps/web/src/lib/specSeed.js`, `apps/web/test/specSeed.test.js`, `apps/web/src/features/TasksPane.jsx`, `apps/web/src/features/ChatPane.jsx`, `apps/web/src/i18n/{en,ja}.json`, `apps/web/src/styles.css`

1. **純粋ロジック拡張（`apps/web/src/lib/specSeed.js`）**:
   - `jobStatusKey(status)` に `'awaiting_review'` -> `'seed.statusAwaitingReview'` を追加（既存 5 状態のテストは維持）。
   - `pickActiveArchitectJob(jobs, dismissedIds = [])` を追加:
     - `jobs` の中から未 dismiss（`!dismissedIds.includes(j.id)`）かつ最新の注目すべきジョブ（`running` / `awaiting_review` / `awaiting_spec` / `failed`）を 1 件返す（`spec_ready` / `launched` になったジョブは既存の `SpecReadyBanner` が引き継ぐので `ArchitectJobBar` には出さない！）。
2. **`ArchitectJobBar.jsx` コンポーネント**:
   - **表示パターン**:
     - `status === 'running' || status === 'awaiting_spec'`:
       - スピナー（`<Spinner size={14} />`）、状態文言（例: `Architect が設計中…` / `仕様書を書いています…`）、経過時間（分/秒）、種（seed）の 1 行要約、ランナーピル（`fallbackFrom === 'antigravity'` のときは `Hermes Native (agy 自動フォールバック)` バッジを表示し、なぜ切り替わったかを透過的に伝える）。
     - `status === 'awaiting_review'`:
       - ハイライトカード: `📝 インタビューシートが Review に届きました` ＋ `reviewTitle` ＋ **1 タップボタン `🔍 Review を開く`**（押すと `window.dispatchEvent(new CustomEvent('hm:open-review', { detail: { taskId: job.reviewTaskId } }))` を発火してそのまま Quick Review 画面へ遷移！）。
     - `status === 'failed'`:
       - 警告カード: `⚠️ Architect が停止しました` ＋ `job.error` の要約（最大 2 行）＋ **1 タップボタン `🔄 Hermes Native で再試行`**（`POST /api/architect/seed` を `runner: 'hermes'` で再実行）＋ `×` 閉じるボタン。
3. **ポーリング間隔と即時同期（D31）**:
   - `TasksPane.jsx` と `ChatPane.jsx` の両方で、`activeJob` が存在するとき（`running` / `awaiting_review` / `awaiting_spec`）だけポーリング間隔を **20 秒 → 4 秒** に短縮し、`agy` フォールバックやシート到達を即座に画面へ反映する。通常待機時は 20 秒のまま節約する。
   - `TasksPane.jsx` で SPEC 一覧取得を `loadSpecs(boardSlug)` に切り出し、以下 4 タイミングで呼ぶ:
     1. ボード変更時（従来）
     2. `refreshAll()`（タスクタブの更新ボタン押下時）
     3. `fileSpecBatches()` 完了時
     4. `architectJobs?.specReady` または `architectJobs?.pending` の件数/最新タイムスタンプが変化したとき（`Spec Seed` で SPEC が書かれたらリロード不要で `🚀 仕様ランチャー` バーが出現・最新化する）。
   - `SpecSeedSheet.jsx` で送信成功時、渡されている `onSeeded?.(res)` が即座に `loadArchitectJobs()`（Chat 側では `loadSpecJobs()`）を呼び、シートを閉じた直後から画面上部に `ArchitectJobBar` が出るようにする。

---

### 3.4 仕様書 Markdown 取得 API ＋ 3箇所 MD プレビュー UI（D30）

対象: `apps/bridge/src/specs.js`, `apps/bridge/test/specs.test.js`, `apps/bridge/src/server.js`, `apps/web/src/components/SpecMarkdownSheet.jsx`（新規）, `apps/web/src/components/SpecReadyBanner.jsx`, `apps/web/src/features/TasksPane.jsx`, `apps/web/src/features/ChatPane.jsx`, `apps/web/src/i18n/{en,ja}.json`, `apps/web/src/styles.css`

1. **ブリッジ側 API (`GET /api/specs/content`)**:
   - `apps/bridge/src/specs.js` に `readSpecContent(repoPath, specRelPath)` を追加・エクスポート:
     - `resolveSpecPath(repoPath, specRelPath)` で絶対パスへ解決し、`repoPath` 外・絶対パス・空パスは `ApiError`（400）で弾く。
     - さらに安全のため、対象ファイル名チェック（または `.md` ファイルであることの検証：`!/\.md$/i.test(file)` なら `400 SPEC_READ_FAILED`）を行い、`fs.statSync` と `fs.readFileSync(file, 'utf8')` で読み取る。
     - サイズ上限保護: 読み取った生テキスト（最大 256KB までそのまま返却、超過時は `truncated: true` 付きで先頭から切る）と `parseSpec(text)` の `title`, `batches.length`, `mtime` を返す:
       ```json
       {
         "ok": true,
         "path": "docs/SPEC-PILOT-V6.md",
         "title": "SPEC: ...",
         "mtime": 17947...,
         "batchCount": 5,
         "truncated": false,
         "markdown": "# SPEC: ..."
       }
       ```
   - `apps/bridge/src/server.js` の `/api/specs` ルーティングに `if (b === 'content' && req.method === 'GET')` を追加:
     - クエリパラメータ: `board` / `repo` / `path`（必須）。
     - `resolveSpecRepo({ repoId: url.searchParams.get('repo'), boardSlug: url.searchParams.get('board') })` でリポジトリを解決し、`readSpecContent(target.path, url.searchParams.get('path'))` を呼ぶ。エラー時は既存同様に適切な 400 / 404 JSON を返す。
2. **フロントエンド MD プレビュー UI (`SpecMarkdownSheet.jsx`)**:
   - `renderMarkdown(markdown, { onCopyCode, copyLabel })`（既存 `apps/web/src/lib/markdown.js`）を使用して安全に Markdown 本文を描画する（XSS ゼロ、テーブル・見出し・箇条書き・コードブロック対応）。
   - ※補足: もし仕様書本文に Markdown テーブル（`| Col | ... |`）が多く含まれる場合でも可読性が落ちないよう、`apps/web/src/lib/markdown.js` の見栄え（またはテーブルの横スクロール付き軽量ブロック描画 / preformatted 整形）を確認し、必要なら軽量テーブルパース（外部依存なし）も検討・追加する（既存 `markdown.test.js` を壊さない範囲）。
   - 上部メタバー: 相対パス（例: `docs/SPEC-PILOT-V6.md`）、更新日時（`relTime(mtime)`）、バッチ数ピル、**`📋 本文コピー`**（`navigator.clipboard` 使用可環境）＋ 閉じるボタン（`✕`）。
   - **配置する 3 箇所（Q3=A）**:
     1. **Spec Launchpad シート（`TasksPane` / `specSheetOpen`）**: シート上部（パスの横またはツールバー）に `📄 仕様書(MD)をプレビュー` ボタン。
     2. **バッチ履歴シート（`TasksPane` / `specHistoryOpen`）**: シート上部に `📄 仕様書(MD)をプレビュー` ボタン。
     3. **新着 SPEC バナー（`SpecReadyBanner.jsx` — Chat / Tasks 両対応）**: メインの `🚀 一括起票して開始` ボタンの横（または下部アクション列）にコンパクトな **`📄 仕様書を読む`** ボタン（`onPreview?.(banner)`）。狭幅 390px でもボタンがはみ出さないようフレックス折り返し・十分な高さを確保する。

---

### 3.5 Spec Launchpad ＆ バッチ履歴シートの階層刷新（D29）

対象: `apps/web/src/features/TasksPane.jsx`, `apps/web/src/styles.css`, `apps/web/src/i18n/{en,ja}.json`

1. **上部 SPEC セレクタ（1 件表示＋タップでアコーディオン展開）**:
   - State 追加: `const [specPickerOpen, setSpecPickerOpen] = useState(false)`（`openSpecSheet` / `openSpecHistory` を開くたびに `false` に初期化し、閉じたときもリセット）。
   - **常時表示行**:
     - `specList` が 1 件以上ある場合、現在選択中の `currentSpec` 1 件だけをボタン（`.pick-item.spec-now`）として表示する:
       - 左: `📄 {currentSpec.title}` / サブ行に `{n} バッチ · 更新 {relTime(currentSpec.mtime)} · {currentSpec.path}`
       - 右（`specList.length > 1` のとき）: `{t('tasks.specCountOf', { n: specList.length })}`（例: `全7件`）＋回転するシェブロン `▾` / `▴`（`aria-expanded={specPickerOpen}`）。
   - **展開時のアコーディオン（`specPickerOpen && specList.length > 1`）**:
     - 下に `.pick-list.spec-accordion` を展開し、他の SPEC も選択可能にする。1 件タップすると `setSpecPath(sp.path)`、`setSpecPickerOpen(false)`（Launchpad なら新しい SPEC 用の未起票バッチで `setSpecSel` も再初期化！）を即時実行する。
     - ※注意: 現行コード（`TasksPane.jsx:1022`）では SPEC 切替時に古い `filedBatchIds`（旧 `currentSpec` 基準の Set！）を参照していたバグがあるため、**新しく選んだ `s.batches` に対して `specProgress(s.batches, tasks)` を計算し直してから未起票バッチを初期選択する**よう修正する！
2. **下部バッチ履歴（`specHistoryOpen`）のタップ展開詳細**:
   - 各バッチ行 `<details className="pick-item history-row">` の `<summary className="history-summary">` は 1 行コンパクト表示のまま維持（一覧性確保）。
   - タップして開いた `.history-body` に以下を整理して表示する:
     1. **ステータス＆モードヘッダ行**: `<ModePill batch={b} t={t} />` ＋ ステータス文字 ＋ 開始/完了時刻（`relTime`）。
     2. **目的（`b.objective`）**: 省略せず表示。
     3. **実行結果 ＆ Git コミット（`task` がある場合）**:
        - `task.result` がある場合は折りたたみなしの読みやすい `.history-result` ボックスに表示。
        - `task.git?.head` がある場合は `.git-badge`（`sha` + `subject`）を表示。
        - **1 タップ詳細遷移ボタン**: `🔍 タスク詳細・差分を見る` ボタンを配置し、タップで `setSpecHistoryOpen(false)` したうえで `openTask(task)` を呼び出し、変更ファイル一覧・diff パッチ・イベントタイムラインへ直接飛べるようにする。
     4. **仕様・受入条件抜粋（`b.section`）**: インライン折りたたみ（`<details className="history-sub-details">` で `受入条件・仕様抜粋 ▾`）として `renderMarkdown(b.section)` を描画し、長い仕様本文でも画面が煩雑にならないようにする。
3. **下部 Launchpad（`specSheetOpen`）のバッチ詳細チラ見**:
   - 各バッチカードの左側/本体タップは引き続き **チェックボックス選択（`☑` / `☐`）** として軽快に操作できる構成を保つ。
   - 右側（またはカード下端の独立ボタン）に小さな `仕様・Verify ▾` ボタン（`e.stopPropagation()` 付き）を設け、タップでそのバッチの `b.section`（変更ファイルや Verify 条件）だけをインライン展開して確認できるようにする（起票前の最終確認が Launchpad 内で完結する）。

---

### 3.6 Interactive Demo V6 同期 ＆ Google Sites ビルド準備（D32）

対象: `apps/web/src/demo/mockApi.js`, `apps/web/src/demo/DemoStage.jsx`, `apps/web/src/demo/DemoBanner.jsx`, `apps/web/src/demo/frame.js`, `apps/web/test/demoMode.test.js`, `scripts/build-demo-embed.mjs`（新規）, `package.json`

1. **`mockApi.js` の V6 機能同期**:
   - `demoSpects()` に複数のデモ仕様書を載せる（先頭は既存と同じ `DEMO_SPEC_PATH` (`docs/SPEC-DEMO-V1.md`) にし、2 件目・3 件目として `docs/SPEC-PILOT-V5.md`・`docs/SPEC-PILOT-V4.md` のダイジェスト仕様を追加）→ デモ画面上でも V6 の **SPEC 選択アコーディオン** を操作可能にする（既存の `demoMode.test.js` の仕様件数アサーションを複数件対応へ更新する）。
   - `demoRoute` と `demoFetch` に以下ルートを追加:
     - `GET /api/specs/content`: `path` に応じたデモ用の充実した Markdown 全文（見出し・決定表・バッチ・Verify 付き）を返す → 3 箇所すべての `📄 仕様書(MD)をプレビュー` がデモで動く。
     - `GET /api/boards/:slug/tasks/:id` および `/diff`：デモのバッチタスク（`t_demo_done`, `t_demo_demo-1` 等）に `body`, `result`, `git: { head, branch, subject }`, `events` とファイル差分サマリを返し、履歴展開後の **「🔍 タスク詳細・差分を見る」** までデモ内で完結させる。
     - `GET /api/architect/jobs`, `GET/PUT /api/architect/config`, `POST /api/architect/seed`: デモ内で `🎙️ Spec Seed` を送信した場合、模擬ジョブが `running` → `awaiting_review` → `spec_ready` へ進み、`ArchitectJobBar` を擬似体験できるようにする。
2. **Google Sites デプロイ準備（単一自己完結 HTML + 埋め込み環境耐性）**:
   - **なぜ準備が必要か**:
     - Google Sites の「埋め込む → URL による埋め込み」（GitHub Pages 等に `dist-demo/` を置く場合）と、「埋め込む → 埋め込みコード」（HTML を直接貼り付ける場合、`srcdoc` や `googleusercontent.com` サンドボックス内で動くため相対 `./?demo-frame=1` の iframe が解決できず 404 になる + クロスオリジン iframe で `localStorage` が `SecurityError` を投げる場合がある）の 2 通りがある。
   - **V6 でのビルド機構整備**:
     - `DemoStage.jsx`: `globalThis.location?.protocol === 'about:'`（`srcdoc` 環境）や `?demo-inline=1`（インラインビルド識別子 `window.__HM_DEMO_INLINE_HTML__` 等）では、`<iframe src="./?demo-frame=1">` ではなく CSS コンテナシミュレーションまたは `srcDoc` を用いて二重 404 を防ぐ安全な分岐を入れる。また `vibe.js` / `theme.js` / `i18n/lang.js` 等の `localStorage` 読み書きはすべて `try/catch` で保護されているか監査し、禁止環境ではインメモリへ退避する。
     - `scripts/build-demo-embed.mjs`（新規）: Vite の `npm run build:demo`（`dist-demo/`）完了後、生成された CSS・JS バンドルを `index.html` の中へ `<style>` と `<script type="module">` としてインライン化した単一ファイル **`dist-demo/google-sites-embed.html`** を自動出力する（外部ファイル参照ゼロの単体貼り付け用HTML）。
     - `package.json`: `"build:demo": "VITE_DEMO_MODE=1 vite build --config apps/web/vite.config.js --outDir dist-demo --base ./ && node scripts/build-demo-embed.mjs"` へ更新。
     - ※ **運用方針**: このバッチではスクリプト・テスト・ビルド検証までを整える。ユーザーの実機/最終確認用ビルドは V6 および事後の微調整完了後いつでも `npm run build:demo` で最新化できる。

---

## 4. カンバンタスク分割（Batch V6-1 〜 V6-5）

### Batch V6-1: capabilities バイナリ解決共通化と Architect (agy自動フォールバック/Review段階検知) 刷新

- **Execution Mode**: `[Mode: Zero-Stop]`
- **目的**: `launchd` 環境での PATH 欠落と macOS `agy` CLI フラグ/ラッパー問題を解消し、`agy` 失敗・無生成時は自動で `Hermes Native` カンバン Architect（`[ARCH]`）へフォールバックさせ、さらに `awaiting_review`（`reviewTaskId` 付き）を `/api/architect/jobs` で返せるようにする。
- **変更・新規ファイル**:
  - 変更: `apps/bridge/src/capabilities.js`
  - 変更: `apps/bridge/test/capabilities.test.js`
  - 変更: `apps/bridge/src/architect.js`
  - 変更: `apps/bridge/test/architect.test.js`
  - 変更: `apps/bridge/src/capture.js`, `apps/bridge/src/specs.js`, `apps/bridge/src/ops.js`, `apps/bridge/src/server.js`
- **受入条件（Verify）**:
  - `capabilities.js` が `findBinaryPath`, `resolveHermesBin`, `resolveAgyBin`, `buildAugmentedPath` をエクスポートし、`capabilities.test.js` で PATH 不足環境からの解決・境界維持をテストで検証すること。
  - `architect.js` が `agy` に対して `['-p', prompt, '--mode', 'auto']` + `cwd: repoPath` + 拡張 PATH を用い、非0終了または Review タスク/SPEC 未生成での 0 終了時に自動で Hermes カンバン起票へフォールバックし、`fallbackFrom: 'antigravity'`・`fallbackReason`・`taskId` をジョブに記録すること。
  - `jobsFor()` がカンバン上の待機中 `[review]` タスクを検出し `status: 'awaiting_review'` / `reviewTaskId` / `reviewTitle` を返すこと（`architect.test.js` にモック検証を追加、既存テストおよび OAuth 境界テストも全通過）。
  - `npm test` と `npm run check:oauth` がパスすること。

---

### Batch V6-2: 仕様書 Markdown 本文取得 API (`GET /api/specs/content`) の実装

- **Execution Mode**: `[Mode: Zero-Stop]`
- **目的**: `docs/SPEC-*.md` の全文をリポジトリ境界内で安全に読み取る `readSpecContent` と `GET /api/specs/content` エンドポイントを追加し、アプリ内プレビューの基盤を提供する。
- **変更・新規ファイル**:
  - 変更: `apps/bridge/src/specs.js`
  - 変更: `apps/bridge/test/specs.test.js`
  - 変更: `apps/bridge/src/server.js`
- **受入条件（Verify）**:
  - `specs.js` に `readSpecContent(repoPath, specRelPath)` が追加され、`resolveSpecPath` によるディレクトリトラバーサル防止・`.md` 拡張子チェック・256KB 上限（`truncated` フラグ）付きで `{ ok, path, title, mtime, batchCount, truncated, markdown }` を返すこと。
  - `server.js` の `GET /api/specs/content?board=&repo=&path=` がリポジトリを解決して 200（または不正パスで 400 / 未検出で 404）を返すこと。
  - `apps/bridge/test/specs.test.js` に正常取得・`../` 拒否・非 `.md` 拒否のテストが追加され、`npm test` がパスすること。

---

### Batch V6-3: Architect リアルタイム進行バー UI・ワンタップ再試行・Spec 検知同期

- **Execution Mode**: `[Mode: Visual Gate]`
- **目的**: Spec Seed 送信後の進行状態（`running` / `awaiting_review` / `awaiting_spec` / `failed`）を Tasks / Chat 両画面の上部にリアルタイム表示し、`Review を開く`・`Hermes Native で再試行`・新 SPEC 自動反映を実現する。
- **変更・新規ファイル**:
  - 新規: `apps/web/src/components/ArchitectJobBar.jsx`
  - 変更: `apps/web/src/lib/specSeed.js`
  - 変更: `apps/web/test/specSeed.test.js`
  - 変更: `apps/web/src/features/TasksPane.jsx`
  - 変更: `apps/web/src/features/ChatPane.jsx`
  - 変更: `apps/web/src/features/SpecSeedSheet.jsx`
  - 変更: `apps/web/src/styles.css`
  - 変更: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ja.json`
- **受入条件（Verify）**:
  - `specSeed.js` の `jobStatusKey` が `'awaiting_review'` に対応し、`pickActiveArchitectJob` がアクティブ／失敗ジョブを適切に選び出す（`specSeed.test.js` で単体検証）。
  - `ArchitectJobBar.jsx` が `TasksPane` と `ChatPane` の両方に組み込まれ、`running`/`awaiting_spec` 中は 4 秒ポーリングで自動更新、`awaiting_review` では `🔍 Review を開く`（`hm:open-review` 発火）、`failed` では `🔄 Hermes Native で再試行` を 1 タップ実行できること。
  - `TasksPane.jsx` で `loadSpecs` が切り出され、更新ボタン（`refreshAll`）・起票直後・`architectJobs` 更新時に即時 SPEC バーが再同期されること。
  - `apps/web/src/` 配下に生日本語リテラルが無いこと（`noHardcodedJapanese.test.js` / `i18nLeak.test.js` / `npm run verify` パス）。
  - `npm run deploy` 後、Chrome ヘッドレス等で `390×844` と `820×1180`（EN/JA）の見た目を検証し、`npm run audit:responsive` がパスすること。

---

### Batch V6-4: Spec Launchpad・バッチ履歴の1行SPECセレクタ化＆リッチバッチ詳細＆3箇所MDプレビュー

- **Execution Mode**: `[Mode: Visual Gate]`
- **目的**: Launchpad とバッチ履歴の上部 SPEC 一覧を「選択中 1 件のみ表示・タップでアコーディオン展開」に整理し、下部バッチ履歴に目的・結果・Git コミット・タスク詳細遷移・Verify 抜粋を追加するとともに、Launchpad・履歴・Spec バナーの 3 箇所から仕様書 Markdown プレビューを開けるようにする。
- **変更・新規ファイル**:
  - 新規: `apps/web/src/components/SpecMarkdownSheet.jsx`
  - 変更: `apps/web/src/components/SpecReadyBanner.jsx`
  - 変更: `apps/web/src/features/TasksPane.jsx`
  - 変更: `apps/web/src/features/ChatPane.jsx`
  - 変更: `apps/web/src/lib/markdown.js`（テーブル簡易整形が必要な場合。既存テスト維持）
  - 変更: `apps/web/src/styles.css`
  - 変更: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ja.json`
- **受入条件（Verify）**:
  - `specSheetOpen` および `specHistoryOpen` の上部 SPEC 選択が初期状態で「選択中 1 件のみ表示（`.pick-item.spec-now`）」であり、タップ時のみ他 SPEC 一覧のアコーディオンが開き、別 SPEC 選択後に自動で閉じること（Launchpad では新 SPEC の未起票バッチだけで選択状態を再計算）。
  - `specHistoryOpen` の各バッチ展開時（`.history-body`）に、`ModePill`・状態・日時・`目的`・`task.result`・`git.head/subject`・`🔍 タスク詳細・差分を見る`（`openTask` 遷移）・折りたたみ式仕様抜粋が表示されること。Launchpad 側もチェックボックス選択を壊さずに各バッチの `詳細 ▾` で仕様抜粋が読めること。
  - `📄 仕様書(MD)をプレビュー` ボタンが Launchpad シート・バッチ履歴シート・`SpecReadyBanner` の 3 箇所すべてに配置され、タップで `GET /api/specs/content` を取得し `SpecMarkdownSheet` で読みやすく表示（コピーボタン・戻る機能付き）できること。
  - `npm run deploy` 後に `390×844` / `820×1180` の表示・タップ溢れを検証し、`npm run verify`（`audit:responsive` 含む）が全件パスすること。

---

### Batch V6-5: Interactive Demo の V6 同期 ＆ Google Sites 埋め込みビルド整備

- **Execution Mode**: `[Mode: Visual Gate]`
- **目的**: V6 で追加・改善した機能（複数 SPEC アコーディオン・MD プレビュー・バッチ詳細/差分・Architect 進行表示）をインタラクティブデモ（`mockApi.js`）に完全同期させ、Google Sites の「URL 埋め込み」「コード埋め込み（単一 HTML `dist-demo/google-sites-embed.html`）」両対応のビルド基盤を整える。
- **変更・新規ファイル**:
  - 変更: `apps/web/src/demo/mockApi.js`
  - 変更: `apps/web/src/demo/DemoStage.jsx`
  - 変更: `apps/web/src/demo/frame.js`
  - 変更: `apps/web/test/demoMode.test.js`
  - 新規: `scripts/build-demo-embed.mjs`
  - 変更: `package.json`
- **受入条件（Verify）**:
  - `demoSpects()` が複数 SPEC を返し、`demoFetch` が `/api/specs/content`・`/api/architect/config`・`/api/architect/jobs`・`/api/architect/seed`・`/api/boards/:slug/tasks/:id`・`/diff` を処理できること（デモ内の `📄 仕様書(MD)` プレビュー・アコーディオン・履歴詳細遷移・Spec Seed が動作する）。
  - `apps/web/test/demoMode.test.js` に上記新規ルート・複数 SPEC の自動検証が追加されていること。
  - `scripts/build-demo-embed.mjs` が `package.json` の `build:demo` に組み込まれ、`npm run build:demo` 実行時に通常静的サイト `dist-demo/` に加えて単一自己完結ファイル `dist-demo/google-sites-embed.html` をエラーなく生成し、サンドボックス iframe / `srcdoc` 環境でも相対 URL 404 や `localStorage` 例外で落ちないこと。
  - `npm run build:demo` と `npm run verify` の両方がパスし、かつ通常本番ビルド `apps/web/dist/` には `demo/` フィクスチャが混入しないこと。

---

## 5. 横断ガードレール（全バッチ共通）

1. **既存テストとの後方互換**:
   - `specs.js` / `architect.js` の既存エクスポート名・戻り値形は後方互換を保ったままフィールド追加する。
   - `apps/bridge/test/architect.test.js` の既存モック DI テスト（`seed` 直後の `awaiting_spec` 等）が壊れないよう、カンバン起票は正規ランナー（デフォルトまたは `hermes` カンバンディスパッチ）経由と DI 差し替え `deps.runner` を明確に分ける（`deps.runner` が渡されたユニットテストでは `deps.runner` の結果を使い、実運用デフォルトランナーでカンバン起票＋`agy` フォールバックを動かす構造が最もクリーン）。
2. **翻訳・文字列漏れゼロ**:
   - `apps/web/src/i18n/en.json` と `ja.json` に同じキーセットを追加し、`i18n.test.js` / `i18nErrorCoverage.test.js` / `i18nLeak.test.js` / `noHardcodedJapanese.test.js` をすべて通す。
3. **最終結合検証（必須）**:
   - 全バッチ完了後、`npm run verify` に加え `npm run build:demo` と `npm run deploy` を実行し、本番サービスへの影響がない形で成果物を揃えたうえ、1 つの簡潔な完走レポート（変更点・実行コマンドと exit code・未確認事項・次の一手）を返す。
