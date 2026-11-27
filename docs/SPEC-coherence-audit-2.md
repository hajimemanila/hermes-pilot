# SPEC: 整合性監査 2 周目 — 書き込みの原子性・CLI 境界・サイレント失敗・状態表・冪等 ID (`SPEC-COHERENCE-AUDIT-2`)

- **Status**: archived
- **状態**: 全 5 バッチ実装完了・アーカイブ済み（`COA2-1` D101 / `COA2-2` D102 / `COA2-3` D103 / `COA2-4` D104 / `COA2-5` D105 を 2026-11-22 に `main` へ反映済み）
- **決定の出所**: `~/.hermes/plugin-data/hermes-pilot/review/sheets/spec-coherence-audit-2-1.answer.json`（4 問・選択 4 / お任せ 0・note なし・global なし）
- **前提仕様**: [SPEC-spec-execution-mode-mode-zer.md](./SPEC-spec-execution-mode-mode-zer.md)（D96〜D100）/ [SPEC-COHERENCE.md](./SPEC-COHERENCE.md) / [SPEC-RELIABILITY-GUARD.md](./SPEC-RELIABILITY-GUARD.md) / [SPEC-EN-ZERO-LEAK.md](./SPEC-EN-ZERO-LEAK.md)
- **対象リポジトリ**: `hermes-mobile-pwa`（プラグイン名 `hermes-pilot` / `Hermes Pilot`）
- **SEMM と重複しないこと**: 前 SPEC（`SEMM-1`〜`SEMM-5`）は「正本の集約」（transport / sync / event payload / transition）で、commit 6 本（`029ac54` D96 / `0abd4b8` D97 / `cad4aeb` D98 / `0afd298` D99 / `ce490d6` D100 / `8ed1208` 回帰修正）で実装済み。本 SPEC は**別の層**（書き込みの原子性・外部 CLI の戻り値・失敗の符号化・状態表の範囲・冪等キー）だけを扱う。SEMM の決定は差し替えない。`COA2-4` だけは D99 の遷移表を**拡張**する（置き換えない）。
- **全バッチ共通の完了条件**:
  - `npm run verify` が exit 0（`npm test` / `check:dashboard` / `check:pwa` / `check:oauth` / `build` / `audit:responsive` / `check:term-enter` / `check:coherence`）
  - 外部 AI CLI のサブプロセス起動なし（`check:oauth`）・D55 非干渉（Hermes 本体の SQLite / cron DB へ直接書かない・承認なしの起票をしない）
  - `SPEC-EN-ZERO-LEAK` 遵守（CLI / Bridge のログ・`reason` は英語のみ。Web UI 文言は `en.json` / `ja.json` 同時追加）
  - **`[Mode: Zero-Stop]`**: 検証が落ちたら自分で直して再実行し、`npm run verify` が通るまで止まらない。通った時点で `done`（人の赤を待たない）
  - **行番号は 2026-11-22 16:50 時点の実測**。実装時は行番号ではなくシンボル名（`dedupeKey` / `makeJobId` / `TRANSITION_TABLE` / `sendOutcome` / `saveDismissed`）で探す
  - 先に片付けること: `apps/bridge/test/coherence.test.js` は **902 行**で `.hermes-coherence.json` の `maxLines: 800` を超えている（ラチェット超過）。テストを足すバッチは**最初のコミットで分割**する（§6.1）

---

## 1. 背景 — なぜ 2 周目が独立した SPEC になるのか

同じ種が 2 回 `[ARCH]` ジョブとして投入された（1 回目 `t_6a3af58e` → SEMM SPEC、2 回目 `t_6609599c` → 本カード）。ジョブ ID が `arch-<base36 時刻>-<乱数 4>`（`architect/seed.js` の `makeJobId`）で**種の内容を含まない**ため、同じ種でも別ジョブになる。これは Q4 で直す対象そのもの（`COA2-5`）。

ただし 2 回の証拠は**別の層**を指している。SEMM は「誰が正本か」（transport / sync / payload / transition）、今回の実測は「書き込み・外部呼び出し・失敗・ID」の作法。重複しないので、Q1-A に従って新 SPEC として仕様化する（`docs/SPEC-*.md` の一覧が 1 行増えるだけで、既存決定は動かない）。

### 1.1 実測（2026-11-22 16:50・読取専用）

| 層 | 実測 | 再現 |
| :--- | :--- | :--- |
| 状態ファイルの直書き | **10 か所**（`review.js:128` taskChats / `:546` `answer.json` / `:547` `answer.txt` / `:681` 検収レコード / `review/feeds.js:213` スクショ / `review/media.js:129` 注釈 PNG / `:145` `annotation.json` / `architect.js:275` dismissed / `:319` architect config / `auth.js:51` 認証トークン） | `grep -rn "writeFileSync" apps/bridge/src --include=*.js` の 21 行から tmp 書き込み 11 行を除く |
| tmp + `renameSync` | **11 か所**（`review-watcher.js` / `memos.js` / `repos.js` / `config.js` / `snippets.js` / `pair-codes.js` / `pipeline-watcher.js` / `specs.js` / `specs/runs.js` / `auth.js` セッション / `pipeline-optimizer.js`）。`grep` の `renameSync` は 14 行だが、うち 3 行は doc コメント | `grep -rn "renameSync" apps/bridge/src --include=*.js` |
| `execFile` | `grep` で **14 行**、実呼び出しは **13 か所**（`coherence.js:429` は doc コメント）。hermes CLI **8**（`kanban.js` / `review.js` / `ops.js` / `capture.js` / `inbox.js` / `architect.js` / `specs.js` / `repos.js`）・git **1**（`gitinfo.js`）・tailscale **1**（`server/helpers.js`）・node checker **3**（`coherence.js`） | `grep -rn "execFile(" apps/bridge/src --include=*.js` |
| 戻り値の形 | **5 種**: `{code,out}` ×4（`kanban` / `review` / `ops` / `inbox`）/ `{code,stdout,stderr}` ×3（`capture` / `specs` / `repos`）/ `{code,stdout,stderr,bin,args}`（`architect`）/ **stdout か null**（`gitinfo`）/ **文字列か null**（`server/helpers.js` の tailscale） | 各 `run*()` の resolve 行 |
| タイムアウト | 全呼び出しが `timeout` 付き。ただし `err.code ?? 1` なので **タイムアウト（`err.killed`）と exit 1 が同じ値**になる | `resolve({ code: err ? (err.code ?? 1) : 0, … })` |
| 失敗の符号化 | `sendOutcome`（`server/helpers.js` の `function sendOutcome`）が `ok === false` → 502 の唯一の正本。生の `sendJson(res, 200, out)` が **1 か所**（`server/api-boards.js:224` = abort 成功路）。`catch → return []` が **19 か所** | `grep -rn -A1 '} catch' apps/bridge/src --include=*.js` の出力を `grep -c 'return []'` で数える |
| 状態表の範囲 | `TRANSITION_TABLE` は 5 遷移（`approve` / `answer.fresh` / `answer.again` / `annotation.fresh` / `annotation.again`）、すべて `from: ['blocked']`。**`inbox.close` / `inbox.unblock` / `review.answer` の `NOT_WAITING` / `review.approve` の `NOT_WAITING` は表の外** | `apps/bridge/src/review/transitions.js` と `apps/bridge/src/inbox.js` の `statusOf` |
| 冪等キー | `dedupeKey` は `floor(Date.now() / 600000)` の**10 分バケット**（`DEDUPE_MS`）。`seen` は in-process `Map`（`capture.js` の `const seen`）。ジョブ ID は時刻 + 乱数 4 で**種の内容を含まない** | `grep -n` で `DEDUPE_MS`・`const seen`・`export function dedupeKey` の 3 語を引く（`capture.js`） |
| 既存ガード | `check-coherence` には `cli-invocation-guard` / `silent-failure-guard` / `transition-owner` が既にある。**穴**: `silentServerProblems` はブロック内のどこかに `x.ok` があれば通す（abort の成功路がこれで見逃される）。`TRANSITION_OWNER_FILES` は `review.js` / `review/media.js` のみ（`inbox.js` が対象外） | `scripts/check-coherence.mjs` の該当関数 |

### 1.2 直す理由（1 層 1 行）

1. **原子性**: `review.js:546-547` は**赤ペン回答そのもの**。`answer.json` だけ新しく `answer.txt` が古いまま落ちると、PWA の表示と共有履歴が食い違い「回答が消えた」ように見える。`auth.js:51` はトークンが半端に書けると `/auth` が 401 のまま戻らない。
2. **CLI 境界**: 形が 5 種あり、呼び出し側は `code` / `ok` / `null` の 3 通りで失敗を見る。`gitinfo` の `null` は「git が無い」「リポジトリでない」「timeout」を**すべて同じ値**にする。
3. **サイレント失敗**: `catch → return []` は「0 件」と同じ値。画面は「空です」と出し、原因はログにも残らない。
4. **状態表**: 「どの状態で何が起きるか」が表・`statusOf`・API ハンドラの 3 か所に分かれ、`review.answer` の 409 と `inbox.unblock` の 409 が別々の規則で決まる。
5. **冪等 ID**: 今日すでに同じ種が 2 回目のジョブになり、同じシートが 2 枚できた。ブリッジ再起動（日常操作）で `seen` が消え、10 分境界をまたぐ再送も通る。

---

## 2. 合意決定表（D101〜D105）

| ID | 決定事項 |
| :--- | :--- |
| **D101** | **状態ファイルの書き込みは `apps/bridge/src/lib/atomic.js` の 3 関数だけ**: `writeJsonAtomic(file, value, opts)` / `writeFileAtomic(file, data, opts)` / `writePairAtomic([[a, …], [b, …]])`。tmp 名は `<file>.tmp-<pid>-<連番>`、`mode` は既定 `0o600`、`renameSync` は同じディレクトリ内。**直書き 10 か所＋写経 11 か所の計 21 か所**をこの 3 関数へ寄せ、`fs.writeFileSync` は `lib/atomic.js` 以外で**禁止**（`check:coherence` の `write-owner`）。 |
| **D102** | **外部 CLI の戻り値は `apps/bridge/src/lib/cli.js` の `run()` 1 つに統一**: `{ ok, code, stdout, stderr, timedOut, bin, args }`。`ok = code === 0 && !timedOut`、`timedOut = Boolean(err?.killed)`、`code` は数値か `null`（タイムアウトは `null`）。hermes CLI 8 か所と git 1 か所を `run()` / `runHermes()` へ移す。**`catch → return []` の 19 か所はこのバッチで型を変えない**（D103 で可視化だけ行う。Q3-A2 の `{ok, data}` 化は採らない）。 |
| **D103** | **失敗は必ず 1 つの符号化を通る**: 書き込み系の応答は `sendOutcome` のみ（`server/api-boards.js:224` の生 `sendJson(res, 200, out)` を置換）。`catch → return []` の 19 か所は `lib/safe.js` の `safeList(label, fn, fallback)` に寄せ、**戻り値の型は変えずに** 1 行の英語 warn（`[<label>] <message>`）を残す。`silent-failure-guard` の「ブロック内に `x.ok` があれば通す」穴を塞ぎ、`swallow-owner` を追加。 |
| **D104** | **状態表は `review/transitions.js` の `TRANSITION_TABLE` が唯一の正本**: D99 の 5 遷移に `close.done` / `close.cancel` / `unblock` を足し、`from` / `noop` / `kind` / `result` で「どの状態で何が起きるか」を全部書く。`review.answer` / `review.approve` の `NOT_WAITING`（409）と `inbox.unblock` の `TASK_STATE_LOCKED`（409）も `canApply()` の判定から出す。戻り値は D99 の `{ code, out, status, moved }` を維持（呼び出し側の分岐を壊さない）。 |
| **D105** | **冪等キーは「内容 + 永続」**: `makeJobId()` は `arch-<base36 時刻>-<種ハッシュ8>-<乱数4>` にし、種が同じなら**同じ中盤セグメント**になる。`capture` の冪等キーから 10 分バケットを外し、`seen` を `dataDir` の `capture-state.json`（`0600`・`writeJsonAtomic`・TTL `DEDUPE_MS`）へ永続化する。`dismissed` は job ID と種ハッシュの**両方**で判定する。 |

**採らなかった案（証跡）**: Q1-B（SEMM の回帰監査だけでは今回の 5 点が記録に残らず、次の同じ種で同じ調査を繰り返す）／Q1-C（重複を閉じると `makeJobId` の構造が残り、3 枚目が来る）／Q2-B（イディオムのコピーは tmp 名・mode・整形が 21 通りに散る）／Q2-C（`auth.js` だけ直すと赤ペン回答の `answer.json` / `answer.txt` が残る）／Q3-A2（`{ok, data}` 化は API・PWA・テストまで波及し 1 バッチを超える）／Q3-B（4 形を残すと同じ指摘が次の監査で出る）／Q3-C（個別ガードは分裂を残す）／Q4-B（再起動で冪等性が消える点が残る）／Q4-C（今日すでに 2 回目が起きている）。

---

## 3. 設計（実装前に読む 1 ページ）

### 3.1 `apps/bridge/src/lib/atomic.js`（D101）

```js
export function writeJsonAtomic(file, value, { mode = 0o600, pretty = 2 } = {}) // → void（失敗は throw）
export function writeFileAtomic(file, data, { mode = 0o600, encoding = 'utf8' } = {})
export function writePairAtomic(pairs) // pairs = [[file, data, opts], …] を順に書く。→ { written: string[], failedAt: number|null }
```

- tmp 名は `<file>.tmp-<pid>-<連番>`。`fs.mkdirSync(path.dirname(file), { recursive: true })` は**呼び出し側の責務にしない**（ヘルパー内で 1 回行う）。
- `renameSync` は同一ディレクトリ内のみ（cross-device の `EXDEV` を避ける）。失敗時は tmp を消してから throw。
- `writePairAtomic` の順序は**正本が先**。`review.answer` の組は `answer.json`（正本・`sha256` を持つ）→ `answer.txt`（派生の共有用コピー）。途中で落ちたら `failedAt` を返し、呼び出し側は英語 warn を 1 行残す。**`answer.txt` を正本として読む実装を新設しない**（現行も HTTP で配信していない・`review.js` の結果 `files.text` 参照のみ）。
- 既存 11 か所の写経を置き換えるとき、`mode` と JSON 整形（`null, 2` / 末尾改行の有無）は**現行の値を保つ**（差分を「書き込み経路の置換」に閉じる）。
- `review/media.js` の PNG 2 か所は `writeFileAtomic`（Buffer をそのまま）、`annotation.json` は `writeJsonAtomic`。スクショ（`review/feeds.js`）も `writeFileAtomic`。
- `auth.js` のトークンは `writeFileAtomic(cfg.tokenPath, token, { mode: 0o600 })`。セッション JSON（既存の tmp + rename）も同じ関数へ寄せる。

### 3.2 `apps/bridge/src/lib/cli.js`（D102）

```js
export function run(bin, args, { timeoutMs = 15_000, maxBuffer = 1_000_000, cwd, env } = {})
// → Promise<{ ok, code, stdout, stderr, timedOut, bin, args }>
export function runHermes(args, opts = {}) // bin = opts.bin ?? resolveHermesBin()、env に buildAugmentedPath()
export function outcomeOf(res)             // 旧形（{code,out} / {code,stdout,stderr} / string|null）を新形へ。**注入シーム専用**
```

- `code`: 成功 `0` / `err.code` が数値ならその値 / タイムアウトや spawn 失敗は `null`。
- `timedOut`: `Boolean(err?.killed)`。`ok`: `code === 0 && !timedOut`。
- `stdout` / `stderr` は常に文字列（`''` を含む）。`out`（stdout+stderr 連結）は**返さない**。連結が要る呼び出し側は `stdout + stderr` を自分で作る（`review.js` / `ops.js` の ID 抽出は `stdout` 優先・`stderr` は本文用）。
- **テストの注入シームは壊さない**: 各モジュールの `cfg.runner` / `deps.runner` は今までどおり素の引数 1 つを受け、戻り値は `outcomeOf()` を通して新形に正規化する。既存テストは `{code,out}` を返し続けてよい（`outcomeOf` が吸収）。
- 移行対象は hermes 8（`kanban.js` / `review.js` / `ops.js` / `capture.js` / `inbox.js` / `architect.js` / `specs.js` / `repos.js`）と git 1（`gitinfo.js`）。**対象外**: `coherence.js` の node checker 3 か所（Layer 2 の自己検査で、失敗は soft signal として扱う設計）と `server/helpers.js` の tailscale 1 か所（best-effort プローブで `null` が仕様）。対象外は §3.2 のコメントに理由を書く。
- `gitinfo.git()` の `null` 潰しを廃止: `{ok:false}` を受けた `subject()` は空文字、`forTask()` は `git: null` を返す（**「git が無い」と「git が失敗した」を `ok` で区別できるようにする**。API の形は変えない）。
- `architect.js` が必要とする `bin` / `args` は新形に常に含まれるので、`{code,stdout,stderr,bin,args}` の専用形は消える。

### 3.3 `apps/bridge/src/lib/safe.js`（D103）

```js
export function safeList(label, fn, fallback = []) // fn が throw したら英語 warn を 1 行出して fallback
```

- 19 か所の `catch → return []` を `return safeList('kanban.safeAll', () => …, [])` の形へ。**戻り値の型は変えない**（PWA の `[]` 前提はそのまま）。
- warn の形は固定: `[<label>] <err.message>`（英語のみ・PII を入れない・最大 200 字）。`label` は `<module>.<function>`（例 `review.feeds.read`）。
- `server/api-boards.js:224` を `sendOutcome(res, out)` に置換。abort の失敗分岐（手組み 502）も `sendOutcome` に寄せ、`code: 'CLI_FAILED'` は `sendOutcome` の `failCode` 引数で表現する。
- `silentServerProblems` の穴: 「ブロック内のどこかに `x.ok` があるか」ではなく、**`sendJson(res, 200, x)` の `x` を返す直前に `x.ok` を参照しているか**（成功路と失敗路を分けて判定）に変える。abort の成功路は `out.ok` を参照していないので、この強化で検出される（同時に置換するので verify は緑）。

### 3.4 状態表（D104）

`TRANSITION_TABLE` を次の 8 遷移へ（`from` が唯一の正本）:

| 遷移 | from | noop（CLI を呼ばない） | kind | result |
| :--- | :--- | :--- | :--- | :--- |
| `approve` | `blocked` | — | `complete-then-unblock` | `Visual check passed` |
| `answer.fresh` | `blocked` | — | `unblock` | — |
| `answer.again` | `blocked` | — | `unblock` | — |
| `annotation.fresh` | `blocked` | — | `unblock` | — |
| `annotation.again` | `blocked` | — | `unblock` | — |
| `close.done` | `ready` `running` `blocked` `todo` `review` | `done`（`noop: true`） | `complete` | 呼び出し側の文面 |
| `close.cancel` | 任意（`archived` 以外） | `archived`（`noop: true`） | `comment-then-archive` | 取消コメント |
| `unblock` | `blocked` | `ready` / `running`（`noop: true`） | `unblock` | — |

- `unblock` の `from` が `blocked` 以外なら、`inbox.unblock` は `TASK_STATE_LOCKED`（409）を返す（現行の `ApiError` を表の判定から組み立てる）。
- `review.answer` / `review.approve` の `NOT_WAITING`（409）は `transitions.canApply('answer.fresh' | 'answer.again', status)` / `canApply('approve', status)` で決める（`review.js` の個別 `if` を表へ寄せる）。
- `close.cancel` は「先に comment、失敗しても archive を続ける」という現行の 2 段を `kind: 'comment-then-archive'` として表に書く（`apply()` の中の分岐を 1 か所増やす）。
- **戻り値の互換**: 既存の `{ code, out, status, moved, skipped? }` を保つ。`noop` は `{ code: 0, out: '', status, moved: null, skipped: 'noop' }` として返す（`inbox.close` の `noop: true` フラグは API 応答側で付け直す）。
- `check:coherence` の `TRANSITION_OWNER_FILES` に `apps/bridge/src/inbox.js` を追加し、`runKanban(['complete'` / `['unblock'` の直書きを検出する。

### 3.5 冪等 ID（D105）

```js
export function makeJobId(ms, rand, seedHash) // arch-<base36 ms>-<hash8>-<rand4>
```

- `hash8 = sha1(normalizeSeed(seedText)).slice(0, 8)`（`normalizeSeed` 済みの文字列を使う。空白差で別ハッシュにならない）。
- `suggestSpecSlug` は job ID の**末尾セグメント**（乱数 4）を最後のフォールバックに使うので、中盤に挿入しても壊れない（`arch-mf3k-0a1b` → `arch-mf3k-<hash8>-0a1b` でも `pop()` は `0a1b`）。
- テスト `apps/bridge/test/architect.test.js` の `assert.match(id, /^arch-[0-9a-z]+-[0-9a-z]{4}$/)` を新形へ更新。
- `createCapture` の `seen` は起動時に `capture-state.json` を読み、`create()` 成功時に `writeJsonAtomic` で書く。キーは `sha1(board|title|body|priority|assignee)`（**バケットを外す**）。TTL は `DEDUPE_MS` を初回起票時刻から数え、ヒットでは延長しない（同じ内容が 10 分後に再投入されたら新しいタスクを作る＝現行の仕様を保つ）。
- `capture-state.json` は `dataDir` 直下・`0600`・最大 500 エントリ（古い順に落とす）。`dataDir` 未設定（テスト）ではメモリのみ。
- `dismissed` は `{ ids: string[], seeds: string[] }` を保存し、`isDismissed(job)` は `job.id ∈ ids || job.seedHash ∈ seeds`。`DISMISSED_MAX` は両方に適用。
- ジョブ ID を読む経路（`architect/task.js` のタイトル、`architect/seed.js` のプロンプト行、`pipeline-watcher` のジョブ照合）は ID を**正規表現でなく文字列一致**で扱っているため、形の変更で壊れないことをテストで固定する（architect ジョブのテストに 1 ケース追加）。

---

## 4. バッチ

すべて `[Mode: Zero-Stop]`。1 バッチ 1 盲点。起票順は `COA2-1` → `COA2-2` → `COA2-5` → `COA2-3` → `COA2-4` を推奨（`COA2-5` は `COA2-1` の `writeJsonAtomic` と `COA2-2` の `run()` に依存する。`COA2-3` / `COA2-4` は独立だが、`COA2-4` は `COA2-2` の後に置くと `runKanban` の戻り値が安定している）。

### Batch COA2-1: WIRE-ATOMIC — 書き込みを `lib/atomic.js` の 3 関数へ（D101）

- **Execution Mode**: `[Mode: Zero-Stop]`
- **推奨ロール**: `role:builder`
- **目的**: 状態ファイルの書き込みを 1 実装へ寄せ、途中終了で壊れないようにする（直書き 10 か所＋写経 11 か所 = 21 か所）。
- **変更**: 新規 `apps/bridge/src/lib/atomic.js` / `apps/bridge/test/atomic.test.js`。`review.js`（4 か所）/ `review/media.js`（2）/ `review/feeds.js`（1）/ `architect.js`（2）/ `auth.js`（2: トークン + セッション）/ 既存 11 か所の写経を置換。`coherence.test.js` の分割（§6.1）。
- **受け入れ**: 21 か所すべてが `writeJsonAtomic` / `writeFileAtomic` / `writePairAtomic` を通る。`lib/atomic.js` 以外に `fs.writeFileSync` が 0（`write-owner` が緑）。偽 fs（`renameSync` で throw）で「`answer.json` が新・`answer.txt` が旧のとき `failedAt` が返り、`answer.json` は壊れない」をテスト。
- **検証**: `npm run verify` / `node --test apps/bridge/test/atomic.test.js apps/bridge/test/review.test.js apps/bridge/test/auth.test.js`。
- **非対象**: 状態ファイルの**形式**変更（`version` 付与など）。`fsync` の追加。JSONL の append 経路（1 行完結なので対象外）。

### Batch COA2-2: CLI-BOUNDARY — 外部 CLI の戻り値を `lib/cli.js` の `run()` に統一（D102）

- **Execution Mode**: `[Mode: Zero-Stop]`
- **推奨ロール**: `role:builder`
- **目的**: 戻り値 5 形とタイムアウトの握り潰しを無くし、呼び出し側が `ok` だけを見れば済むようにする。
- **変更**: 新規 `apps/bridge/src/lib/cli.js` / `apps/bridge/test/cli.test.js`。hermes 8 + git 1 の `run*()` を `run()` / `runHermes()` に置換。`gitinfo` は `ok` を見る形へ。`architect` の `bin` / `args` は新形から取る。
- **受け入れ**: `apps/bridge/src` の `execFile(` が `lib/cli.js`・`coherence.js`（対象外・コメントで理由）・`server/helpers.js`（tailscale・対象外）だけになる（`cli-owner`）。タイムアウト時に `timedOut: true` かつ `code: null` になるテスト。既存テストの `runner` 注入（`{code,out}` を返す）が `outcomeOf` 経由で通る。
- **検証**: `npm run verify` / `node --test apps/bridge/test/*.test.js`。
- **非対象**: `catch → return []` の 19 か所（COA2-3）。`sendOutcome`（COA2-3）。`coherence.js` / tailscale。

### Batch COA2-5: IDEM-OWNER — ジョブ ID に種ハッシュ、起票の冪等キーを永続化（D105）

- **Execution Mode**: `[Mode: Zero-Stop]`
- **推奨ロール**: `role:builder`
- **目的**: 同じ種が独立ジョブとして何度も入る構造を止め、再起動や 10 分境界で冪等性が消えないようにする。
- **変更**: `architect/seed.js` の `makeJobId` / `buildSeedPrompt`、`architect.js` の `makeJobId(startedAt)` 呼び出しと `saveDismissed` / `isDismissed`、`capture.js` の `dedupeKey` / `seen`（`capture-state.json`）、関連テスト（`architect.test.js` / `architectJobView.test.js` / `capture.test.js`）。
- **受け入れ**: 同じ種で 2 回 `makeJobId` を呼ぶと中盤セグメントが一致する。`dedupeKey` の出力に時刻が入らない（同じ入力で 1 時間後も同じ値）。`createCapture` を作り直しても同じ入力の 2 回目は CLI を呼ばない（`capture-state.json` 経由）。`capture-state.json` が `0600` で、壊れた JSON を読んだら空で立ち上がる（throw しない）。
- **検証**: `npm run verify` / `node --test apps/bridge/test/capture.test.js apps/bridge/test/architect.test.js apps/bridge/test/architectJobView.test.js`。
- **非対象**: 既存ジョブ ID の移行（過去 ID はそのまま読める）。`[ARCH]` の自動再投入（採用しない）。

### Batch COA2-3: SWALLOW-GUARD — 失敗を「0 件」と区別できるようにする（D103）

- **Execution Mode**: `[Mode: Zero-Stop]`
- **推奨ロール**: `role:builder`
- **目的**: `catch → return []` 19 か所と生の `sendJson(res, 200, …)` 1 か所を、ログと 1 本の符号化で可視化する（戻り値の型は変えない）。
- **変更**: 新規 `apps/bridge/src/lib/safe.js` / `apps/bridge/test/safe.test.js`。19 か所の `catch → return []` を `safeList` へ。`server/api-boards.js:224` と abort の手組み 502 を `sendOutcome` へ。`scripts/check-coherence.mjs` の `silentServerProblems` 強化と `swallow-owner` 追加。
- **受け入れ**: `catch` 直後の `return []` が 0（`swallow-owner`）。`sendJson(res, 200, …)` の payload が `ok === false` になり得る書き込み路で、`ok` 未参照が 0（強化した `silent-failure-guard`）。warn は英語 1 行で、`label` が `<module>.<function>` 形式。
- **検証**: `npm run verify` / `node --test apps/bridge/test/coherence.test.js`。
- **非対象**: 19 か所の戻り値型の変更（Q3-A2 は不採用）。ログの集約（`tail.js` のリングバッファ仕様は変えない）。

### Batch COA2-4: STATE-TABLE — 遷移表を close / unblock まで広げる（D104）

- **Execution Mode**: `[Mode: Zero-Stop]`
- **推奨ロール**: `role:builder`
- **目的**: 「どの状態で何が起きるか」を 1 つの表で言えるようにし、409 の判定を表から出す。
- **変更**: `apps/bridge/src/review/transitions.js`（表 8 遷移・`noop`・`comment-then-archive`）、`apps/bridge/src/inbox.js`（`close` / `unblock` を `apply()` 経由へ）、`apps/bridge/src/review.js`（`NOT_WAITING` を `canApply` から）、`scripts/check-coherence.mjs`（`TRANSITION_OWNER_FILES` に `inbox.js`）、`apps/bridge/test/transitions.test.js`（新規 or `review.test.js` 内）。
- **受け入れ**: `inbox.js` に `runKanban(['complete'` / `['unblock'` の直書きが 0。`unblock` の `from` 外は 409 `TASK_STATE_LOCKED`、`answer` / `approve` の `from` 外は 409 `NOT_WAITING` が、どちらも表の判定で返る。`close done` の done→done、`close cancel` の archived→archived が `noop` で CLI 0 回。既存の `review.test.js` / `inbox.test.js` が無修正で通る（戻り値互換）。
- **検証**: `npm run verify` / `node --test apps/bridge/test/inbox.test.js apps/bridge/test/review.test.js`。
- **非対象**: 新しい状態の追加（`triage` など）。PWA 側の文言（`ops.*` は現行キーのまま）。

---

## 5. `check:coherence` に足すルール

| ルール | 検査 | 対象 |
| :--- | :--- | :--- |
| `write-owner`（新規） | `fs.writeFileSync` が `apps/bridge/src/lib/atomic.js` 以外に無い | `apps/bridge/src/**` |
| `cli-owner`（新規） | `execFile(` が `apps/bridge/src/lib/cli.js` 以外に無い（`coherence.js` / `server/helpers.js` は許可リストで除外・理由コメント必須） | `apps/bridge/src/**` |
| `swallow-owner`（新規） | `} catch` の直後が `return []` でない（`safeList` を通す） | `apps/bridge/src/**` |
| `silent-failure-guard`（強化） | `sendJson(res, 200, x)` の `x` が `ok` を持つ型なら、**その送信路で** `x.ok` を参照している | `server/*.js` |
| `transition-owner`（拡張） | `inbox.js` の `runKanban(['complete'` / `['unblock'` も検出 | `review.js` / `review/media.js` / `inbox.js` |

新ルールは `.hermes-coherence.json` の `checkerPending` で**バッチ実装中だけ soft** に落とし、そのバッチの完了時にエントリを消す（既存の仕組み）。`--strict` で hard fail になることを `coherence.test.js` で固定する。

---

## 6. 落とし穴

### 6.1 `coherence.test.js` の 902 行を先に割る

`.hermes-coherence.json` の `maxLines: 800` を超えているため、テストを追記するとラチェットが悪化する。`COA2-1` の最初のコミットで**移動だけ**の分割を行う（例: `coherence.rules.test.js` = ルール関数の単体、`coherence.ratchet.test.js` = baseline / soft signal、`coherence.test.js` = 統合）。`scripts/coherence-baseline.json` の行数も同時に更新する（`npm run check:coherence` の出力に従う）。

### 6.2 やらないこと

- `answer.txt` を正本にする / HTTP で配信する（派生コピーのまま）。
- `catch → return []` の戻り値型を `{ok, data}` に変える（Q3-A2 は不採用。PWA の `[]` 前提が広い）。
- 過去ジョブ ID の書き換え・`[ARCH]` の自動再投入。
- `fsync` の追加、状態ファイルへの `version` 付与（別 SPEC の領分）。
- 色・レイアウト・文言の変更（本 SPEC は UI を触らない。`themeTokens.test.js` と `en.json` / `ja.json` は無関係のはず）。

### 6.3 実装時に必ずシンボルで探す

`sendOutcome`（`server/helpers.js`）/ `TRANSITION_TABLE`（`review/transitions.js`）/ `dedupeKey`・`createCapture`（`capture.js`）/ `makeJobId`・`saveDismissed`・`isDismissed`（`architect/seed.js` / `architect.js`）/ `silentServerProblems`（`scripts/check-coherence.mjs`）。行番号はこの文書の時点のもので、実装時には動いている。

### 6.4 検証の読み方

`npm run verify` の `check:coherence` は soft signal を出すことがある（`checkerPending`）。**exit 0 でも soft signal が残っていたら、そのバッチの対象ルールか確認する**。対象ルールなら `checkerPending` を消して緑にする。対象外なら既知として `docs/PITFALLS.md` に 1 行足す（黙って残さない）。
