# SPEC: Hermes Pilot V10 — 公開前最終改修・Interactive Demo 完全パリティ・ドキュメント総整備仕様書 (`SPEC-PILOT-V10`)

- **状態**: 仕様確定（2026-11-15 公開前総合監査 [PRE-RELEASE-AUDIT.md](./PRE-RELEASE-AUDIT.md) 合意済み）
- **前提仕様**:
  - [SPEC-PILOT-V9.md](./SPEC-PILOT-V9.md)（`V9-B1`〜`V9-B4` / commit `abf5ae5` まで実装完了）
  - [SPEC-SHARE280.md](./SPEC-SHARE280.md)（インタビュー `spec-share280-01` 確定済み・本 SPEC の `V10-B1` で実装完遂）
  - [PRE-RELEASE-AUDIT.md](./PRE-RELEASE-AUDIT.md)
- **対象リポジトリ**: `hermes-mobile-pwa`（プラグイン名: `hermes-pilot` / `Hermes Pilot`）
- **全バッチ共通の完了条件**:
  - `npm run verify`（`npm test` + `check:pwa` + `check:oauth` + `build` + `audit:responsive`）が 0 fail（OAuth 境界 0 違反、PWA 34 項目合格）であること
  - `npm run build:demo` が 0 exit で自己完結 HTML（`apps/web/dist-demo/google-sites-embed.html`）を生成でき、通常本番ビルド（`apps/web/dist/`）に `demo/` のコード・文字列が 1 バイトも混入していないこと
  - `apps/web/src/i18n/en.json`・`ja.json` およびテスト（`i18n.test.js` / `i18nLeak.test.js` / `noHardcodedJapanese.test.js`）に違反しないこと

---

## 1. コンセプト

Interactive Demo の Google Sites デプロイ、GitHub オープンソース公開、および Hermes Agent Plugin Catalog への登録直前の最終仕上げとして、公開前総合監査（[PRE-RELEASE-AUDIT.md](./PRE-RELEASE-AUDIT.md)）で特定された残課題をすべて解消する。

1. **確定済み仕様の完遂（`SHARE280`）**: 完了レシートのシェア文を X 換算 280 文字以内に確実に収め、SNS 共有時の文字数溢れをゼロにする。
2. **Interactive Demo の完全性**: Google Sites 単一ファイル埋め込み（`google-sites-embed.html`）を PC ブラウザで開いたときも Phone（`390×844`）/ Tablet（`820×1180`）シミュレータを再現し、デモ内の全シート・全 API / WebSocket が本番同等に動作するようにする。
3. **モバイル実機 UI の仕上げ**: `390px` 幅のスマホ縦持ちで上部コックピット計器盤が 2 行目へ折り返してガタつく問題を解消する。
4. **公開パッケージのドキュメント・マニフェスト同期**: `plugin.json`・`README.md`・`README.ja.md`・`docs/OPERATIONS.md` を V3〜V10 の実態へ完全同期する。

---

## 2. 合意決定表（D45〜D49）

| ID | 論点 | 採択方針 | 根拠・関連箇所 |
| :--- | :--- | :--- | :--- |
| **D45** | `SHARE280`（完了レシートの X 換算 280 文字制限） | [SPEC-SHARE280.md](./SPEC-SHARE280.md) の確定合意どおり、`apps/web/src/lib/shareBudget.js` を新設して `buildShareText()` へ 6 段階フォールバックを適用する（予算 280・行ごと落とし・数値は 1 つも落とさない・残数カウンタ UI なし・JA/EN 共通）。 | `SPEC-SHARE280.md` §0〜§3 / `apps/web/src/lib/receiptCanvas.js:204-232` |
| **D46** | Google Sites 埋め込み時の PC デバイスシミュレータ復元 | `embedded`（`__HM_DEMO_EMBED__ = true`）であっても PC 幅（`>= 900px` / `!narrow`）では `DemoStage` の上部ツールバーと Phone / Tablet ベゼルを描画する。相対 URL `?demo-frame=1` は `srcdoc` 内で 404 になるため、`mount()` 直前に退避した初期 HTML に `window.__HM_DEMO_FRAME__ = true` を注入した文字列を `<iframe srcDoc={...}>` へ渡す。既定テスト契約 `frameUrl(..., true) === null` は維持する。 | `apps/web/src/demo/DemoStage.jsx:186` / `frame.js` / `main.jsx` / `scripts/build-demo-embed.mjs` |
| **D47** | Interactive Demo のモック API / WS 完全パリティ化 | `mockApi.js` の `/api/usage`・`/api/live` を本番スキーマ（`ok: true`, `totals`, `models`, `topSessions`, `tasks`, `counts`）へ統一し、未実装ルート（`/api/snippets/term`, `/api/pipeline/status`, `POST /api/pipeline/optimize`, `/api/auth/pairing`, `/api/logs`, `/api/search`）と `/ws/term` 疑似出力を実装する。Demo Architect Seed は `runner === 'antigravity'` で `taskId: null`（D41 準拠）、`runner === 'hermes'` で `[ARCH]` 実タスクを作成し、`spawning → round1_sheet → round2_spec → spec_ready` と段階遷移させる。 | `apps/web/src/demo/mockApi.js` / `UsageSheet.jsx` / `LiveSheet.jsx` / `PipelinePanel.jsx` / `SettingsPane.jsx` |
| **D48** | スマホ `390px` 幅での上部計器盤（`.telemetry`）1 行固定化 | `.telemetry` を `flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none;` とし、狭幅端末で 4 ピル（`● GW` / `🔔 判断待ち` / `⚡ 実行中` / `💎 99%`）が同時に並んでも 2 段落ちしないようにする。44px タップ当たり判定を維持するため上下パディング（`10px 12px`）は保持する。 | `apps/web/src/styles.css:345-436` / `scripts/audit-responsive.mjs:384-420` |
| **D49** | 公開プラグインマニフェスト & パッケージドキュメント全面更新 | `plugin.json` に `skills/spec-architect/SKILL.md` と A2B API を反映し、`README.md`・`README.ja.md`・`docs/OPERATIONS.md`・`apps/dashboard/manifest.json` を V3〜V10 実装水準（A2B Pipeline、3 スキル、`>= 680px`/`>= 820px` 2 ペイン、Vibe モード、スニペット帯トグル、1 タップ環境最適化、`Zero-Stop`/`Visual-Gate`、Opt-in `agy` 境界、`npm run build:demo`、実測テスト数）へ更新する。 | `plugin.json` / `README.md` / `README.ja.md` / `docs/OPERATIONS.md` / `apps/dashboard/manifest.json` |

---

## 3. 詳細技術仕様

### 3.1 `shareBudget.js` と `buildShareText()` の 280 文字制限（D45）

詳細は [SPEC-SHARE280.md](./SPEC-SHARE280.md) を正本とし、以下の契約を実装する。

1. **新規 `apps/web/src/lib/shareBudget.js`（純関数・DOM 非依存）**:
   - `export const X_WEIGHT_LIMIT = 280`
   - `export function xWeight(text)`: 文字列をコードポイント単位（`for (const ch of String(text ?? ''))`）で走査し、`U+0000–U+10FF` / `U+2000–U+200D` / `U+2010–U+201F` / `U+2032–U+2037`（改行 `\n` も `U+000A` のため 1）を **1**、それ以外（日本語・CJK・絵文字等）を **2** として合計値を返す。
   - `export function truncateToWeight(text, budget, ellipsis = '…')`: 先頭からコードポイント単位で積み上げ、切ったときに `ellipsis`（`xWeight(ellipsis)` = 2）を含めて必ず `xWeight(result) <= budget` に収める。元文字列が `budget` 以下なら原文のまま返す。
   - `export function fitBlocks(blocks, { limit = X_WEIGHT_LIMIT, joiner = '\n', steps = [] } = {})`: 空文字でない要素を `joiner` で連結した `xWeight` が `limit` 以下になるまで `steps`（`{ drop: i }`, `{ set: [i, text] }`, `{ truncate: i }`, `{ cutAt: [i, sep] }`）を先頭から適用する。既に `<= limit` なら即終了し、落とした要素は空行を残さない（`filter(Boolean)`）。戻り値は `{ text, applied }`。
2. **`apps/web/src/lib/receiptCanvas.js`（`buildShareText()`）**:
   - `MissionReceiptSheet.jsx` は無変更（diff 0・残数カウンタ UI は追加しない）。
   - `buildShareText(receipt, opts = {})` 内で `line2`（経過時間併記あり）に加えて `line2NoWall`（経過時間併記なし・数値はすべて残す）を組み立て、`fitBlocks([line1, line2, line3, line4, line5], { limit: opts.limit ?? X_WEIGHT_LIMIT, steps })` を呼び出す。`steps` は以下の 6 段固定とする:
     1. `{ drop: 4 }`（フッター）
     2. `{ drop: 3 }`（人の手数）
     3. `{ drop: 2 }`（節約見込 / コスト / キャッシュ行）
     4. `{ set: [1, line2NoWall] }`（所要時間の `wall` 併記だけ外す）
     5. `{ truncate: 0 }`（見出しのレポート名を `…` 付きで詰める）
     6. `{ cutAt: [0, ' — '] }`（極限超過時は見出しタイトル後ろを落とす）
   - 空の `receipt`（`{ kpi: {} }`）は 5 行（JA 245 / EN 233）のまま `applied: []` で返る。

### 3.2 Google Sites 埋め込み時の PC デバイスシミュレータ復元（D46）

1. **`apps/web/src/demo/frame.js`**:
   - `export const FRAME_FLAG = '__HM_DEMO_FRAME__'` を定義する。
   - `export function isFrameSession(win = globalThis.window)` を追加する:
     - `if (!win) return false`
     - `if (win[FRAME_FLAG] === true) return true`
     - `try { return new URLSearchParams(win.location?.search ?? '').get('demo-frame') === '1' } catch { return false }`
   - `export function buildEmbeddedFrameSrcDoc(initialHtml)`:
     - 引数 `initialHtml`（空なら `''`）に対し、`<script>try{window.__HM_DEMO_FRAME__=true}catch(e){}</script>` を `<head>` 直後（大文字小文字不問・`<head>` が無い場合は文字列先頭）に 1 回だけ差し込んだ文字列を返す。すでに `__HM_DEMO_FRAME__` 宣言スクリプトが含まれていれば二重挿入しない（冪等）。
   - `frameUrl(href, embedded)` は既存契約（`embedded === true` で `null`、`false` で `?demo-frame=1` URL）を維持し、`demoMode.test.js:473` を壊さない。
2. **`apps/web/src/main.jsx`**:
   - **`demo/` の静的 top-level import は絶対に書かない**（通常本番ビルドに `demo/` を 1 バイトも入れないため、`if (DEMO)` の内側で動的 import する構成を維持する）。
   - `if (DEMO)` の先頭（`createRoot` や `<App />` マウントより前）で、まだ `root` が空の初期 HTML を `if (typeof document !== 'undefined' && !globalThis.__HM_INITIAL_HTML__) { globalThis.__HM_INITIAL_HTML__ = '<!doctype html>\n' + document.documentElement.outerHTML }` として退避する。
   - `const { ..., isEmbeddedSession, isFrameSession, installSafeStorage } = await import('./demo/frame.js')` を読み込み、`const isFrame = isFrameSession(globalThis.window)` で判定する。
   - `if (isFrame)` 内で `if (isEmbeddedSession(globalThis.window)) installSafeStorage()` を呼んでから `root.render(...)` する（Google Sites 由来の `srcdoc` iframe 内でも Storage 参照例外を防ぐ）。
3. **`apps/web/src/demo/DemoStage.jsx`**:
   - `frameKey` state（初期値 `0`）を追加する。
   - `restart()` 内で `if (embedded)` のときは `setReady(false); setFrameKey((k) => k + 1); return` とし、親ページの `location.reload()`（`srcdoc` 環境で失敗する恐れあり）ではなく子 iframe の再生成でデモを初期状態へ戻す。
   - `const srcDoc = useMemo(() => (embedded ? buildEmbeddedFrameSrcDoc(globalThis.__HM_INITIAL_HTML__ ?? '') : null), [embedded])` を用意する。
   - **分岐変更**: L186 の `if (narrow || embedded)` を **`if (narrow)`**（+ `!embedded || srcDoc` が前提、もし `embedded && !srcDoc` の異常系だけフォールバックで `.demo-mobile` へ逃がす）へ変更する。これにより Google Sites（`google-sites-embed.html`）を PC ブラウザ（`innerWidth >= 900px`）で開いた場合も `.demo-bar`（Phone/Tablet/Full・Vibe・Sound・Dark/Light・JA/EN・Restart）とデバイスベゼルが表示される。
   - `<iframe key={frameKey} ref={frameRef} className="demo-frame" title={t('demo.badge')} {...(url ? { src: url } : { srcDoc })} width={size.width} height={size.height} onLoad={...} />` の形式で描画する。

### 3.3 Interactive Demo モック API / WS の完全パリティ化（D47）

対象ファイル: `apps/web/src/demo/mockApi.js`（UI と完全一致するペイロードを返す）。

1. **`demoRoute(path)` 追加ルート**:
   - `p === '/api/snippets' || p === '/api/snippets/term'` → `{ name: 'snippets', kind: p.endsWith('/term') ? 'term' : 'chat', params }`
   - `p === '/api/pipeline/status'` → `{ name: 'pipeline.status', params }`
   - `p === '/api/pipeline/optimize'` → `{ name: 'pipeline.optimize', params }`
   - `p === '/api/auth/pairing'` → `{ name: 'auth.pairing', params }`
   - `p === '/api/logs'` → `{ name: 'logs', params }`
   - `p === '/api/search'` → `{ name: 'search', params }`
2. **`usage` ハンドラ（`UsageSheet.jsx:17-118` / `TasksPane.jsx:1144` 準拠）**:
   - `ok: true`, `hours: 24`, `cacheHitRate: 0.994`, `totalTokens: 1_240_000`, `cost: 1.08`, `saved: 12.4` に加え、必須の以下を含める:
     - `totals: { cost: 1.08, input: 1_232_500, output: 7_500, cacheRead: 1_225_100, calls: 42, sessions: 4, messages: 28, tools: 64 }`
     - `models`: `deepseek/deepseek-v4.1-flash` 等 2 件（各要素 `{ model, calls, input, output, cacheRead, cost }`）
     - `topSessions`: `{ id, profile, title, source, input, output, at, cost }` 形式の 2 件（`state.now` を用いた時刻）
3. **`live` ハンドラ（`LiveSheet.jsx:58-250` 準拠）**:
   - `ok: true` を付与する。
   - `runningTasks = state.tasks.filter((t) => t.status === 'running')` を `{ id, board: DEMO_BOARD, boardName: 'mobile', title, assignee: t.assignee ?? 'mobile', startedAt: t.startedAt, elapsedSec, workerPid: 42400 + i }` に整形して `tasks` として返す。
   - `turns`: `runningTasks.length > 0`（または実行中 Architect がある）ときは 1 件のリアルなデモターン `{ profile: 'default', sessionId: DEMO_SESSION, title: 'Demo — A2B pipeline in four steps', source: 'mobile', platform: 'pwa', startedAt, elapsedSec, expiresInSec: 280, lastActivity: 'Running verification suite', lastTool: { name: 'exec', at: at - 4000 } }` を返し、完了後は `[]` を返す。
   - `counts: { turns: turns.length, tasks: tasks.length, architect: architectRunningCount }` を返す。
4. **`snippets`（`term` 対応）**:
   - `route.kind === 'term'` のとき、端末タブ向けデモスニペット配列（EN/JA 対応の `Pilot Status` / `GW Status` / `Kanban Active` / `Run Verify` 等、`{ id, label, text, hot, run, note }` 形式）を `snippetPayload` と同一構造 `{ snippets, allSnippets, overrides: {}, custom: [], customMax: 16, hotLimit: 8, lang }` で返す。
5. **`pipeline.status` / `pipeline.optimize`（`PipelinePanel.jsx:108-164` 準拠）**:
   - `state.pipeline = { optimized: false }` を保持し（`resetDemoState` で初期化）、`pipeline.status` は `{ ok: true, soul: { applied: state.pipeline.optimized, path: '~/.hermes/SOUL.md' }, hermes: { present: state.pipeline.optimized ? ['quick-review', 'annotation', 'spec-architect'] : ['quick-review', 'annotation'] }, bundled: { names: ['quick-review', 'annotation', 'spec-architect'] }, demo: true }` を返す。`POST /api/pipeline/optimize` で `state.pipeline.optimized = true` にし、`{ ok: true, status: ... }` を返す（デモ上で「1 タップ環境最適化」のビフォー・アフターを体験可能にする）。
6. **`auth.pairing`（`SettingsPane.jsx:1087-1129` / `server.js:529-547` 準拠）**:
   - 21×21 の有効な QR 風 `0`/`1` 文字列配列（3 隅のファインダーパターン付き 21 行×21 列）`qrRows`・`qrMargin: 4`・`targets: [{ kind: 'tailscale', label: 'Tailscale HTTPS (demo)', url: 'https://demo.tailnet.ts.net:8444/?token=demo-only' }, { kind: 'lan', label: 'LAN (demo)', url: 'http://192.168.1.42:4097/?token=demo-only' }]`・`tailscale: true`・`dnsName: 'demo.tailnet.ts.net'`・`expiresAt: Date.now() + 300_000` を返す。
7. **`logs` / `search`**:
   - `logs`: `{ ok: true, file, text: '...' }`（`SettingsPane.jsx:530`）。
   - `search`: `{ ok: true, tookMs: 4, hits: [...] }`（`q` でフィルタし、`profile, messageId, sessionId, snippet, role, at, sessionTitle, source` を持つ配列・`SearchSheet.jsx:78-107` 準拠）。
8. **Demo Architect Seed（`startDemoArchitectJob` / `advanceArchitectJob`・D41/D42 整合）**:
   - `startDemoArchitectJob`:
     - `runner === 'antigravity'` のときは **`taskId: null`**（D41: Agy Opt-in でカンバンタスクを作らない）。
     - `runner === 'hermes'` のときは `taskId = 't_demo_arch_' + seq` とし、`state.tasks.unshift({ id: taskId, board: DEMO_BOARD, title: '[ARCH] ' + seed.slice(0, 48), status: 'running', assignee: 'architect', body: seed, events: [{ kind: 'spawned', at: now }], createdAt: now, startedAt: now, updatedAt: now })` を追加して「🔍 進捗詳細」で実タスクが開けるようにする。
   - `advanceArchitectJob`:
     - `running`（`!job.sheetPath`） → `job.sheetPath = 'sheets/spec-demo-seed-' + key + '-1.json'` を立てて `status: 'awaiting_spec'`（`phase: 'round1_sheet'`）へ進め、`tickMs` 後に次段へ。
     - 次段（`!job.reviewSeenOnce`） → `job.reviewSeenOnce = true`（`phase: 'round2_spec'`）にし、`tickMs` 後に `spec_ready` / `launched` へ完了させる。
9. **`demoSocket(path = '/ws/chat')` の `/ws/term` 対応**:
   - `String(path).startsWith('/ws/term')` のときは、接続時に `{ t: 'out', d: '\r\n\x1b[36mHermes Pilot Demo Shell (read-only simulation)\x1b[0m\r\n$ ' }` を送信する。
   - クライアントから `{ t: 'in', d }` を受け取ったら入力をエコーし、`\r` / `\n` を含めばコマンド行（例: `hermes`, `git`, `npx hermes-pilot`, `npm`, `help` 等）に応じたリアルな疑似標準出力＋次の `$ ` プロンプトを `{ t: 'out', d }` で返す。

### 3.4 スマホ `390px` 幅での上部計器盤（`.telemetry`）1 行固定化（D48）

1. **`apps/web/src/styles.css:345-436`**:
   - `.telemetry` の `flex-wrap: wrap` を **`flex-wrap: nowrap`** に変更し、`overflow-x: auto; overflow-y: visible; scrollbar-width: none; -webkit-overflow-scrolling: touch;` に設定する。
   - 上下パディング **`padding: 10px 12px;`** は維持する（`scripts/audit-responsive.mjs` の 44px 当たり判定検査で、子要素 `.t-pill::before`（44px）が `.telemetry` の `overflow-x: auto` による暗黙 `overflow-y: auto` クリップ領域に収まるようにするため必須）。
   - `.t-tool` の `max-width` を狭幅（`@media (max-width: 480px)` または既定調整）で `92px`（既存 `26vw` と同程度またはやや抑制）＋ `display: inline-block; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom;` とし、さらに `.t-pill` の既定 `max-width` も `none` に寄せて省略が `.t-tool` で完結するようにする。

### 3.5 パッケージドキュメント・マニフェスト総整備（D49）

1. **`plugin.json`**:
   - `skills`: `["skills/quick-review/SKILL.md", "skills/annotation/SKILL.md", "skills/spec-architect/SKILL.md"]` の 3 スキルに更新。
   - `description`: A2B Pipeline（`Spec Seed`, `Quick Review`, `Visual Annotation`, `Spec Launchpad`, `Mission Receipt`）を含む説明へ更新。
   - `api`: `/api/architect/*`, `/api/specs/*`, `/api/telemetry/receipt`, `/api/pipeline/*`, `/api/live`, `/api/usage`, `/api/boards/*`, `/api/review/*`, `/api/auth/*`, `/api/capabilities` を整理・明記。
2. **`apps/dashboard/manifest.json`**:
   - `description` を A2B Pipeline + ペアリング + Keep-alive 管理を的確に表す文面へ更新（既存の `name`, `tab`, `entry`, `css`, `api` は互換性維持のため変更しない）。
3. **`README.md`（英語）& `README.ja.md`（日本語）**:
   - **A2B Pipeline 全体像**: `📝 Spec Seed`（`Zero-Stop` 既定 / `Visual-Gate` 方針、Hermes Native vs Opt-in `Antigravity (agy)` CLI サブプロセス境界）→ `Quick Review`（1 タップ構造化インタビュー・赤入れ注釈）→ `🚀 Spec Launchpad`（アコーディオン表示・MD プレビュー・冪等一括起票）→ `⚡ ライブ監視`（`ArchitectJobBar` フェーズ/停滞検知・`LiveSheet`・`WorkerFeed`）→ `📊 パイプライン完走サマリ & 🏆 Mission Receipt`（1200×630 PNG レシート & X 換算 280 文字シェア文）の一連フローを解説（図解含む）。
   - **UX・設定機能**: `Vibe` モード（`Dopamine` ⇄ `Serotonin`＋維持されるハプティクス・効果音トグル）、スニペット帯（チャット/注釈/ターミナル）表示切替トグル、1 タップ環境最適化（`SOUL.md` 規律追記＋3 スキル自動配置）、レガシー `mobile-akapen-watch` cron 自動清掃。
   - **レイアウトと技術数値の正確化**:
     - タブレット/横向き 2 ペイン分割境界を **`>= 680 px`（狭幅 2 ペイン: 左 280px）および `>= 820 px`（広幅 2 ペイン: 左 340px）** に修正。
     - 同梱スキル数を **3 つ（`quick-review`, `annotation`, `spec-architect`）** に修正。
     - テスト数・検証スイート記述を最新実態（`npm run verify`: 単体・結合テスト約 800 件・PWA 34 項目検査・OAuth 境界検査 `check:oauth`・Production Build・`audit:responsive`）へ更新。
   - **Interactive Demo & Google Sites デプロイ節追加**: `npm run build:demo` による GitHub Pages 向けビルドおよび自己完結 HTML `apps/web/dist-demo/google-sites-embed.html` の Google Sites 埋め込み手順・PC シミュレータ機能を説明。
4. **`docs/OPERATIONS.md`**:
   - API リファレンス表に `/api/specs`, `/api/specs/content`, `/api/specs/launch`, `/api/specs/reports`, `/api/architect/config`, `/api/architect/jobs`, `/api/architect/seed`, `/api/architect/jobs/:id/dismiss`, `/api/telemetry/receipt`, `/api/pipeline/status`, `/api/pipeline/optimize`, `/api/auth/pairing`, `/api/boards/:slug/tasks/:id/worker`, `/api/review/:id/rerun` を追記・整理。
   - `hermes-pilot` CLI コマンド群（`init / start / qr / service / migrate`）および `npm run build:demo` / `npm run verify` 運用手順を整理（古い `~/Projects/hermes-mobile-pwa` や個人環境的な表現が残っていれば公開プラグイン基準の表現へ統一）。

---

## 4. 実装バッチ分割（Hermes Agent 自走用）

すべてのバッチは `Zero-Stop`（自律完走）で実行でき、原則として上から直列（または `V10-B1`〜`V10-B4` 実装後に `V10-B5` で最終集計・ドキュメント反映・全体検証）で進める。

### Batch V10-B1: SHARE280 — 完了レシートのシェア文 X 換算 280 文字対応

- **Execution Mode**: `[Mode: Zero-Stop]`
- **目的**: 確定済み仕様 [SPEC-SHARE280.md](./SPEC-SHARE280.md) のとおり、完了レシートのシェア文を JA/EN ともに X（twitter-text）加重 280 文字以内に収める。
- **変更・新規ファイル**:
  - 新規 `apps/web/src/lib/shareBudget.js`（`X_WEIGHT_LIMIT`, `xWeight`, `truncateToWeight`, `fitBlocks`）
  - 変更 `apps/web/src/lib/receiptCanvas.js`（`buildShareText()` のみに 6 段の `steps` と `fitBlocks` を適用。`MissionReceiptSheet.jsx` と `drawReceipt()` は無変更）
  - 新規 `apps/web/test/shareBudget.test.js`
  - 変更 `apps/web/test/receipt.test.js`（既存 `:189-190` の 5 行固定アサーションを新契約へ置換＋全 12 パターン性質テスト追加）
- **受入条件（Verify）**:
  - `node --test apps/web/test/shareBudget.test.js apps/web/test/receipt.test.js` が **0 fail**
  - base fixture 実測で JA = **275 / 4 行**、EN = **259 / 4 行**、空 receipt は JA 245 / EN 233 の 5 行のまま、極端な見出し（400 字）でも `xWeight <= 280` かつ KPI 数値が 1 つも落ちないこと
  - `apps/web/src/features/MissionReceiptSheet.jsx` に差分がないこと（`git diff` 0）

### Batch V10-B2: DEMO-STAGE-EMBED — Google Sites 埋め込み時の PC デバイスシミュレータ復元

- **Execution Mode**: `[Mode: Zero-Stop]`
- **目的**: `google-sites-embed.html`（`srcdoc` 環境）を PC ブラウザ（`>= 900px`）で開いた際も `DemoStage` の上部ツールバーと Phone（390×844）/ Tablet（820×1180）デバイスシミュレータを完全表示させる。
- **変更・新規ファイル**:
  - `apps/web/src/demo/frame.js`（`FRAME_FLAG`, `isFrameSession`, `buildEmbeddedFrameSrcDoc` 追加。既存 `frameUrl` の契約は不変）
  - `apps/web/src/main.jsx`（`if (DEMO)` 内のみで初期 HTML を `__HM_INITIAL_HTML__` へ退避、`isFrameSession` 判定、`if (isFrame && isEmbeddedSession()) installSafeStorage()` 呼び出し。静的 `./demo/` import は作らない）
  - `apps/web/src/demo/DemoStage.jsx`（`if (narrow || embedded)` を `if (narrow)` に緩和、`embedded` 時は `<iframe srcDoc={srcDoc} ...>` を描画し、`restart()` を `frameKey` インクリメントで動作させる）
  - `apps/web/test/demoMode.test.js`（`isFrameSession`・`buildEmbeddedFrameSrcDoc` 冪等性・`frameUrl` 後方互換・本番バンドルへの `demo/` 非混入を維持したテスト追加）
- **受入条件（Verify）**:
  - `npm test` が **0 fail**
  - `npm run build` の `apps/web/dist/assets/*.js` に `demo/` モジュール（`__HM_INITIAL_HTML__` 等以外のモックデータ）が混入していないこと
  - `npm run build:demo` が 0 exit で完了し、`apps/web/dist-demo/google-sites-embed.html` の `verifyEmbedHtml()` が問題 0 件であること

### Batch V10-B3: DEMO-API-PARITY — Interactive Demo モック API / WS の V3〜V9 完全パリティ化

- **Execution Mode**: `[Mode: Zero-Stop]`
- **目的**: デモモードの `/api/usage`・`/api/live` 不整合と未対応エンドポイント（`/api/snippets/term`・`/api/pipeline/*`・`/api/auth/pairing`・`/api/logs`・`/api/search`・`/ws/term`）を解消し、Architect Seed の段階遷移と Agy 境界を本番仕様へ揃える。
- **変更・新規ファイル**:
  - `apps/web/src/demo/mockApi.js`（`demoRoute`, `usage`, `live`, `snippets(term)`, `pipeline.status`, `pipeline.optimize`, `auth.pairing`, `logs`, `search`, `startDemoArchitectJob`/`advanceArchitectJob`, `demoSocket('/ws/term')`）
  - `apps/web/test/demoMode.test.js` および/または `apps/web/test/v8DemoSync.test.js`（上記全ルート・`UsageSheet`/`LiveSheet`/`PipelinePanel`/`SettingsPane(qrRows)` 互換スキーマ・`antigravity` 時 `taskId === null`・`/ws/term` 応答の自動テスト追加）
- **受入条件（Verify）**:
  - `npm test` が **0 fail**
  - `/api/usage` が `{ ok: true, totals: { cost, input, output, cacheRead, calls, sessions, messages, tools }, models, topSessions }` を返すこと
  - `/api/live` が `{ ok: true, counts: { turns, tasks, architect }, tasks, turns, architect }` を返すこと
  - `/api/auth/pairing` が 21×21 正方の `'0'`/`'1'` `qrRows` と `targets` を返し、`/api/pipeline/optimize` 後に `status.soul.applied === true` および 3 スキルが揃うこと

### Batch V10-B4: MOBILE-TELEMETRY-POLISH — 390px スマホ上部計器盤 1 行固定化＆レスポンシブ点検

- **Execution Mode**: `[Mode: Zero-Stop]`
- **目的**: 390px 幅のスマホ縦持ちで上部コックピット計器盤（`.telemetry`）の 4 ピル（GW / 判断待ち / 実行中 / キャッシュ燃費）が 2 行目へ折り返さないよう 1 行横スクロール＋ツール名省略に整え、レイアウトシフトを防ぐ。
- **変更・新規ファイル**:
  - `apps/web/src/styles.css`（`.telemetry` の `flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; padding: 10px 12px;`、`.t-pill` と `.t-tool` の省略調整）
  - `apps/web/test/telemetry.test.js` または CSS 構造回帰テスト（`.telemetry` の `flex-wrap: nowrap` および `padding-top`/`padding-bottom` >= 10px 維持の検査）
- **受入条件（Verify）**:
  - `npm test && npm run build` が **0 fail**
  - （ローカルブリッジ稼働環境がある場合）`npm run audit:responsive` が `390x844` / `844x390` / `820x1180` 等全ビューポートで 0 違反となること（`clip` / `tap` の新規違反を増やさないこと）

### Batch V10-B5: DOCS-AND-MANIFEST-FINAL — 公開プラグインマニフェスト・README・運用ドキュメント総整備と最終検証

- **Execution Mode**: `[Mode: Zero-Stop]`
- **目的**: GitHub 公開・Hermes Agent Plugin Catalog 登録・Google Sites デモ公開に向けて、すべてのマニフェスト・ドキュメント・検証テストを最終同期する。
- **変更・新規ファイル**:
  - `plugin.json`（`skills` に `skills/spec-architect/SKILL.md` 追加、`description` / `api` 更新）
  - `apps/dashboard/manifest.json`（`description` 最新化）
  - `README.md` / `README.ja.md`（A2B Pipeline 全体像・`Zero-Stop`/`Visual-Gate`・Opt-in `agy` 境界・Vibe/スニペットトグル/1 タップ最適化・2 ペイン境界 `>= 680px`/`>= 820px`・同梱 3 スキル・最新テスト実測数・`npm run build:demo` & Google Sites 埋め込み手順・セキュリティ節の充実）
  - `docs/OPERATIONS.md`（全 API 表・CLI コマンド・デモビルド手順の最新化と個人環境名残りの整理）
  - `skills/quick-review/SKILL.md`, `skills/annotation/SKILL.md`, `skills/spec-architect/SKILL.md` の最終誤記点検（変更が必要な場合のみ）
- **受入条件（Verify）**:
  - `npm test` 全件パス（その時点で実測した正確なテスト数を `README.md` / `README.ja.md` へ記載すること）
  - `npm run verify`（`test` + `check:pwa` + `check:oauth` + `build` + `audit:responsive`）が 0 fail（`check:oauth` 0 違反、`check:pwa` 34/34 合格）
  - `npm run build:demo` が 0 exit で `apps/web/dist-demo/google-sites-embed.html` を生成し、自己チェック通過すること
  - `git grep -n -i -E "hajimenakagawa|tailfd8c6d|akapen"` 等の公開チェックで意図しない個人環境依存や旧仕様混入がないこと（`package.json` / `plugin.json` の公開先 GitHub URL と `migrate` の後方互換記述を除く）

---

## 5. 起票（この SPEC 作成時点では起票しない）

運用ルールに従い、仕様書確定フェーズでは自動起票しない。内容確認後、ユーザーが Spec Launchpad の **「File batches & start」** から `V10-B1`〜`V10-B5` を起票して自走を開始する。
