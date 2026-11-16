# Hermes Pilot 公開前総合監査レポート（Interactive Demo / 公開プラグイン / A2B UI-UX / ドキュメント）

実施日: 2026-11-15  
対象リポジトリ: `hermes-mobile-pwa`（プラグイン名: `hermes-pilot` / `Hermes Pilot`）  
基準ブランチ: `main`（HEAD: `abf5ae5` / V9-B2 完了時点）

---

## 1. 監査サマリと現在のリポジトリ状態（Baseline）

Interactive Demo のデプロイ（Google Sites / 静的ホスティング）、GitHub 公開、および Hermes Agent Plugin Catalog 登録に向けた公開前最終監査を実施した。  
全体として、本体アプリ・ブリッジ・セキュリティ境界の基盤は極めて健全だが、**Interactive Demo の PC デバイス枠表示とモック API 互換性**、**未実装仕様（`SPEC-SHARE280`）の完遂**、**390px スマホ実機での上部計器盤折り返し**、および **ドキュメント・プラグインマニフェストの V3〜V9 追従** に明確な公開前ギャップを確認した。

### 1.1 自動検証スイート実測（2026-11-15 実行）

| チェック項目 | コマンド | 結果 | 備考 |
|---|---|---|---|
| 単体・結合テスト | `npm test` | **781 pass / 0 fail**（~2.3s） | `apps/bridge/test/*.test.js` + `apps/web/test/*.test.js` |
| PWA 適合性検査 | `npm run check:pwa` | **34 / 34 合格** | manifest / アイコン外周不透明・安全域 / SW `fetch` |
| OAuth 境界検査 | `npm run check:oauth` | **187 ファイル 0 違反** | クレデンシャル直接アクセスなし（CLI サブプロセスのみ） |
| 本番ビルド | `npm run build` | **成功** | `index.html` 0.79 kB / `TermPane` 296.09 kB / メイン 502.07 kB |
| デモビルド | `npm run build:demo` | **成功** | `apps/web/dist-demo/google-sites-embed.html` (**933.3 KiB**) |
| レスポンシブ監査 | `npm run audit:responsive` | *skipped* | ローカルブリッジ未起動のためスキップ（V10 実機検証時に実行必須） |

### 1.2 Git ブランチおよび未実装仕様の状態

1. **公開用クリーン履歴ブランチ `clean-initial-2` の乖離**
   - `clean-initial-2`（`6294294`）は V7 時点のスナップショットであり、`main`（`abf5ae5`）との間に **37 ファイル（+3,715 / -547 行）** の差分（V8・V9 の全機能および `SPEC-SHARE280`）が存在する。
   - 公開直前には V10 完了後の `main` をベースにクリーンな Initial Commit ブランチを再生成する必要がある。
2. **未追跡・未実装ドキュメント**
   - `docs/SPEC-PILOT-V9.md`: 実装完了済み（`V9-B1`〜`V9-B4`）だが未コミット（untracked）。
   - `docs/SPEC-SHARE280.md`: インタビュー（`spec-share280-01` Round 1）で合意・策定済みだが **コード未実装**（`apps/web/src/lib/receiptCanvas.js:204-232` の `buildShareText()` が現在も無制限 5 行連結で JA 310 / EN 289 weight となり、X の 280 文字制限を超過する）。

---

## 2. 領域①: Interactive Demo（Google Sites / PC ブラウザ / スマホ実機）監査

Google Sites 埋め込み（`npm run build:demo` → `apps/web/dist-demo/google-sites-embed.html`）および静的デモ配信に関して、以下の **6 件の課題** を特定した。

| 優先度 | 課題 | 該当箇所 | 原因と実害 | 改修方針 |
|---|---|---|---|---|
| **P0（重大）** | **Google Sites 埋め込み時に PC ブラウザでスマホ/タブレット枠が消える** | `DemoStage.jsx:186`<br>`scripts/build-demo-embed.mjs:40`<br>`frame.js:84`<br>`main.jsx:28` | `build-demo-embed.mjs` が `window.__HM_DEMO_EMBED__ = true` を注入するため、`DemoStage.jsx` の `if (narrow \|\| embedded)` が PC 幅（`>= 900px`）でも常に真となり、上部ツールバー（`Phone 390×844` / `Tablet 820×1180` / `Full` / `Dopamine⇄Serotonin` / `Sound` / `Dark⇄Light` / `JA⇄EN`）とデバイスフレームが完全にスキップされる。 | 相対 URL `?demo-frame=1` は Google Sites の `srcdoc` iframe 内で 404 になるため、`embedded && !narrow` 時は現在の `document.documentElement.outerHTML` 内の `__HM_DEMO_EMBED__ = true` を `__HM_DEMO_FRAME__ = true`（＋現在の theme / lang / vibe）に置換した HTML を `<iframe srcDoc={...}>` へ渡す。`main.jsx` で `__HM_DEMO_FRAME__` を `FRAME = true` として扱えば、Google Sites 上の PC ブラウザでも外部通信 0 でデバイスシミュレータが完全動作する。 |
| **P0（重大）** | **Demo の `/api/usage` モック形式不一致で `24h` コストが `—`・`UsageSheet` がエラーになる** | `mockApi.js:1476-1477`<br>`UsageSheet.jsx:17-18`<br>`TasksPane.jsx:1144` | `mockApi.js` がフラットな `{ hours, cacheHitRate, totalTokens, cost, saved, demo }` を返しており、`UsageSheet` / `TasksPane` が参照する `ok: true`・`totals: { cost, input, output, cacheRead, calls, sessions, messages, tools }`・`models`・`topSessions` が欠落。結果として `24h` カードが `—` になり、上部 `💎 99%` タップ時も「取得に失敗しました」と表示され「🧾 完了レシートを作る」ボタンが出ない。 | `usagePayload()` を実ブリッジ互換の `{ ok: true, hours: 24, totals, models, topSessions, cacheHitRate, saved, demo: true }` 形式に更新する。 |
| **P0（重大）** | **Demo の `/api/live` モックに `ok: true` と実行中 `tasks` が欠落** | `mockApi.js:1456-1474`<br>`LiveSheet.jsx:58,95` | `livePayload()` が `ok: true` を返さず、`tasks` 配列や `counts.tasks` も含まれないため、上部 `⚡ 実行中` ピルから `LiveSheet` を開いてもデモ実行中タスクやターンが表示されない。 | `livePayload()` に `ok: true`、`counts: { turns, tasks, architect }`、実行中 `tasks`（経過時間・最新イベント付き）とデモ `turns` を追加する。 |
| **P1（中）** | **Demo モードで未対応の API エンドポイント 4 系統** | `mockApi.js:630-692`<br>`TermPane.jsx:118`<br>`PipelinePanel.jsx:44,92`<br>`SettingsPane.jsx:455,529` | 以下のルートが `demoRoute` に未登録のためフォールバック（空オブジェクト）に落ちる:<br>1. `/api/snippets/term`（設定・端末タブのスニペットが空）<br>2. `/api/pipeline/status` & `POST /api/pipeline/optimize`（設定タブで `SOUL.md 未適用`・`0/0 スキル` 表示）<br>3. `/api/auth/pairing`（「ペアリング QR を表示」が空シートになる）<br>4. `/api/logs` & `/api/search`（ログ・検索が空） | `demoRoute` に 4 系統すべてを実装し、実機同等のデモ応答（疑似 QR 行列・パイプライン最適化状態・ログ・検索ヒット・端末スニペット）を返す。 |
| **P1（中）** | **Demo Architect Seed のフェーズ遷移と Agy 境界の整合** | `mockApi.js:1128-1219` | `runner === 'antigravity'` でもダミー `taskId` を付けており（V9 D41 違反）、そのタスクが `state.tasks` に無いため「🔍 進捗詳細」で `TASK_NOT_FOUND` になる。また `round1_sheet` フェーズを通過せず 1.6 秒で飛ぶ。 | `antigravity` は `taskId: null`、`hermes` は `state.tasks` に実体タスクを作成して詳細表示可能にし、`spawning → round1_sheet → round2_spec → spec_ready` を段階遷移させる。 |
| **P2（低）** | **Demo ターミナル WebSocket（`/ws/term`）が無反応** | `mockApi.js:1566` | `demoSocket()` がチャット JSON-RPC のみ処理し、`/ws/term` の `{ t: 'in', d }` を無視して `{ t: 'out', d }` を返さない。 | `/ws/term` 接続時にウェルカムバナーとプロンプトを送り、スニペット／コマンド入力に対してインタラクティブな疑似出力を返す。 |

---

## 3. 領域②: Hermes Agent 公開プラグイン & Plugin Catalog 監査

### 3.1 マニフェスト・パッケージ整合性

| ファイル | 状態 | 要対応事項 |
|---|---|---|
| `plugin.yaml` | **適合** | `name: hermes-pilot`, `version: 0.1.0`。Catalog 登録用メタデータとして最小要件を満たす。 |
| `apps/dashboard/manifest.json` | **適合（文言補強推奨）** | FastAPI ルーター `plugin_api.py`、タブ位置 `after:git-ops` 定義済み。description を A2B Pipeline 含む最新説明へ微調整可能。 |
| `apps/dashboard/plugin_init.py` | **適合** | `__init__.py` エントリ（no-op `register(ctx)`）実装済み。 |
| `package.json` | **適合** | `skills/`・`bin/hermes-pilot.mjs`・`scripts/` 含め最新。 |
| **`plugin.json`** | **要修正** | `skills` 配列に `"skills/quick-review/SKILL.md"` と `"skills/annotation/SKILL.md"` の 2 件しかなく、**`"skills/spec-architect/SKILL.md"` が欠落**。また `description` と `api` 配列に `/api/architect/*`・`/api/specs/*`・`/api/telemetry/receipt`・`/api/pipeline/*` が未反映。 |

### 3.2 PII・シークレット・セキュリティ境界監査

1. **個人識別情報・環境固有パス**: `git grep` による検査の結果、実行コードおよびテスト内に個人の Tailscale ドメインや実 IP、個人ローカルパスのハードコードは **0 件**。すべてダミーホスト（`mac-mini.tail1234.ts.net`, `box.tailnet.ts.net`, `example.ts.net`）または一般的な `~/Projects`・環境変数（`HP_DATA_DIR`, `HP_BRIDGE_PORT`）で抽象化されている。
   - 注: `docs/PLAN.md`（初期設計メモ）に `127.0.0.1:8787（DSH の別オリジン）` 等の歴史的記述が残るが、公開パッケージとしては運用ドキュメント（`docs/OPERATIONS.md`）と `README` 系を最新化・クリーン化する。
2. **OAuth / 認証境界**: `npm run check:oauth` により 187 ファイルで OAuth クレデンシャル直接参照が 0 件であることを機械検査済み。`agy` Opt-in もユーザー環境でログイン済みの `agy` CLI サブプロセス呼び出しに限定される。
3. **レガシー cron の排除**: `mobile-akapen-watch`（Discord 通知用）は環境から削除済みであり、`scripts/migrate-to-hermes-pilot.mjs` の `cleanupLegacyCrons` により新規導入・移行時にも自動削除される。

---

## 4. 領域③: A2B Pipeline & スマホ・タブレット UI/UX 洗練監査

1. **完了レシートのシェア文「X 換算 280」未実装の解消（`docs/SPEC-SHARE280.md`）**
   - `spec-share280-01` インタビューで確定した設計（`apps/web/src/lib/shareBudget.js` 新設、`buildShareText()` への 6 段階行落とし／見出し詰め適用、`MissionReceiptSheet.jsx` UI 無変更、性質テスト追加）を未着手のまま残さず公開前に実装完了させる。
2. **スマホ縦画面（390px 幅）での上部計器盤（`.telemetry`）の 2 行折り返し修正**
   - **箇所**: `apps/web/src/styles.css:345-409`
   - **現象（実機スクリーンショットで確認）**: `● GW` ＋ `🔔 判断待ち 1` ＋ `⚡ 実行中 2 · browser_exec` ＋ `💎 99%` の 4 ピルが同時に表示されると、`.telemetry` が `flex-wrap: wrap` になっているため 4 個目の `💎 99%` だけが 2 段目に落ち、上部バーの高さが変動してレイアウトシフトが起きる。
   - **改修方針**: `styles.css:342` の設計意図どおり、`.telemetry` を `flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none;` とし、`.t-tool` に適切な `max-width`（例: `110px`）と省略表示を持たせることで、390px 幅でも常時 1 行・固定高さに収める（必要時は横スクロール可能）。
3. **タブレット 2 ペイン（`>= 680px` 狭幅 / `>= 820px` 広幅）および横画面チェック**
   - `apps/web/src/lib/layout.js` の `SPLIT_MIN = 680`（左 280px）／`SPLIT_WIDE_MIN = 820`（左 340px）は CSS と一致している。
   - 公開前の実ブラウザ検証として、ブリッジ起動状態で `npm run audit:responsive`（390×844 / 844×390 / 820×1180 等での横はみ出し・要素重なりゼロ検査）を実行し全ビューポート通過を確認する。

---

## 5. 領域④: パッケージドキュメントの更新・整備・充実化

公開リポジトリおよび Hermes Plugin Catalog 掲載時にユーザーが迷わず導入・運用できるよう、以下のドキュメントを V9/V10 実装水準へ全面更新する。

| ドキュメント | 現状の主な乖離・不足 | 更新内容 |
|---|---|---|
| `plugin.json` | スキル 2 件のみ・API 一覧と説明が V1 時点 | `skills/spec-architect/SKILL.md` 追加、`description` と `api` 一覧を A2B Pipeline 対応に更新。 |
| `README.md` / `README.ja.md` | ・A2B Pipeline（`Spec Seed` → `Quick Review` → `Spec Launchpad` → `ArchitectJobBar/LiveSheet` → `Pipeline Summary` → `Mission Receipt`）の記述が欠落<br>・2 ペイン境界を `>= 820 px` と記載（実際は `>= 680 px` 狭幅 / `>= 820 px` 広幅）<br>・同梱スキル数を `2` と記載（実際は `3`）<br>・単体テスト数を `616` と記載（実際は `780+`）<br>・`Vibe` モード（Dopamine/Serotonin）、スニペット帯トグル、1 タップ環境最適化、`Zero-Stop` / `Visual-Gate`、Opt-in `agy` CLI 境界、Google Sites 埋め込みデモ生成手順（`npm run build:demo`）が未記載 | 上記をすべて正確に反映し、A2B 自律パイプラインのフロー図（Mermaid / ASCII）、Security 境界（Token 認証・Tailscale 推奨・OAuth 非接触）、Plugin Catalog からのインストール〜初回ペアリング手順、および Interactive Demo デプロイ手順を充実化させる。 |
| `docs/OPERATIONS.md` | 旧ポート/表記の名残と API 表の不足 | V5〜V9 で追加された API（`/api/architect/*`, `/api/specs/*`, `/api/telemetry/receipt`, `/api/pipeline/*`, `/api/auth/pairing`, `/api/boards/:slug/tasks/:id/worker`, `/api/review/:id/rerun`）と CLI（`init / start / qr / service / migrate`）・`build:demo` 手順を整理・最新化。 |
| `skills/*/SKILL.md` | `quick-review`, `annotation`, `spec-architect` とも V8/V9 で更新済み | パッケージ配布前の表記ゆれ（旧用語・パス）最終点検のみ実施。 |

---

## 6. 公開前最終改修仕様（`SPEC-PILOT-V10`）バッチ構成案

上記 4 領域の監査結果をすべて解消し、公開・デプロイ可能な状態へ仕上げるため、次の 5 バッチ構成で `docs/SPEC-PILOT-V10.md` を策定することを提案する。

| Batch ID | テーマ | Execution Mode | 主な対象ファイル | 完了条件（Verify） |
|---|---|---|---|---|
| **V10-B1** | `SHARE280`: 完了レシートシェア文の X 換算 280 文字対応 | `Zero-Stop` | `apps/web/src/lib/shareBudget.js`（新設）<br>`apps/web/src/lib/receiptCanvas.js`<br>`apps/web/test/shareBudget.test.js`（新設）<br>`apps/web/test/receipt.test.js` | `SPEC-SHARE280.md` 通り全 12 パターンで `xWeight <= 280`・数値欠落 0・`MissionReceiptSheet.jsx` diff 0 |
| **V10-B2** | `DEMO-STAGE-EMBED`: Google Sites 埋め込み時の PC デバイスシミュレータ（Phone/Tablet）復元 | `Zero-Stop` | `apps/web/src/demo/DemoStage.jsx`<br>`apps/web/src/demo/frame.js`<br>`apps/web/src/main.jsx`<br>`apps/web/test/demoFrame.test.js`（または拡張） | `embedded && !narrow` で `srcDoc` 経由の 390×844 / 820×1180 フレームと上部切替バーが動作、`npm run build:demo` 合格 |
| **V10-B3** | `DEMO-API-PARITY`: Demo モック API / WS の V3〜V9 完全パリティ化 | `Zero-Stop` | `apps/web/src/demo/mockApi.js`<br>`apps/web/test/v8DemoSync.test.js` 等 | `/api/usage`・`/api/live`・`/api/pipeline/*`・`/api/snippets/term`・`/api/auth/pairing`・`/api/logs`・`/api/search`・`/ws/term`・Architect Seed がすべてエラー無し・実機互換で動作 |
| **V10-B4** | `MOBILE-TELEMETRY-POLISH`: 390px スマホ上部計器盤の 1 行固定化＆レスポンシブ点検 | `Zero-Stop` | `apps/web/src/styles.css`<br>関連テスト | `<= 480px` で 4 ピル表示時も折り返さず 1 行（横スクロール＋`.t-tool` 省略）に収まる |
| **V10-B5** | `DOCS-AND-MANIFEST-FINAL`: `plugin.json`・`README.md`・`README.ja.md`・`docs/OPERATIONS.md` 最終整備 & 全体検証 | `Zero-Stop` | `plugin.json`<br>`README.md`<br>`README.ja.md`<br>`docs/OPERATIONS.md`<br>`apps/dashboard/manifest.json` | `npm run verify` + `npm run build:demo` + 実機/ブリッジ経由 `audit:responsive` 全緑 |

> **公開直前の最終運用ステップ（V10 完了後）**:  
> 1. `npm run build:demo` で生成される `apps/web/dist-demo/google-sites-embed.html` を Google Sites（または GitHub Pages）へデプロイして動作確認。  
> 2. V10 完了状態の `main` から公開用クリーン履歴ブランチ（新しい `clean-initial`）を切り出して GitHub 公開し、Hermes Agent Plugin Catalog へ登録申請。
