# SPEC: 抽象ロール定義・Delegation/Fallback ルーティング最適化仕様書 (`SPEC-ROLE-DELEGATION-ROUTING`)

- **状態**: 仕様確定（2026-11-19・`mobile` プロファイル運用方針・規約遵守境界合意済み）
- **前提仕様**: [SPEC-PILOT-V11.md](./SPEC-PILOT-V11.md)
- **対象リポジトリ**: `hermes-mobile-pwa`（プラグイン名: `hermes-pilot` / `Hermes Pilot`）および実機 Hermes Agent 環境（`~/.hermes/`, `~/.hermes/profiles/mobile/`）
- **全バッチ共通の完了条件**:
  - `npm run verify`（`npm test` + `check:pwa` + `check:oauth` + `build` + `audit:responsive`）が 0 fail であること
  - 同梱スキル（`skills/*/SKILL.md`）に特定ユーザー固有のモデル名・課金プラン・個人環境依存のパスや秘密情報がハードコードされていないこと
  - ランタイムコード・スキル・`SOUL.md`・プロファイルメモリに規約違反の外部 AI CLI ラップ起動（`gemini` CLI / `gemini -p` / `agy -p` 等）が存在しないこと

---

## 1. コンセプトと設計原則

Hermes Pilot の A2B（Architect-to-Builder）パイプラインを、公開プラグインとしての汎用性を保ちつつ、ユーザーの `mobile` プロファイル運用に合わせて最高精度・高コスト効率で自走させるため、**「プラグイン層の抽象ロール定義」と「実機プロファイル層のモデル割当」を 2 層に分離** する。

1. **リポジトリ／同梱スキル層（モデル非依存）**:
   - `skills/spec-architect/SKILL.md`、`skills/annotation/SKILL.md`、`skills/quick-review/SKILL.md` および `apps/bridge/src/specs.js` / `pipeline-optimizer.js` には、特定モデル名称ではなく **抽象ロール（Abstract Roles）** と **ネイティブ Delegation / Graceful Fallback 規約** のみを定義する。
2. **Hermes Agent プロファイル層（ローカル実機環境）**:
   - `~/.hermes/profiles/mobile/` のプロファイルメモリおよび `SOUL.md` に、「どの抽象ロールをどの実モデルへ割り当て、失敗時にどこへフォールバックするか」のマッピングを構造化して整理・配置する。
3. **モデル運用方針（`mobile` プロファイル）**:
   - **主モデル（通常会話・定型実装・テスト修復・カンバン操作）**: **DeepSeek V4.1 Flash** を引き続きメインで使用する。
   - **A2B パイプライン内の高度推論・視覚検収**: 複雑な設計・SPEC 策定・多モジュール原因究明およびスクショ差分・赤入れ視覚検収では、**Gemini Neon** および **Gemini Hydrogen** を Hermes ネイティブの `delegate_task` で積極的に使用する。
   - **フォールバック保証**: 委譲先モデルが一時エラー・レート制限・タイムアウト・未設定の場合は、作業を停止・ブロックせず、フォールバック順（次点 Gemini → 主モデル DeepSeek V4.1 Flash）へ切り替えて完走する。
4. **規約遵守境界（V11 D50/D52 拡張）**:
   - `agy -p` に加え、`gemini` CLI（`gemini -p` 等の外部サブプロセス呼び出し）を含む外部 AI CLI ラップ起動を選択肢から完全に除外し、Hermes Agent 正規のネイティブ API プロバイダ＋`delegate_task` のみを使用する。

---

## 2. 合意決定表（D60〜D65）

| ID | 論点 | 採択方針 | 対象 |
| :--- | :--- | :--- | :--- |
| **D60** | 抽象ロール語彙の統一 | 4 つの抽象ロールを定義する: `role:planner`（高度推論・設計・仕様策定・複雑原因究明）、`role:builder`（通常実装・テスト修正・ビルド・定型作業）、`role:visual-reviewer`（スクショ差分・`.annotated.png` 赤入れ読解・`390×844` / `820×1180` 視覚検収）、`role:decision-framer`（`quick-review` 設問設計・トレードオフ整理）。公開スキル・コードは抽象ロール名のみを用い、特定モデル名をハードコードしない。 | `skills/*/SKILL.md`, `apps/bridge/src/*` |
| **D61** | ネイティブ Delegation & Graceful Fallback 契約 | 委譲は Hermes Agent 標準の `delegate_task` のみを使用する。親タスクが抽象ロールの条件に合うサブタスクを委譲し、委譲が失敗・レート制限・タイムアウト・未対応の場合は停止せずフォールバック順に従って自動継続する。 | `skills/*/SKILL.md`, `specs.js`, `pipeline-optimizer.js` |
| **D62** | `mobile` プロファイルのロール→モデル割当 | 主モデル / `role:builder` → **DeepSeek V4.1 Flash**。`role:planner` → 1 次: **Gemini Neon** / フォールバック: **Gemini Hydrogen** → **DeepSeek V4.1 Flash**。`role:visual-reviewer` → 1 次: **Gemini Hydrogen**（または実環境のマルチモーダル適性確認に基づき **Gemini Neon**） / フォールバック: もう一方の Gemini → `.annotation.json` 座標ベースで **DeepSeek V4.1 Flash**。`role:decision-framer` → 単純分岐は **DeepSeek V4.1 Flash**、複数トレードオフ／設計判断を伴う場合は **Gemini Neon**。 | `~/.hermes/profiles/mobile/memories/*`, `SOUL.md` |
| **D63** | 外部 AI CLI 禁止と機械検査の拡張 | `scripts/check-oauth-boundary.mjs` のランタイム禁止パターンに `gemini` CLI サブプロセス起動（`spawn`/`execFile` での `'gemini'` 起動、`gemini -p` 文字列）を追加する。実機の `SOUL.md`・プロファイルメモリ内の `gemini` CLI / `agy -p` 推奨・許容記述は削除・置換する。 | `scripts/check-oauth-boundary.mjs`, 実機 `SOUL.md`, メモリ |
| **D64** | Bridge 側のプロファイル `SOUL.md` 最適化 & SPEC 契約拡張 | `pipeline-optimizer.js` の `A2B_RULES` に抽象ロール委譲・フォールバック・外部 CLI 禁止を追記し、`optimizeHermesSoul` / `getOptimizeStatus` が `~/.hermes/SOUL.md` に加えプロファイル配下（`~/.hermes/profiles/<name>/SOUL.md`、特に `mobile`）も非破壊・冪等に同期できるよう拡張する（既存 API・戻り値は 100% 後方互換）。`specs.js` に任意の `- **Recommended Role**:`（`- **推奨ロール**:`）抽出を追加し、`[Hermes Pilot Execution Contract]` へロール指針を注入する。 | `apps/bridge/src/pipeline-optimizer.js`, `specs.js`, `server.js` |
| **D65** | `SOUL.md` とプロファイルメモリの責務分担 | `SOUL.md` は毎ターン読まれるためマーカー内を短く保ち（「抽象ロールに従いプロファイルメモリの割当表を参照して `delegate_task` / フォールバックを行う」）、具体モデル ID・使い分け基準・フォールバック順は `mobile` プロファイルメモリへ構造化する。編集前に必ず `.bak-<stamp>` を作成する。 | `pipeline-optimizer.js`, 実機 `~/.hermes/` & `profiles/mobile/` |

---

## 3. 詳細技術仕様

### 3.1 同梱スキル（`skills/*/SKILL.md`）の抽象ロール定義（D60 / D61）

1. **`skills/spec-architect/SKILL.md`**:
   - Frontmatter `metadata.hermes` に `abstract_roles: [role:planner, role:builder, role:visual-reviewer, role:decision-framer]`（既存の `role: architect` は後方互換のため維持）を追記する。
   - 「抽象ロールと委譲・フォールバック（Model-Agnostic Delegation）」節を新設し、以下を明記する:
     - Round 1/2 の設計推論・影響分析・バッチ分割は `role:planner` を推奨。
     - 見た目比較の絵／スクショを検証する場合のみ `role:visual-reviewer` を併用。
     - 各バッチ定義に任意行 `- **Recommended Role**: \`role:builder\` | \`role:planner\` | \`role:visual-reviewer\`` を記述可能にする（`### Batch` 内では `####` 以下の見出しを使う規約を維持）。
     - 外部 AI CLI（`gemini` CLI / `agy -p` 等）は使用せず、Hermes ネイティブ `delegate_task` と失敗時のフォールバック手順のみで完走する。

2. **`skills/annotation/SKILL.md`**:
   - Frontmatter `metadata.hermes` に `recommended_role: role:visual-reviewer`（既存 `role: author` 維持）を追記する。
   - 手順 B に以下を明記する:
     - スクショ差分（`.before.png` / `.after.png`）および赤入れ画像（`.annotated.png`）の読解・視覚検証は `role:visual-reviewer` へネイティブ `delegate_task` で委譲することを推奨する。
     - 特定された箇所の修正実装・`npm run deploy`・`npm run verify` は `role:builder` で行う。
     - マルチモーダル委譲に失敗・非対応の場合は停止せず、`.annotation.json` の `marks` 座標配列（0〜1 正規化座標）と `note` を用いてフォールバックし、修正を完了させる。

3. **`skills/quick-review/SKILL.md`**:
   - Frontmatter `metadata.hermes` に `recommended_role: role:decision-framer`（既存 `role: author` 維持）を追記する。
   - 複雑な設計分岐の選択肢抽出・トレードオフ比較は `role:planner`、見た目比較の挿絵チェックは `role:visual-reviewer` へネイティブ `delegate_task` 委譲可能であり、委譲失敗時は主モデルへフォールバックして設問 JSON を完結させる旨を明記する。

### 3.2 Bridge 側拡張（`pipeline-optimizer.js`, `specs.js`, `server.js`, `check-oauth-boundary.mjs`）（D63 / D64）

1. **`apps/bridge/src/pipeline-optimizer.js`**:
   - `A2B_RULES` に抽象ロール（`role:planner` / `role:builder` / `role:visual-reviewer` / `role:decision-framer`）の参照、プロファイルメモリのモデル割当に基づくネイティブ `delegate_task`＋フォールバック、および外部 AI CLI（`gemini` CLI / `agy -p` 等）禁止の簡潔な 2〜3 行を追加する（`SOUL.md` のコンテキスト肥大を防ぐため短文を維持）。
   - `optimizeProfileSouls({ hermesHome, now, block, profiles })` を追加し、`~/.hermes/profiles/<name>/SOUL.md` が存在する場合（または `mobile` プロファイルディレクトリが存在する場合）に、事前 `.bak-<stamp>` バックアップとマーカー間置換（`A2B_START`〜`A2B_END`）を冪等適用する。
   - 既存の `optimizeHermesSoul({ hermesHome, now, block })` 単体呼び出しの戻り値・挙動は 100% 後方互換を維持し、必要に応じてオプショナル引数または `apps/bridge/src/server.js` の `POST /api/pipeline/optimize` 側からプロファイル同期も併せて呼び出す。
   - `getOptimizeStatus` は既存フィールドに加え、`profiles` 配列（`{ name, path, exists, applied, backups }`）を返す（ファイル本文・秘密情報は絶対に返さない）。

2. **`apps/bridge/src/specs.js`**:
   - `RECOMMENDED_ROLE_RE` および `extractRecommendedRole(section)` を追加する。許可ロールは `role:planner` / `role:builder` / `role:visual-reviewer` / `role:decision-framer`（`role:` 接頭辞なしの表記も正規化許容、未宣言時は `null`）。
   - `parseSpec` の各バッチへ `recommendedRole` を付与する。
   - `buildExecutionContract(mode, { recommendedRole } = {})` を後方互換を保ったまま拡張し、`recommendedRole` 指定時または `mode === 'visual-gate'` 時（`role:visual-reviewer` 併用推奨）に、ネイティブ `delegate_task`＋フォールバックおよび外部 AI CLI 禁止を 1〜2 行で `[Hermes Pilot Execution Contract]` に注入する（`BODY_MAX = 6000` を超えない長さに抑える）。

3. **`scripts/check-oauth-boundary.mjs`**:
   - `NEEDLES`（`scope: 'runtime'`）に `gemini` CLI サブプロセス起動検出パターンを追加する:
     - `(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)` で `'gemini'` / `"gemini"` を起動する呼び出し
     - `\bgemini\b\s*['"`]?\s+-p\b`
   - ドキュメント・テストを除外する既存の `scope` 設計を維持する。

### 3.3 実機 Hermes Agent 環境の監査・メモリ / `SOUL.md` 整理（D62 / D65）

1. **監査対象（読み取り先行。認証トークン・API キーは絶対にリポジトリ／カンバン／ログへ出力しない）**:
   - `~/.hermes/config.yaml` および `~/.hermes/profiles/mobile/config.yaml`（既定モデル、利用可能なプロバイダ／モデル識別子、delegation 関連設定）
   - `~/.hermes/SOUL.md` および `~/.hermes/profiles/mobile/SOUL.md`
   - `~/.hermes/memories/` および `~/.hermes/profiles/mobile/memories/`（`MEMORY.md`, `USER.md` 等）
   - `~/.hermes/skills/{spec-architect,quick-review,annotation}/SKILL.md`
2. **監査チェック項目**:
   - `mobile` プロファイルで実際に呼び出し可能な **DeepSeek V4.1 Flash** / **Gemini Neon** / **Gemini Hydrogen** の正確なモデル識別子・プロバイダ設定が確認できること（未設定や候補の曖昧さがある場合は推測せず、`quick-review` シート JSON を 1 枚起票して人に確定してもらう）。
   - `SOUL.md`・プロファイルメモリ内に `gemini` CLI（`gemini -p` 等）・`agy -p`・OAuth 認証ファイル流用などの規約違反ルートや、委譲と矛盾・重複する古い指示が残っていないこと。
   - `delegate_task` のモデル指定・フォールバックが確実に機能する書式になっていること。
3. **整理・反映手順**:
   - 更新対象の各実機ファイル（`SOUL.md`, メモリファイル）に対し、変更前に必ずタイムスタンプ付きバックアップ（`.bak-<stamp>`）を保存する。
   - `mobile` プロファイルメモリへ **「A2B 抽象ロール → モデル割当＆フォールバック表」** を整理・追記し、旧記述・重複メモを統合整理する。
   - 拡張済み `optimizeHermesSoul` ＋ `optimizeProfileSouls`（または `POST /api/pipeline/optimize`）を実行し、`~/.hermes/SOUL.md` と `~/.hermes/profiles/mobile/SOUL.md` のマーカーブロックを最新化する。
   - `~/.hermes/skills/` へ Batch R1 で更新した 3 スキルを同期する。

### 3.4 検証・疎通確認・ドキュメント同期

- `npm run verify`（`npm test` + `check:pwa` + `check:oauth` + `build` + `audit:responsive`）および `npm run build:demo` ＋ `demo/index.html` 同期がエラーゼロで完了すること。
- 実機プロファイル側の非破壊検査（`SOUL.md` 2 回適用時の冪等性、実機 `SOUL.md`・メモリ内の `gemini -p` / `agy -p` 0 件確認、および `mobile` プロファイルでの `delegate_task` 軽量疎通＆フォールバック手順確認）を実施すること。
- `README.md`・`README.ja.md`・`docs/OPERATIONS.md` に抽象ロール設計・プロファイル別 `SOUL.md` 最適化・ネイティブ委譲の仕様を追記する（特定ユーザー固有のローカルモデル名や個人パスは公開ドキュメントに書かない）。

---

## 4. カンバンタスク分割（Batch R1 〜 Batch R4）

### Batch R1: 同梱スキルへの抽象ロール・Delegation/Fallback 規約の実装

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:planner`
- **目的**: `skills/spec-architect/SKILL.md`・`skills/annotation/SKILL.md`・`skills/quick-review/SKILL.md` にモデル非依存の抽象ロール（`role:planner` / `role:builder` / `role:visual-reviewer` / `role:decision-framer`）とネイティブ `delegate_task`＋フォールバック規約、外部 AI CLI 禁止境界を定義する。
- **変更・新規ファイル**:
  - 変更: `skills/spec-architect/SKILL.md`
  - 変更: `skills/annotation/SKILL.md`
  - 変更: `skills/quick-review/SKILL.md`
- **受入条件（Verify）**:
  - 3 スキルすべてに抽象ロール定義・ネイティブ委譲＆フォールバック手順・外部 AI CLI（`gemini` CLI / `agy -p` 等）禁止が明記されていること。
  - 3 スキルに特定ユーザー固有のモデル名（`DeepSeek` / `Gemini Neon` / `Gemini Hydrogen` 等）やトークン・個人パスがハードコードされていないこと。
  - `npm run verify` が全件パスすること。

### Batch R2: Bridge 側サポート＆外部 CLI 境界ガードレールの実装

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: `pipeline-optimizer.js` の `A2B_RULES` 更新およびプロファイル別 `SOUL.md` 冪等同期、`specs.js` の `Recommended Role` 抽出・実行契約注入、`check-oauth-boundary.mjs` の `gemini` CLI 起動検査を実装し、ユニットテストで固定する。
- **変更・新規ファイル**:
  - 変更: `apps/bridge/src/pipeline-optimizer.js`
  - 変更: `apps/bridge/src/specs.js`
  - 変更: `apps/bridge/src/server.js`
  - 変更: `scripts/check-oauth-boundary.mjs`
  - 変更: `apps/bridge/test/pipelineOptimizer.test.js`
  - 変更: `apps/bridge/test/specs.test.js`
- **受入条件（Verify）**:
  - `optimizeHermesSoul` の既存テストがすべて無修正でパスし、追加テストでプロファイル配下（`profiles/mobile/SOUL.md` 等）のバックアップ付き冪等更新と `getOptimizeStatus` の非露出（中身を返さない）が検証されること。
  - `parseSpec` / `buildTaskBody` が `- **Recommended Role**:` を抽出して `[Hermes Pilot Execution Contract]` に反映し、未宣言 SPEC でも後方互換を保つテストがパスすること。
  - `scripts/check-oauth-boundary.mjs` が `gemini` CLI 子プロセス起動と `agy` 起動の両方を検出し、現行コードで `npm run check:oauth` が exit 0 であること。
  - `npm run verify` が全件パスすること。

### Batch R3: 実機プロファイル（mobile / default）の監査・モデル割当反映・SOUL/メモリ整理

- **Execution Mode**: `[Mode: Fast-Track Review]`
- **Recommended Role**: `role:planner`
- **目的**: `~/.hermes/` と `~/.hermes/profiles/mobile/` の `config.yaml`・`SOUL.md`・メモリ・配置済みスキルを監査し、`DeepSeek V4.1 Flash`（主）＋ `Gemini Neon` / `Gemini Hydrogen`（高度推論・スクショ視覚検収へのネイティブ委譲＆フォールバック）の割当表を整理・反映し、`gemini` CLI / `agy -p` 等の旧記述を除去する。
- **変更・新規ファイル**:
  - 監査・整理（ローカル実機環境・リポジトリ外）: `~/.hermes/SOUL.md`, `~/.hermes/profiles/mobile/SOUL.md`, `~/.hermes/profiles/mobile/memories/*`（該当メモリファイル）, `~/.hermes/skills/{spec-architect,quick-review,annotation}/SKILL.md`
- **受入条件（Verify）**:
  - 編集前の全対象ファイルにタイムスタンプ付きバックアップ（`.bak-*`）が作成されていること。
  - `mobile` プロファイルで利用可能な実モデル識別子（DeepSeek V4.1 Flash / Gemini Neon / Gemini Hydrogen）が `config.yaml` 等と整合しており、未設定や候補の曖昧さがあれば推測せず `quick-review` シート（JSON）で人に確定してから反映していること。
  - `~/.hermes/SOUL.md` および `~/.hermes/profiles/mobile/SOUL.md` に最新の A2B マーカーブロックが 1 回だけ冪等に適用されており、`~/.hermes/skills/` に更新済み 3 スキルが同期されていること。
  - 実機の `SOUL.md`・プロファイルメモリから `gemini` CLI / `agy -p` 等の規約違反ルート指示が 0 件になっていること（API キーや認証情報はカンバンコメント・リポジトリへ一切出力しないこと）。

### Batch R4: 結合検証・疎通確認・公開ドキュメント同期

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: 公開ドキュメント（`README.md` / `README.ja.md` / `docs/OPERATIONS.md`）へ抽象ロール・プロファイル最適化の説明を同期し、リポジトリ全体検証と実機プロファイルでの委譲・フォールバック軽量疎通確認を完了させる。
- **変更・新規ファイル**:
  - 変更: `README.md`
  - 変更: `README.ja.md`
  - 変更: `docs/OPERATIONS.md`
  - 同期（差分があれば）: `demo/index.html`
- **受入条件（Verify）**:
  - `README.md` / `README.ja.md` / `docs/OPERATIONS.md` に抽象ロール設計とプロファイル別 `SOUL.md` 最適化が反映され、特定ユーザー固有のローカルモデル名や個人パスが混入していないこと。
  - `mobile` プロファイル側で抽象ロール解決およびネイティブ `delegate_task`（＋フォールバック動作の条件確認）の軽量プローブを行い、確認結果を完了報告へ記載すること。
  - `npm run verify` と `npm run build:demo` が 0 exit で完走すること。
