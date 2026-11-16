# SPEC: Hermes Pilot V11 — `agy Opt-in` 完全削除・ファイル経由疎結合 A2B ＆ Hermes Native 仕様策定強化仕様書 (`SPEC-PILOT-V11`)

- **状態**: 仕様確定（2026-11-16 Google 利用規約 §6 リスク評価 ＆ Hermes Native パイプライン維持・強化方針合意済み）
- **前提仕様**: [SPEC-PILOT-V10.md](./SPEC-PILOT-V10.md)（commit `8c7d8d8` まで完了済み）
- **対象リポジトリ**: `hermes-mobile-pwa`（プラグイン名: `hermes-pilot` / `Hermes Pilot`）
- **全バッチ共通の完了条件**:
  - `npm run verify`（`npm test` + `check:pwa` + `check:oauth` + `build` + `audit:responsive`）が 0 fail であること
  - `npm run build:demo` が 0 exit で自己完結 HTML（`apps/web/dist-demo/google-sites-embed.html`）を生成し、`demo/index.html` と同期していること
  - 実行コード（`apps/bridge/src`, `apps/dashboard`, `apps/web/src`, `bin`）および公開ドキュメント（`README.md`, `README.ja.md`, `docs/OPERATIONS.md`, `demo/README.md`）に `agy` CLI サブプロセス起動・`hasAgyCli`・`antigravity` ランナー切替が残っていないこと

---

## 1. コンセプトとアーキテクチャ方針

2026年11月時点の公式見解（サードパーティ製ソフトウェア／エージェントが `agy -p` 等を子プロセスとしてラップ起動し消費者サブスクリプション枠を消費させる行為は §6 違反・BAN 対象）を受け、`Hermes Pilot` から **`agy Opt-in`（`spawn('agy')` / `execFile('agy')` による CLI 子プロセス起動と関連 UI/API/検出コード）を完全に削除** する。

そのうえで、`Hermes Pilot` の A2B（Architect-to-Builder）パイプラインは以下の **2 つの安全な正規ルート** を維持・強化する：

1. **基本ルート（ファイル配置 → ワンタップ自律実装）**:
   - ユーザーが自身のターミナルや公式 Antigravity Remote PWA、任意のエディタを直接操作して `docs/SPEC-*.md`（および必要に応じて `review/sheets/*.json`）をリポジトリへ配置する。
   - `Hermes Pilot` はファイル監視（`Spec Launchpad` / `reviewWatcher`）だけで受け取り、**外部 AI CLI プロセスを一切起動することなく** 1 タップでカンバン起票・自律実装を開始する。
   - `apps/bridge/src/pipeline-optimizer.js` の `SKILL.md` ファイル配置もプロセス起動を伴わない純粋なファイル配置であるため、ファイル経由の疎結合連携用として維持する。
2. **Hermes Native 仕様策定ルート（`Spec Seed` 維持・強化）**:
   - `Hermes Native`（`hermes kanban create` による `[ARCH]` タスク起票）は Hermes Agent 本体の正規機能であり、規約上の問題が一切ないため、スマホからの `Spec Seed → Round 1 Quick Review → Round 2 docs/SPEC-*.md → Launchpad` パイプラインをそのまま維持する。
   - さらに、`Hermes Native` による仕様策定の**速度・確実性・復旧性**を高めるため、既存 `SPEC` 一覧と推奨スラッグの事前注入、Round 1 の高速化制約（不要なテスト実行・全量探索の抑止）、失敗／停滞時の 1 タップ再試行を強化する。
3. **機械的ガードレール（`scripts/check-oauth-boundary.mjs`）の強化**:
   - 既存の OAuth クレデンシャルファイル非接触検査に加え、`agy` CLI の検出・子プロセス起動コードが将来再混入しないよう禁止パターンへ追加する。

---

## 2. 合意決定表（D50〜D54）

| ID | 論点 | 採択方針 | 対象 |
| :--- | :--- | :--- | :--- |
| **D50** | Bridge 側の `agy` 検出・子プロセス起動の完全削除 | `architect.js` の `RUNNERS` を `['hermes']` のみにし、`antigravity` / `agy -p --mode auto` 起動・`hasAgyCli`・`RUNNER_UNAVAILABLE` を廃止する。`capabilities.js` から `agyCliDirs` / `resolveAgyBin` / `hasAgyCli` を削除する。 | `apps/bridge/src/architect.js`, `capabilities.js`, `api-errors.js`, `server.js` |
| **D51** | Dashboard / Web PWA / Demo からの `Antigravity (agy)` ランナー UI・API 削除 | `apps/dashboard`（Python/JS）および `apps/web`（`PipelinePanel.jsx`, `SpecSeedSheet.jsx`, `specSeed.js`, `i18n`, `mockApi.js`）から `hasAgyCli`・`agyAvailable`・`Antigravity (agy)` 選択ボタン・デモ用 `antigravity` 分岐を削除し、`Hermes Native`＋ファイル経由疎結合の案内へ統一する。 | `apps/dashboard/*`, `apps/web/src/*`, `demo/index.html` |
| **D52** | 境界ガードレールの強化 | `scripts/check-oauth-boundary.mjs` で OAuth クレデンシャル非接触に加え、`agy` CLI パス解決や `agy` ランナー呼び出しの再混入も機械検査でブロックする。 | `scripts/check-oauth-boundary.mjs` |
| **D53** | 公開ドキュメントの全面同期 | `README.md`・`README.ja.md`・`docs/OPERATIONS.md`・`demo/README.md` から `agy Opt-in` 記述をすべて削除し、「`docs/SPEC-*.md` 配置による 1 タップ自律実装（基本）」と「`Hermes Native` によるスマホ仕様策定パイプライン」の 2 軸を明記する。 | `README.md`, `README.ja.md`, `docs/OPERATIONS.md`, `demo/README.md` |
| **D54** | `Hermes Native` 仕様策定の強化 | `buildArchitectTaskBody` に既存 `docs/SPEC-*.md` 一覧（直近最大 6 件）と推奨 `slug` を注入して探索ターンとファイル名衝突を削減し、Round 1 でのテスト実行・不要撮影の抑止を明記する。UI では `failed` / `stalled` な `Hermes Native` ジョブに対し 1 タップ再試行（`shouldOfferHermesRetry`）を維持・整備する。 | `apps/bridge/src/architect.js`, `skills/spec-architect/SKILL.md`, `apps/web/src/lib/specSeed.js`, `ArchitectJobBar.jsx` |

---

## 3. 詳細技術仕様

### 3.1 Bridge（`apps/bridge/src/`）& `Hermes Native` 強化（D50 / D54）

1. **`apps/bridge/src/capabilities.js`**:
   - `agyCliDirs`, `resolveAgyBin`, `hasAgyCli` を削除する。
   - `buildAugmentedPath` から `agyCliDirs(home)` を除去し、`hermesCliDirs(home)` とシステム標準パスのみとする。
   - `getCapabilities()` の返却オブジェクトから `hasAgyCli` フィールドを削除する（`@returns` JSDoc も更新）。
2. **`apps/bridge/src/architect.js`**:
   - `RUNNERS = ['hermes']`、`RUNNER_LABELS = { hermes: 'Hermes Native' }` に固定する。
   - `sanitizeRunner()` は常に `'hermes'` を返す。
   - `createCliRunner()` から `antigravity` / `agy -p --mode auto` 起動ロジックを削除し、`hermes` カンバン起票（`hermes kanban create`）専用とする。
   - `setConfig({ runner })` は `'hermes'` 以外の値が来た場合 `{ ok: false, code: 'INVALID_RUNNER', error: 'Only hermes runner is supported' }`（HTTP 400）を返す。
   - `seed({ runner })` も `'hermes'` 以外が明示された場合は `INVALID_RUNNER`（HTTP 400）で弾き、`mode: 'kanban'` のみで実行する。
   - `jobsFor()` の `capabilities` から `hasAgyCli` を削除する。
   - **`Hermes Native` 強化（D54）**:
     - 純関数 `suggestSpecSlug(seedText, jobId)`（英数字ハイフン小文字、最大 28 文字。先頭行 ASCII から抽出し、無ければ `jobId` 末尾を使う）を追加する。
     - `seed()` 時に `listSpecsFn(repoPath)` 等から既存 `docs/SPEC-*.md` の相対パス一覧（最大 6 件）を取得し、`buildArchitectTaskBody({ ..., suggestedSlug, existingSpecs })` へ渡す。
     - `buildArchitectTaskBody` に以下を明記する:
       - `Suggested slug: <suggestedSlug>`（`review/sheets/spec-<slug>-1.json` と `docs/SPEC-<SLUG>.md` の重複回避用目安）
       - `Existing specs: ...`（既存 SPEC とファイル名が被らないようにする）
       - `Round 1 speed: locate only the relevant symbols (rg/grep), skip running npm test / npm run verify / browser_exec during Round 1, write the JSON sheet and block immediately.`
     - 旧コメント・契約行 `Stay inside the official local CLI: never read or reuse Antigravity OAuth credentials or profiles.` は不要になるため削除または「外部 CLI は起動せず Hermes Native のみで完結する」表現へ更新する。
3. **`apps/bridge/src/api-errors.js` & `apps/bridge/src/server.js`**:
   - `api-errors.js` の `RUNNER_UNAVAILABLE`（`The agy CLI was not found on this machine`）を `INVALID_RUNNER: 'Only the Hermes Native runner is supported'` へ整理する。
   - `server.js` のコメント（`OPT-IN の agy CLI` 等）と `/api/architect/*` 周りの `agy` 記述を整理する。
4. **`apps/bridge/src/pipeline-optimizer.js` & `skills/spec-architect/SKILL.md`**:
   - `pipeline-optimizer.js` の `optimizeAntigravitySkills`（`SKILL.md` ファイル配置のみ、プロセス起動ゼロ）はファイル経由の疎結合連携のために維持し、先頭コメントでプロセス非起動を明記する。
   - `skills/spec-architect/SKILL.md` の Round 1 手順へ「Round 1 では `npm test` / `npm run verify` を走らせない（探索は `rg` 等で最小限にし、即座に `.json` シート起票＋`kanban block` へ進む）」を明記する。

### 3.2 Dashboard プラグイン（`apps/dashboard/`）

1. **`apps/dashboard/pilot_dashboard.py`**:
   - `get_capabilities` から `has_agy = bool(which("agy"))` と `"hasAgyCli"` を削除する。
   - `architect_config` / `set_runner` から `hasAgyCli` と `"antigravity"` 許可分岐を削除し、`"hermes"` のみ許可する。
2. **`apps/dashboard/plugin_api.py` & `apps/dashboard/index.js`**:
   - `plugin_api.py`: `setRunner` の docstring 等から `antigravity` を削除する。
   - `index.js`: `pipelineAgy`, `pipelineAgyOk`, `pipelineAgyMissing`, `hasAgy` および `Antigravity (agy)` 切替ボタンを削除し、`Hermes Native` 固定表示とする。

### 3.3 Web PWA & Interactive Demo（`apps/web/src/`）

1. **`apps/web/src/features/PipelinePanel.jsx`**:
   - `agyAvailable` state・`Antigravity (agy)` ボタン・`chooseRunner` 呼び出しを削除し、`runner` は `Hermes Native` 固定表示（`settings.pipelineRunner` + `Hermes Native` バッジ＋ファイル経由疎結合の説明文 `settings.pipelineLead`）にする。
2. **`apps/web/src/features/SpecSeedSheet.jsx` & `apps/web/src/lib/specSeed.js` & `ArchitectJobBar.jsx`**:
   - `SpecSeedSheet.jsx` から `agyAvailable`, `runner` 切替・`/api/architect/config` の `hasAgyCli` 読み取りを削除し、`runner: 'hermes'` 固定で `buildSeedPayload` を呼ぶ。
   - `specSeed.js`:
     - `buildSeedPayload` は `runner: 'hermes'` 固定にする。
     - `jobRunnerKey` は `'seed.runnerHermes'` のみを返す。
     - `shouldOfferHermesRetry(job)` は `status === 'failed'` または `Boolean(job?.stalled)` のとき `true` を返し、`Hermes Native` ジョブが失敗・停滞した際にも 1 タップ再試行できるようにする（D54）。
   - `ArchitectJobBar.jsx`: コメントと文言を `Hermes Native` の再試行（`seed.retryHermes` 等）として整理する。
3. **`apps/web/src/i18n/en.json` & `apps/web/src/i18n/ja.json`**:
   - `seed.runnerAgy`, `settings.pipelineAgyOk`, `settings.pipelineAgyMissing` 等 `agy` 専用キーを削除し、`settings.pipelineLead` 等の文言を「`Hermes Native` による仕様策定 ＋ 外部ツールで作成した `docs/SPEC-*.md` のファイル経由ワンタップ実装」という趣旨に更新する。
4. **`apps/web/src/demo/mockApi.js` & `demo/index.html`**:
   - `DEMO_HAS_AGY` 定数、`demoRunnerLabel` の `antigravity` 分岐、`startDemoArchitectJob` の `antigravity` 分岐、`demoArchitectJobs` の `capabilities: { hasAgyCli }`、初期ジョブ `j_demo_0` の `runner: 'antigravity'` を削除し、`j_demo_0` は `runner: 'hermes'`, `runnerLabel: 'Hermes Native'`（`state.tasks` に紐づく `taskId` あり）に統一する。
   - `npm run build:demo` を再実行し、`apps/web/dist-demo/google-sites-embed.html` を `demo/index.html` へ反映する。

### 3.4 境界検査とドキュメント（`scripts/`, `README*.md`, `docs/OPERATIONS.md`）

1. **`scripts/check-oauth-boundary.mjs`**:
   - 従来の OAuth クレデンシャル検査に加え、ランタイムコード（`apps/bridge/src`, `apps/dashboard`, `apps/web/src`, `bin`）内に `agyCliDirs` / `resolveAgyBin` / `hasAgyCli` や `agy` CLI サブプロセス起動が再混入した場合に fail する検査ルールを追加する。
2. **`README.md` / `README.ja.md` / `docs/OPERATIONS.md` / `demo/README.md`**:
   - `Antigravity (agy)` Opt-in・`hasAgyCli`・`PUT /api/architect/config` の `antigravity` 切替に関する記述をすべて削除する。
   - **2 つの安全な A2B ワークフロー** を明記する:
     1. **SPEC 配置 → ワンタップ自律実装（基本）**: 自分のターミナルや公式 Antigravity Remote PWA 等で `docs/SPEC-*.md` を配置し、`Spec Launchpad` から 1 タップで自律実装。
     2. **Hermes Native 仕様策定（スマホ完結）**: `Spec Seed` から `Hermes Native` で Quick Review → `docs/SPEC-*.md` 生成 → Launchpad / 自動起票。

---

## 4. 実装バッチ分割（Hermes Agent 自走用）

### Batch V11-B1: BRIDGE-REMOVE-AGY-AND-ENHANCE-NATIVE — Bridge の `agy` 完全削除と `Hermes Native` 仕様策定強化

- **Execution Mode**: `[Mode: Zero-Stop]`
- **目的**: `apps/bridge` から `agy` CLI の検出・パス解決・サブプロセス起動・API エラー定義を完全に削除し、`Hermes Native` の仕様策定プロンプト（推奨スラッグ・既存 SPEC 一覧・Round 1 高速化制約）を強化する。
- **変更ファイル**:
  - `apps/bridge/src/capabilities.js`
  - `apps/bridge/src/architect.js`（`RUNNERS = ['hermes']`、`suggestSpecSlug`、既存 `SPEC` 一覧注入、Round 1 高速化指示）
  - `apps/bridge/src/api-errors.js`
  - `apps/bridge/src/server.js`
  - `apps/bridge/src/pipeline-optimizer.js`（プロセス非起動コメント明確化）
  - `skills/spec-architect/SKILL.md`（Round 1 での不要テスト抑止の明記）
  - `apps/bridge/test/architect.test.js`, `apps/bridge/test/capabilities.test.js`, `apps/bridge/test/live.test.js`
- **受入条件（Verify）**:
  - `node --test apps/bridge/test/*.test.js` が **0 fail**
  - `git grep -n -i -E "\bagy\b|hasAgy|antigravity" apps/bridge/src/architect.js apps/bridge/src/capabilities.js apps/bridge/src/api-errors.js apps/bridge/src/server.js` が **0 件**であること

### Batch V11-B2: DASHBOARD-REMOVE-AGY — Dashboard プラグインの `agy` 関連 UI・API 削除

- **Execution Mode**: `[Mode: Zero-Stop]`
- **目的**: `apps/dashboard` の Python バックエンドとフロント JS から `has_agy` / `hasAgyCli` / `Antigravity (agy)` ランナー切替を削除する。
- **変更ファイル**:
  - `apps/dashboard/pilot_dashboard.py`
  - `apps/dashboard/plugin_api.py`
  - `apps/dashboard/index.js`
  - `apps/bridge/test/dashboard-plugin.test.js`
- **受入条件（Verify）**:
  - `node --test apps/bridge/test/dashboard-plugin.test.js` が **0 fail**
  - `git grep -n -i -E "\bagy\b|hasAgy" apps/dashboard/` が **0 件**であること

### Batch V11-B3: WEB-AND-DEMO-REMOVE-AGY — Web PWA・i18n・Demo モックからの `agy` 削除と再試行整備

- **Execution Mode**: `[Mode: Zero-Stop]`
- **目的**: Web PWA と Interactive Demo モックから `Antigravity (agy)` ランナー選択・i18n キー・デモ分岐を削除し、`Hermes Native` の失敗／停滞時 1 タップ再試行を整備する。
- **変更ファイル**:
  - `apps/web/src/features/PipelinePanel.jsx`
  - `apps/web/src/features/SpecSeedSheet.jsx`
  - `apps/web/src/components/ArchitectJobBar.jsx`
  - `apps/web/src/lib/specSeed.js`
  - `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ja.json`
  - `apps/web/src/demo/mockApi.js`
  - `apps/web/test/demoMode.test.js`, `apps/web/test/specSeed.test.js`
- **受入条件（Verify）**:
  - `node --test apps/web/test/*.test.js` が **0 fail**（`i18n.test.js` / `i18nLeak.test.js` / `noHardcodedJapanese.test.js` 含む）
  - `git grep -n -i -E "\bagy\b|hasAgy|antigravity" apps/web/src/` が **0 件**であること

### Batch V11-B4: GUARDRAIL-AND-DEMO-BUNDLE — 境界検査強化と `demo/index.html` 再ビルド同期

- **Execution Mode**: `[Mode: Zero-Stop]`
- **目的**: `scripts/check-oauth-boundary.mjs` で `agy` 関連コードの再混入を禁止し、`npm run build:demo` の生成物を `demo/index.html` へ反映する。
- **変更ファイル**:
  - `scripts/check-oauth-boundary.mjs`
  - `demo/index.html`（`npm run build:demo` で生成された `apps/web/dist-demo/google-sites-embed.html` と同期）
- **受入条件（Verify）**:
  - `npm run check:oauth` が exit 0 でパスすること
  - `npm run build:demo` が exit 0 で完了し、`demo/index.html` と `apps/web/dist-demo/google-sites-embed.html` の内容が一致すること

### Batch V11-B5: DOCS-REMOVE-AGY-SYNC — 公開ドキュメント全面更新と最終検証

- **Execution Mode**: `[Mode: Zero-Stop]`
- **目的**: `README.md`・`README.ja.md`・`docs/OPERATIONS.md`・`demo/README.md` から `agy Opt-in` を完全削除し、「`docs/SPEC-*.md` 配置による 1 タップ自律実装」と「`Hermes Native` 仕様策定パイプライン」の 2 軸を明記して最終検証を通す。
- **変更ファイル**:
  - `README.md`
  - `README.ja.md`
  - `docs/OPERATIONS.md`
  - `demo/README.md`（該当記述があれば更新）
- **受入条件（Verify）**:
  - `npm run verify`（`test` + `check:pwa` + `check:oauth` + `build` + `audit:responsive`）が **0 fail**
  - `git grep -n -i -E "\bagy\b|hasAgy" README.md README.ja.md docs/OPERATIONS.md demo/README.md apps/bridge/src apps/dashboard apps/web/src` が **0 件**であること

---

## 5. 起票（この SPEC 作成時点では起票しない）

運用ルールに従い、仕様書確定フェーズでは自動起票しない。内容確認後、ユーザーが Spec Launchpad の **「File batches & start」** から `V11-B1`〜`V11-B5` を起票して自走を開始する。
