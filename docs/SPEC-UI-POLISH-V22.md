# SPEC: UI 視認性・Worker ログ・Terminal チャンク復旧・メモリスト右端配置修正仕様書 (`SPEC-UI-POLISH-V22`)

- **状態**: 仕様確定（2026-11-19・実機スクショ 5 枚から 4 件の真因特定済み）
- **前提仕様**: [SPEC-ver-0-2-1.md](./SPEC-ver-0-2-1.md) / [SPEC-ROLE-DELEGATION-ROUTING.md](./SPEC-ROLE-DELEGATION-ROUTING.md)
- **対象リポジトリ**: `hermes-mobile-pwa`（プラグイン名: `hermes-pilot` / `Hermes Pilot`）
- **全バッチ共通の完了条件**:
  - `npm run verify`（`npm test` + `check:pwa` + `check:oauth` + `build` + `audit:responsive`）が 0 fail であること
  - `npm run deploy` および `npm run build:demo` + `demo/index.html` 同期が 0 exit であること
  - UI 変更バッチ（U1 / U2 / U4）は `390×844`・`820×1180` で実画面検証を行うこと

---

## 1. 課題一覧と真因（実機スクショ・ソース検証結果）

| ID | 事象 | ソース上の真因 |
| :--- | :--- | :--- |
| **I1** | **動作中カード内のボタン文字が黒字で読みにくい**（タスクタブ／チャットタブの `ArchitectJobBar`） | `apps/web/src/styles.css:5892-5905` で `.job-bar-btn` の基底が `background: var(--accent); color: var(--on-accent, #04191c);`（明背景＋暗文字）なのに対し、Dopamine ルール（`styles.css:4777-4784`）が `background: var(--vibe-btn-bg)`（暗背景）だけを上書きして `color` を上書きしていないため、暗背景に暗色文字が載っている。また `.job-bar.failed .job-bar-btn` の赤背景も Dopamine ルールで上書きされる恐れがある。 |
| **I2** | **Worker 実行ログの文字かぶり**（ツール名とログ本文が重なる） | `apps/web/src/styles.css:2972-2978` の `.ak-worker-row` が `grid-template-columns: 40px 62px 1fr` の固定幅 3 列で、`.ak-worker-tag` に `overflow: hidden` / `min-width: 0` が無いため、`kanban_comment`・`kanban_complete`・`execute_code` 等の長いツール名が 62px 列からはみ出し右隣の `.ak-worker-text` と重なっている。 |
| **I3** | **ターミナルタブで動的 import エラーが発生し再試行でも戻らない** | `apps/web/src/App.jsx:33` の `TermPane` のみが `React.lazy(() => import('./features/TermPane.jsx')...)` で遅延読込されている。スリープ・バックグラウンド滞在中に `npm run deploy` が複数回走って旧ハッシュチャンク（`/assets/TermPane-<hash>.js`）が消えた場合や、スリープ復帰直後の `<host>` 再接続待ち中にタブを開くと `Failed to fetch dynamically imported module` となる。さらに `React.lazy` は reject 済み Promise をキャッシュするため `ErrorBoundary` の「再試行」でも復帰できない。エラー画面のログ案内パス（`apps/web/src/i18n/{ja,en}.json:674`）も旧パス `~/.hermes/mobile-pwa/client-errors.log` のまま残っている。 |
| **I4** | **メモタブ・リスト表示で `⋯` ボタンが右端に配置されない** | `apps/web/src/features/MemosPane.jsx:508-535` で `.memo-more-btn`（`⋯`）が `.memo-card-head`（`styles.css:6676-6681` で `max-width: 46%`）の内側に入っているため、リスト表示（`.view-list`）で `[タイトル] [⋯] [本文]` の並びになり、本文なし（チェックリストのみ等）のカードでは左半分に `[タイトル] [⋯]` が寄って右半分が空白になり、タイトルも 46% で切れてしまう。 |

---

## 2. 合意決定表（D66〜D69）

| ID | 論点 | 採択方針 | 対象 |
| :--- | :--- | :--- | :--- |
| **D66** | `ArchitectJobBar` ボタンのコントラスト統一 | `html[data-vibe='dopamine'] .job-bar:not(.failed) .job-bar-btn:not(:disabled)` へ `color: var(--text);` を明示し、暗背景 `--vibe-btn-bg` 上で Dark/Light とも高コントラスト（WCAG AA 4.5:1 以上）を保つ。`.job-bar.failed .job-bar-btn` は Dopamine 時も赤系背景＋`color: #fff` を維持する。 | `apps/web/src/styles.css`, `apps/web/test/jobBarStyle.test.js` |
| **D67** | `WorkerFeed` ログの 2 段グリッド化 | `.ak-worker-row` を `grid-template-columns: 42px minmax(0, 1fr)` の 2 列・2 段構造（1 行目: 時刻＋ツール/agent ラベル、2 行目: 2 列目にログ本文 `grid-column: 2`）へ変更し、`.ak-worker-tag` に `min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`、`.ak-worker-text` に `min-width: 0; overflow-wrap: anywhere;` を付与して 390px 幅でも重なりゼロ＆長いツール名全文視認を両立する。 | `apps/web/src/styles.css` |
| **D68** | Terminal 遅延ロードの自動リトライ＆安全な単発リロード復旧 | `apps/web/src/lib/lazyRetry.js` を新設し、動的 import 失敗時に短時間リトライ（2 回・600ms/1500ms）→ チャンク喪失（stale deploy）なら `sessionStorage` ガード（30 秒クールダウンで無限ループ防止）付きで自動 1 回リロードする。`vite:preloadError` も同ガードで拾い、`ErrorBoundary` の「再試行」もチャンクエラー時は `location.reload()`、それ以外は `retryKey` 更新で新規 `React.lazy` 取得を行う。あわせて `app.tabErrorLog` を `~/.hermes/plugin-data/hermes-pilot/client-errors.log` に更新する。 | `apps/web/src/lib/lazyRetry.js`, `App.jsx`, `ja.json`, `en.json`, `apps/web/test/lazyRetry.test.js` |
| **D69** | メモリスト表示の `⋯` 右端固定＆本文なし時のタイトル拡張 | `MemosPane.jsx` で `.memo-more-btn` を `.memo-card-head` の外へ出し `<article>` の末尾直下に配置する（`showsListMenu(view)` ガードと単一配置を維持）。カードへ `has-body` クラスを付与し、本文あり時は `[タイトル(最大46%)] [本文(flex:1)] [⋯(右端)]`、本文なし（チェックリストのみ等）時は `[タイトル(flex:1・全幅)] [⋯(右端)]` とする（`44×44px` タップ領域維持）。 | `apps/web/src/features/MemosPane.jsx`, `styles.css`, `apps/web/test/memosListMenu.test.js` |

---

## 3. 詳細技術仕様

### 3.1 `ArchitectJobBar` ボタンの視認性修正（D66）

- `apps/web/src/styles.css:4777-4784` から `.job-bar-btn:not(:disabled)` を分離・明示化し、以下を定義する:
  - `html[data-vibe='dopamine'] .job-bar:not(.failed) .job-bar-btn:not(:disabled)`:
    `background: var(--vibe-btn-bg); color: var(--text); border-color: var(--vibe-border); box-shadow: inset 0 1px 0 var(--vibe-hi), 0 3px 0 var(--vibe-bevel);`
  - `html[data-vibe='dopamine'] .job-bar.failed .job-bar-btn:not(:disabled)`:
    `background: var(--danger-grad, var(--bad)); border-color: var(--bad); color: #fff; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.25), 0 3px 0 rgba(127, 29, 29, 0.65);`
- 隣接グループ内の `.seed-seg-btn:not(.on)`・`.receipt-btn:not(.primary)`・`.spec-banner-btn.ghost` に同様の暗文字継承・上書き漏れが無いか併せて点検する。
- 回帰テスト（`apps/web/test/jobBarStyle.test.js`）で Dopamine 時の `.job-bar-btn` に明示的な `color` 指定があることを固定する。

### 3.2 Worker 実行ログのレイアウト改善（D67）

- `apps/web/src/features/ReviewPane.jsx:191-196`（`TasksPane.jsx` も共有する `WorkerFeed`）の DOM 順序（`time`, `tag`, `text`）は変えず、`apps/web/src/styles.css:2972-2979` の `.ak-worker-row` を 2 列・2 段グリッドへ変更する:
  - `.ak-worker-row`: `display: grid; grid-template-columns: 42px minmax(0, 1fr); column-gap: 8px; row-gap: 2px; align-items: baseline; padding: 3px 0; border-bottom: 1px solid var(--line);`（`.ak-worker-row:last-child { border-bottom: none; }`）
  - `.ak-worker-time`: `grid-column: 1; grid-row: 1; font-variant-numeric: tabular-nums; white-space: nowrap;`
  - `.ak-worker-tag`: `grid-column: 2; grid-row: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600;`
  - `.ak-worker-text`: `grid-column: 2; grid-row: 2; min-width: 0; overflow-wrap: anywhere; word-break: break-word;`
- これにより `kanban_comment`・`kanban_complete`・`execute_code` 等の長いツール名でも重なりゼロで全文視認でき、狭幅（390px）でも横溢れを起こさない。

### 3.3 Terminal 動的 import 復旧機構 & エラーログパス更新（D68）

1. **新規 `apps/web/src/lib/lazyRetry.js`**:
   - `isChunkLoadError(err)`: `Failed to fetch dynamically imported module` / `Importing a module script failed` / `ChunkLoadError` / `Loading chunk` / `error loading dynamically imported module` を判定する純関数。
   - `canAutoReload(storage, nowMs, cooldownMs = 30_000)` / `markAutoReload(storage, nowMs)`: `sessionStorage` キー `'hm.chunkReloadAt'` を使い、30 秒以内の連続リロードを防止する純関数。
   - `importWithRetry(importer, { retries = 2, delays = [600, 1500], sleep, storage, reload, now })`: スリープ復帰直後の通信瞬断を 2 回まで短時間リトライし、それでも `isChunkLoadError` なら `canAutoReload` を確認して `markAutoReload` ＋ `reload()` を 1 回だけ実行して未解決のまま待機（クールダウン中のみ上位 `ErrorBoundary` へエラーを送出）。
2. **`apps/web/src/App.jsx`**:
   - `TermPane` の読込を `importWithRetry` 経由にし、`termRetryKey` state に応じて `lazy(...)` を再生成できるようにする（`React.lazy` による reject 済み Promise キャッシュ固着を解消）。
   - `ErrorBoundary` の `onRetry` で `isChunkLoadError(this.state.error)` 時は `window.location.reload()` を呼び、それ以外のエラーは親の `onReset`（`termRetryKey` インクリメント）で再マウントする。
   - `useEffect` で `window.addEventListener('vite:preloadError', ...)` を購読し、同 `canAutoReload` ガード付きで安全リロードする。
3. **i18n ログパス修正（`apps/web/src/i18n/{ja,en}.json:674`）**:
   - `app.tabErrorLog` の `~/.hermes/mobile-pwa/client-errors.log` を `~/.hermes/plugin-data/hermes-pilot/client-errors.log` へ修正する。
4. **単体テスト（`apps/web/test/lazyRetry.test.js`）**:
   - `isChunkLoadError`、リトライ成功、リトライ枯渇時の 1 回リロード、30 秒クールダウンによる無限ループ抑止を検証する。

### 3.4 メモタブ・リスト表示の `⋯` 右端配置＆タイトル幅最適化（D69）

- `apps/web/src/features/MemosPane.jsx:503-536`:
  - `<article>` の `className` に `${m.body ? ' has-body' : ''}` を付与する。
  - `{showsListMenu(view) ? (<button type="button" className="memo-more-btn" ...>⋯</button>) : null}` を `.memo-card-head` の外へ出し、カード内の最末尾（`</article>` 直前）へ移動する（`showsListMenu(view)` ガードおよびファイル内 `memo-more-btn` 1 箇所制約を維持）。
- `apps/web/src/styles.css:6669-6724`:
  - `.view-list .memo-card-head`: `flex: 1 1 auto; min-width: 0; max-width: none; align-items: center;`
  - `.view-list .memo-card.has-body .memo-card-head`: `flex: 0 1 auto; max-width: 46%;`
  - `.view-list .memo-card-body`: `display: block; flex: 1 1 auto; min-width: 0; -webkit-line-clamp: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`
  - `.memo-more-btn`: `flex: none; margin: -10px -6px -10px auto;`（`width: 44px; height: 44px;` を維持し、本文有無に関わらず右端固定）。
- `apps/web/test/memosListMenu.test.js` に、`.memo-more-btn` が `.memo-card-head` の外（`.memo-card-body` の後）に配置され、右端寄せスタイルを持つ回帰テストを追加する。

---

## 4. カンバンタスク分割（Batch U1 〜 Batch U4）

### Batch U1: 動作中カード（ArchitectJobBar）ボタン文字の視認性・コントラスト修正

- **Execution Mode**: `[Mode: Visual Gate]`
- **Recommended Role**: `role:builder`
- **目的**: Dopamine モード時の `.job-bar-btn` が暗背景（`--vibe-btn-bg`）に暗文字（`--on-accent`）となって読めない不具合と `.job-bar.failed .job-bar-btn` の上書きリスクを修正し、Dark/Light × Dopamine/Serotonin 全組合せで高コントラストを保証する。
- **変更・新規ファイル**:
  - 変更: `apps/web/src/styles.css`
  - 新規: `apps/web/test/jobBarStyle.test.js`
- **受入条件（Verify）**:
  - Dopamine モードの `.job-bar:not(.failed) .job-bar-btn:not(:disabled)` に明示的な `color: var(--text)` が設定され、`.job-bar.failed .job-bar-btn` は赤背景＋白文字を維持すること。
  - 隣接コントロール（`.seed-seg-btn:not(.on)` / `.receipt-btn:not(.primary)` / `.spec-banner-btn.ghost`）に同種の文字色漏れが無いこと。
  - `npm run deploy` 後、`390×844` / `820×1180` のタスクタブおよびチャットタブで `ArchitectJobBar` 内ボタンの文字視認性を確認すること。
  - `npm run verify` が全件パスすること。

### Batch U2: Worker 実行ログ（.ak-worker-row）の文字重なり解消・レイアウト改善

- **Execution Mode**: `[Mode: Visual Gate]`
- **Recommended Role**: `role:builder`
- **目的**: `.ak-worker-row` の固定 62px ツール名列による文字はみ出し・本文との重なりを解消し、2 列 2 段グリッド（1 行目: 時刻＋ツール名、2 行目: ログ本文）で狭幅モバイルでも読みやすく整形する。
- **変更・新規ファイル**:
  - 変更: `apps/web/src/styles.css`
- **受入条件（Verify）**:
  - `.ak-worker-row` が `grid-template-columns: 42px minmax(0, 1fr)` で 2 段整列し、`kanban_comment`・`kanban_complete`・`execute_code` 等の長いツール名でも `.ak-worker-text` と重ならないこと。
  - `npm run deploy` 後、`390×844` のタスク詳細（`WorkerFeed`）で実画面確認し、重なり・横溢れが無いこと。
  - `npm run verify` が全件パスすること。

### Batch U3: ターミナルタブの動的 import 失敗自動復旧＆ログ案内パス修正

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: スリープ復帰や再デプロイ後に発生する `TermPane-<hash>.js` 動的 import エラーを自動リトライ＋30 秒クールダウン付き単発リロードで復旧させ、「再試行」ボタンが reject 済み `React.lazy` で固まらないようにするとともに、旧エラーログパス表記を現行パスへ更新する。
- **変更・新規ファイル**:
  - 新規: `apps/web/src/lib/lazyRetry.js`
  - 新規: `apps/web/test/lazyRetry.test.js`
  - 変更: `apps/web/src/App.jsx`
  - 変更: `apps/web/src/i18n/ja.json`
  - 変更: `apps/web/src/i18n/en.json`
- **受入条件（Verify）**:
  - `apps/web/test/lazyRetry.test.js` で `isChunkLoadError`・瞬断リトライ成功・チャンク喪失時の単発リロード・30 秒クールダウンによる無限ループ防止がすべてパスすること。
  - `App.jsx` で `vite:preloadError` 監視と `ErrorBoundary` 再試行時の復旧（チャンクエラーは `reload`、一般エラーは `retryKey` 更新）が組み込まれていること。
  - `ja.json` / `en.json` の `app.tabErrorLog` が `~/.hermes/plugin-data/hermes-pilot/client-errors.log` になっていること。
  - `npm run verify` が全件パスすること。

### Batch U4: メモタブ・リスト表示の三点メニュー右端固定＆タイトル幅最適化・総合検証

- **Execution Mode**: `[Mode: Visual Gate]`
- **Recommended Role**: `role:builder`
- **目的**: メモタブのリスト表示（`view-list`）で `⋯` メニューボタンを `.memo-card-head` の外（カード末尾・右端）へ移動し、本文あり時は `[タイトル] [本文] [⋯]`、本文なし（チェックリストのみ等）時は `[タイトル全幅] [⋯]` に整え、全 4 件の最終ビルド＆デモ同期を完了する。
- **変更・新規ファイル**:
  - 変更: `apps/web/src/features/MemosPane.jsx`
  - 変更: `apps/web/src/styles.css`
  - 変更: `apps/web/test/memosListMenu.test.js`
  - 同期: `demo/index.html`
- **受入条件（Verify）**:
  - `MemosPane.jsx` で `.memo-more-btn` が `.memo-card-body` の後（カード直下末尾）に配置され、リスト表示で本文あり・本文なしの両ケースとも `⋯` が右端に揃い `44×44px` タップ領域を維持すること。
  - `apps/web/test/memosListMenu.test.js` の既存テストおよび追加回帰テストが全件パスすること。
  - `npm run verify`・`npm run deploy`・`npm run build:demo` + `demo/index.html` 同期がすべて 0 exit であり、`390×844` / `820×1180` の視覚検証で 4 件すべて解消されていること。
