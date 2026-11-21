# SPEC: Hermes Pilot v2 (`SPEC-PILOT-V2`) — 監査結果・スニペット刷新・標準Web UI統合・意思決定コックピットUI仕様書

- **Status**: archived
- **アーカイブ日**: 2026-11-21（COH-4・全バッチ完了済み。以後は参照用に保持し、新規起票の対象外）

状態: **仕様確定（2026-11-14 監査 ＆ Q&A D11〜D15 合意済み）**
前提仕様: [SPEC-PUBLIC-PLUGIN.md](./SPEC-PUBLIC-PLUGIN.md)（Batch T1〜T6, T10 完走済み）
想定実装ランナー: **Hermes Agent / DeepSeek V4.1 Flash**（Batch P1〜P5 カンバン自走 ＋ 実機リモートデバッグ）

---

## 1. 現リポジトリの検証監査レポート（2026-11-14 実測）

### 1.1 合格・達成済み項目
- **自動検証スイート (`npm run verify`)**:
  - ユニットテスト: **353 件すべて合格（fail 0）**（`capabilities`, `repos`, `review`, `reviewWatcher`, `migrate`, `i18n`, `theme`, `qr`, `cli`, `dashboard-plugin` 含む）
  - PWA 検査 (`scripts/check-pwa.py`): **34 項目すべて合格**（Manifest `name: "Hermes Pilot"`, `short_name: "Pilot"`, アイコン安全域・不透明検査）
  - 本番ビルド (`vite build`): 成功（`index.js` + `TermPane.js` コード分割済み）
- **外部依存の排除**: `system-ops` / `git-ops` / `dsh-web` / `nanokvm` へのランタイム依存はゼロ。
- **QR ペアリング改善**: ワンタイム 8 文字コード（`pair-codes.js`）＋ PNG エンコーダ（`qrPng`）＋整数ピクセル Canvas 描画（`PairQr`）＋標準ダッシュボードプラグイン（`apps/dashboard/*`）が実装済み。

### 1.2 監査で特定した不具合・ギャップ（今回修正必須の 4 点）

| # | 箇所 (`file:line`) | 現象・原因 | 修正方針 | 状態（修正コミット） |
|---|---|---|---|---|
| **G1** | `apps/web/src/features/ChatPane.jsx:293-307`<br>`apps/web/src/features/TermPane.jsx:109-113`<br>`apps/web/src/i18n/lang.js:110`<br>`apps/web/src/i18n/index.js:55` | **英語表示にしてもチャット/端末スニペットが日本語のまま残る**<br>① `ChatPane` はタブ移動時もアンマウントされない（`.pane-host.is-hidden`）が、`loadSnippets` の `useEffect` 依存配列に `lang` が無いため、設定タブで `English` に切り替えても再取得されない。<br>② `lang.js` の初期値 `active` が `localStorage['hm.lang']` を同期読み込みしておらず、親 `I18nProvider` の `useEffect` より先に子 `ChatPane` の初回 `useEffect` が走る。 | ① `lang.js` 初期化時に `detectLang(readStoredPref())` で `active` を同期確定し、`I18nProvider` の `setPref` でも即座に `setActiveLang` と `hm:snippets` イベントを発火させる。<br>② `ChatPane` / `TermPane` / `SettingsPane` のスニペット取得 URL に `?lang=${lang}` を明示付与し、`useEffect` の依存配列に `lang` を入れる。 | ✅ **修正済み** `0967cf4`（P1）<br>P5 で実機相当（390x844 / 820x1180・EN/JA）に再検証: 設定で English に切り替え→リロード無しでチャット/端末のチップが英語化（`/api/snippets?lang=en` を実測） |
| **G2** | `apps/bridge/src/term-snippets.js:58,111`<br>`apps/bridge/src/server.js:905` | **端末スニペットに日本語 echo が残存 ＆ 設定画面から編集不可**<br>① `t-drain-clear` と `t-drain-state` のシェルコマンド内に `"drain marker を削除しました"` 等の日本語がハードコードされている。<br>② `GET /api/snippets/term` のみで `PUT` が無く、設定画面から追加・編集・Hot 切替ができない。 | ① シェル出力メッセージも言語別または英語標準に統一する。<br>② チャットと端末で共通の「組み込みオーバーライド（Hot/非表示）＋カスタム追加/編集/削除＋既定リセット」モデルを導入する。 | ✅ **修正済み** `0967cf4`（P1）<br>echo は英語標準（`drain marker removed`）に統一、`PUT /api/snippets/term` と設定画面の編集 UI を追加。P5 で端末チップの EN/JA 切替を再検証 |
| **G3** | `apps/dashboard/pilot_dashboard.py:44-46,148-151`<br>`apps/bridge/src/repos.js:93-120` | **標準 Web UI の `scanDirs` 設定がブリッジ側のリポジトリ検出に反映されない**<br>標準ダッシュボード（`pilot_dashboard.py`）は `scanDirs` を `config.json` に読み書きしているが、ブリッジ本体（`repos.js`）は `repos.json` の `scanDirs` を読んでいるため、標準 Web UI でスキャン先を変えても PWA 側に効かない。 | 標準 Web UI のバックエンド（`pilot_dashboard.py` / `plugin_api.py`）がブリッジの `/api/repos`・`/api/snippets`・`/api/snippets/term`・`/api/logs`・`/api/audit`（または `repos.json` / `snippets.json` / `term-snippets.json`）を直接読み書き・プロキシして完全同期する。 | ✅ **修正済み** `6ce14bd`（P4）<br>標準ダッシュボードのバックエンドがブリッジ API 優先・停止時は `repos.json` を tmp→rename（0600）で書き、`PUT /config` が `scanDirs` を両方へ同期。P4 実測: 保存後に `repos.json`・`config.json`・ブリッジ `GET /api/repos` が一致（equal=true） |
| **G4** | `apps/web/public/sw.js:5,33,54` | **Service Worker のキャッシュ名とオフライン文言が旧仕様のまま**<br>`CACHE = 'hermes-mobile-v12'`、503 応答が `'オフライン'` 固定になっている。 | `CACHE = 'hermes-pilot-v1'` に更新し、503 応答に `{ ok: false, code: 'OFFLINE', error: 'Offline' }` を返してフロント側の `t('err.OFFLINE')` で多言語表示する。 | ✅ **修正済み** `0967cf4`（P1）<br>実測: `apps/web/public/sw.js:6` が `const CACHE = 'hermes-pilot-v1'`、`:17` が 503 に `{ok:false,code:'OFFLINE',error:'Offline'}` を返す |

---

## 2. 決定表（インタビュー D11〜D15 合意事項）

| # | 論点 | 決定内容 |
|---|---|---|
| **D11** | チャット既定スニペットの再設計 | **Pilot 意思決定特化セット（Hot 6 個 ＋ シート 8 個、EN/JA 完全対応）** に刷新する。<br>Hot 6 個: ① `📋 Quick Review`（設問シート起票）、② `📸 Annotate Shot`（スクショ注釈起票）、③ `⚡ Approve & Go`（推奨案で承認・続行）、④ `🚀 Spec → Kanban`（SPEC からカンバン起票・自走）、⑤ `🔄 Alt Approach`（別アプローチ）、⑥ `📝 Summary`（要点まとめ）。 |
| **D12** | ターミナル既定スニペットの再設計 | **Pilot / Hermes 運用特化セット（Hot 6 個 ＋ 診断・運用シート 10 個、EN/JA 対応）** に刷新する。<br>Hot 6 個: ① `Restart Pilot`（ブリッジ再起動）、② `GW Status`（GW 状態）、③ `Restart GW`（GW 再起動）、④ `Clear Drain + GW`（ドレイン解除＋再起動）、⑤ `Kanban Active`（カンバン稼働一覧）、⑥ `Pilot & GW Logs`（直近ログ確認）。 |
| **D13** | スニペット編集モデルの統一（チャット＆端末共通） | **組み込み（Builtin）スニペットも Hot（バー表示）の ON/OFF 切替・非表示（Hidden）が可能**とし、さらに**ユーザー定義（Custom）スニペットの追加・編集・削除**（端末は長押し即実行 `run` の ON/OFF 含む）と **「既定に戻す（Reset to Defaults）」** をチャット・端末の両方で提供する。 |
| **D14** | Hermes 標準 Web UI（`apps/dashboard/*`）のフル統合 | 現在の「ペアリング QR・死活監視・サービス操作」に加え、標準 Web UI 上で **①リポジトリ管理（`repos.json` 完全同期・スキャン先・手動追加/非表示・ボード作成）、②チャット＆端末スニペット編集、③ブリッジ/GW ログ・監査ログ閲覧** をすべて完結できるようにする。 |
| **D15** | 「意思決定コックピット」UI/UX 強化（5 機能すべて導入） | ① Quick Review の **「⚡ 推奨案で一括承認（Accept All Recommended）」1 タップボタン＋連続決済プログレス表示（`1 / N`）**<br>② Annotation の **「Before（前回赤入れ/変更前）↔ After（最新スクショ）」ワンタップ比較トグル＋「✅ 検収 OK（Done）」ボタン**<br>③ チャットの **意思決定トリガーチップ強調表示**<br>④ **Spec Launchpad（`docs/SPEC-*.md` 自動検出 → カンバン一括起票・自走ランチャー）**<br>⑤ 上部ステータスバーの **コックピット計器盤化（判断待ちパルス・稼働ワーカー＆ツール・キャッシュ効率表示）** |

---

## 3. 詳細仕様：スニペット多言語修正・既定セット刷新・編集モデル統一（D11 / D12 / D13）

### 3.1 言語切替時の即時反映（G1 修正）

1. **`apps/web/src/i18n/lang.js`**:
   - モジュール初期化時に `localStorage.getItem(STORAGE_KEY)` を読み、`let active = detectLang(readStoredPref())` で初期言語を同期確定させる（初回マウント時の `en` / `ja` ズレを防止）。
   - `setLang(next)` 実行時に `window.dispatchEvent(new CustomEvent('hm:lang', { detail: { lang: active } }))` も発火する。
2. **`ChatPane.jsx` / `TermPane.jsx` / `SettingsPane.jsx`**:
   - `const { lang, t } = useI18n()` から `lang` を取得する。
   - `api(`/api/snippets?lang=${encodeURIComponent(lang)}`)` および `api(`/api/snippets/term?lang=${encodeURIComponent(lang)}`)` のようにクエリパラメータでも `lang` を明示指定し、`useEffect` の依存配列に `[lang]` を含める。

### 3.2 チャット既定スニペット（`apps/bridge/src/snippets.js`）（D11）

`BUILTIN` を以下の 14 個（Hot 6 個 ＋ シート 8 個）に刷新する。先頭 2 個（`quick-review`, `annotate-shot`）には `trigger: true` フラグを付与し、UI 上で意思決定トリガー用のアクセント枠（`.chip.trigger`）で描画する。

| ID | Hot | Trigger | English (`en.label` / `en.text`) | 日本語 (`ja.label` / `ja.text`) |
|---|---|---|---|---|
| `quick-review` | **Yes** | **Yes** | **📋 Quick Review**<br>`Summarize the open design decisions into a Quick Review sheet (HTML + JSON under review/sheets/) using the quick-review skill, file a blocked [review] task on kanban, and wait for my 1-tap answer.` | **📋 Quick Review起票**<br>`いま判断が必要な論点を quick-review スキルで設問シート（review/sheets/ の HTML + JSON）にまとめ、カンバンに blocked の [review] タスクとして起票して回答を待って。` |
| `annotate-shot` | **Yes** | **Yes** | **📸 Annotate Shot**<br>`Deploy the latest build, take a 390x844 screenshot into review/shots/, and file a blocked [review] mode=annotation task using the annotation skill so I can redline it.` | **📸 スクショ注釈起票**<br>`最新ビルドを反映して 390x844 の実機スクショを review/shots/ に撮り、annotation スキルで赤入れ用の blocked [review] タスクを起票して。` |
| `approve` | **Yes** | No | **⚡ Approve & Go**<br>`Approved with the recommended option. Proceed with implementation and run verification.` | **⚡ 推奨案で承認・続行**<br>`推奨案で承認します。このまま実装を進めて検証（verify）まで実行して。` |
| `spec-kanban` | **Yes** | No | **🚀 Spec → Kanban**<br>`Read the latest docs/SPEC-*.md in this repo, create the kanban batch tasks in order, and start autonomous execution from the first batch.` | **🚀 SPECから自走**<br>`このリポジトリの最新の docs/SPEC-*.md を読み、バッチ順にカンバンタスクを起票して最初のバッチから自走を開始して。` |
| `retry` | **Yes** | No | **🔄 Alt Approach**<br>`Stop repeating the last steps. Propose and execute a different approach to solve the root issue.` | **🔄 別アプローチ**<br>`同じ手順の繰り返しを止め、根本原因に対する別のアプローチでやり直して。` |
| `summary` | **Yes** | No | **📝 Summary**<br>`Summarize the decisions made, remaining open items, and next steps from this conversation in concise bullets.` | **📝 要点まとめ**<br>`ここまでの決定事項・未解決の論点・次の一手を簡潔な箇条書きで整理して。` |
| `git-diff` | No | No | **git diff**<br>`Run git diff in the working repo and summarize the key changes in 3 lines.` | **git diff**<br>`作業中のリポジトリで git diff を実行し、主要な変更点を3行で要約して。` |
| `git-status` | No | No | **git status**<br>`Run git status --short and list any uncommitted or untracked files.` | **git status**<br>`git status --short を実行して、未コミット・未追跡ファイルを一覧にして。` |
| `test` | No | No | **Run Verify**<br>`Run npm run verify (or the project test suite) and fix any failing tests.` | **テスト・検証**<br>`npm run verify（または関連テスト）を実行し、失敗があれば修正して。` |
| `review` | No | No | **Bug Review**<br>`Review the latest diff focusing on bugs and regressions. List by severity with file:line (do not edit yet).` | **バグ監査**<br>`直前の差分をバグ・デグレ優先で監査して。重大度順・file:line 付きで列挙し、まだコードは変えないで。` |
| `explain` | No | No | **Explain 3L**<br>`Explain the code or behavior we just touched in 3 lines for someone seeing it for the first time.` | **3行で説明**<br>`直前に触ったコードや挙動を、初見の人向けに3行で説明して。` |
| `cause` | No | No | **Diagnose**<br>`Identify the root cause of this error and propose the single safest fix.\nError: {{paste here}}` | **原因特定**<br>`次のエラーの根本原因を特定し、最も安全な修正案を1つ提案して。\nエラー: {{ここに貼り付け}}` |
| `handoff` | No | No | **Handoff**<br>`Write a compact handoff note (current state / decisions / next action) so a background worker can continue.` | **引き継ぎメモ**<br>`自律ワーカーがそのまま引き継げるよう、現状・決定事項・次の一手をコンパクトにまとめて。` |
| `kanban` | No | No | **Kanban Next**<br>`Check the running and blocked kanban tasks and tell me the single highest-priority item.` | **カンバン確認**<br>`カンバンの実行中・ブロック中タスクを確認し、最優先で片付けるべき1件を教えて。` |

### 3.3 ターミナル既定スニペット（`apps/bridge/src/term-snippets.js`）（D12）

| ID | Hot | Run | English (`label` / `note`) | 日本語 (`label` / `note`) | コマンド (`text`) |
|---|---|---|---|---|---|
| `t-pilot-restart` | **Yes** | **Yes** | **Restart Pilot** / Restart Hermes Pilot bridge (4097) | **Pilot再起動** / Hermes Pilot ブリッジ(4097)を再起動 | `<svc.restart>` |
| `t-gw-status` | **Yes** | **Yes** | **GW Status** / Hermes gateway status & PID | **GW状態** / gateway の稼働状況・PID | `hermes gateway status` |
| `t-gw-restart` | **Yes** | **Yes** | **Restart GW** / Restart Hermes gateway | **GW再起動** / gateway を再起動 | `hermes gateway restart` |
| `t-drain-restart` | **Yes** | **Yes** | **Clear Drain + GW** / Remove drain marker & restart GW | **解除+GW再起動** / ドレイン解除＋gateway再起動 | `rm -f ~/.hermes/.drain_request.json && hermes gateway restart` |
| `t-kanban` | **Yes** | **Yes** | **Kanban Active** / List kanban tasks | **カンバン一覧** / カンバンのタスク一覧 | `hermes kanban list` |
| `t-gw-log` | **Yes** | **Yes** | **GW Log** / Last 80 lines of gateway.log | **GWログ** / gateway.log の末尾80行 | `tail -n 80 ~/.hermes/logs/gateway.log` |
| `t-pilot-status` | No | **Yes** | **Pilot Status** / Service status of Hermes Pilot | **Pilot状態** / Hermes Pilot のサービス状態 | `<svc.status>` |
| `t-pair-qr` | No | **Yes** | **Pairing QR** / Show pairing URL & QR in terminal | **ペアリングQR** / ペアリングURLとQRを表示 | `npx hermes-pilot qr` |
| `t-verify` | No | **Yes** | **Run Verify** / Run tests, PWA check, and build | **Verify実行** / テスト・PWA検査・ビルドを一括実行 | `npm run verify` |
| `t-deploy` | No | **Yes** | **Deploy Web** / Zero-downtime build & swap dist | **Webデプロイ** / 無停止ビルド＆dist入れ替え | `npm run deploy` |
| `t-drain-clear` | No | **Yes** | **Clear Drain** / Remove drain marker only | **ドレイン解除** / ドレインマーカーのみ削除 | `rm -f ~/.hermes/.drain_request.json && echo "drain marker removed"` |
| `t-list` | No | **Yes** | **Services** / List Hermes background services | **サービス一覧** / hermes 系サービス一覧 | `<svc.list>` |
| `t-errors` | No | **Yes** | **Error Log** / Last 80 lines of errors.log | **エラーログ** / errors.log の末尾80行 | `tail -n 80 ~/.hermes/logs/errors.log` |
| `t-health` | No | **Yes** | **Reachability** / Check HTTP 200 on 9119 & 4097 | **疎通確認** / 9119 と 4097 の HTTP 応答確認 | `curl -s -o /dev/null -w "dashboard %{http_code}\n" http://127.0.0.1:9119/; curl -s -o /dev/null -w "pilot %{http_code}\n" http://127.0.0.1:4097/healthz` |
| `t-port` | No | **Yes** | **Ports** / Check listening processes on 9119 & 4097 | **ポート確認** / 9119 と 4097 の LISTEN 確認 | `lsof -nP -iTCP:9119 -sTCP:LISTEN; lsof -nP -iTCP:4097 -sTCP:LISTEN` |
| `t-git` | No | **Yes** | **Git State** / Short status & last 3 commits | **git状態** / 差分と直近3コミット | `git status --short && git log --oneline -3` |

### 3.4 統一スニペット保存・編集モデル（`snippets.json` / `term-snippets.json`）（D13）

1. **保存ファイル形式**:
   - チャット用: `~/.hermes/plugin-data/hermes-pilot/snippets.json`
   - 端末用: `~/.hermes/plugin-data/hermes-pilot/term-snippets.json`
   - JSON スキーマ（共通）:
     ```json
     {
       "version": 2,
       "overrides": {
         "git-diff": { "hot": true, "hidden": false },
         "retry": { "hot": false, "hidden": true }
       },
       "custom": [
         {
           "id": "c-1a2b",
           "label": "My Prompt",
           "text": "Run custom check",
           "hot": true,
           "run": true,
           "note": "Optional description"
         }
       ]
     }
     ```
   - 旧 `version: 1`（`{ version: 1, custom: [...] }`）は読み取り時に自動で `overrides: {}` を補完して後方互換を保つ。
2. **API 契約**:
   - `GET /api/snippets?lang=en|ja` → `{ snippets, allSnippets, overrides, custom, customMax: 16, hotLimit: 8, lang }`
     - `snippets`: チャット画面用（`hidden: true` を除いた一覧）。`allSnippets`: 設定画面用（`hidden: true` を含む全組み込み＋カスタム一覧）。
   - `PUT /api/snippets` → `{ custom?, overrides?, reset?: boolean }` を受け取り保存（`reset: true` なら `overrides: {}, custom: []` に初期化）。
   - `GET /api/snippets/term?lang=en|ja` → `{ snippets, allSnippets, overrides, custom, customMax: 16, hotLimit: 8, lang }`
   - `PUT /api/snippets/term` → `{ custom?, overrides?, reset?: boolean }` を受け取り保存し、監査ログ `term_snippets.save` に記録。
   - クライアント側は保存時に `window.dispatchEvent(new Event('hm:snippets'))` / `window.dispatchEvent(new Event('hm:term-snippets'))` を発火し、`ChatPane` / `TermPane` が即時再読込する。
3. **設定タブ UI（`SettingsPane.jsx`）**:
   - 「スニペット（Chat Snippets / Terminal Snippets）」セクションに `[Chat] [Terminal]` の切り替えタブを設ける。
   - **組み込み一覧**: 各行に `[Hot ピン留め切替]` と `[表示/非表示 (Eye/Hide)]` トグルを表示。
   - **マイスニペット（Custom）**: 追加フォーム（ラベル・本文/コマンド・Hot チェック・端末タブ時は「長押し実行を許可 (`run`)」チェック）＋既存カスタムのインライン編集・削除ボタン。
   - セクション右上に **「既定に戻す（Reset to Defaults）」** ボタンを配置。

---

## 4. 詳細仕様：Hermes 標準 Web UI（`apps/dashboard/*`）のフル統合（D14）

モバイル UI を求めて Hermes Pilot を導入するユーザーが、PC の標準 Hermes ダッシュボード（`:9119`）からもすべての設定・管理を完結できるようにする。

### 4.1 バックエンド拡張（`apps/dashboard/pilot_dashboard.py` & `plugin_api.py`）

1. **`scanDirs` の不整合修正（G3）**:
   - `PUT /api/plugins/hermes-pilot/config` で `scanDirs` が更新された際、`config.json` だけでなく `repos.json`（またはブリッジの `POST /api/repos`）にも `scanDirs` を同期書き込みする。
   - `GET /api/plugins/hermes-pilot/config` でも `repos.json` の `scanDirs` を正として返す。
2. **追加プロキシ/管理ルート（`plugin_api.py`）**:
   - **リポジトリ管理**:
     - `GET /repos` → ブリッジの `GET /api/repos` を呼び出し、`{ ok, repos, scanDirs }` を返す（ブリッジ停止時は Python 側で `repos.json` を直接読むフォールバック付き）。
     - `POST /repos` → `{ path, label?, scanDirs?, action?: 'add'|'hide'|'unhide'|'pin'|'unpin'|'createBoard', repoId? }` をブリッジの `/api/repos` 系 API（または `repos.json` アトミック更新）へ反映する。
   - **チャット＆端末スニペット管理**:
     - `GET /snippets?kind=chat|term&lang=en|ja` → ブリッジの `GET /api/snippets` または `GET /api/snippets/term` をプロキシ。
     - `PUT /snippets?kind=chat|term` → ブリッジの `PUT /api/snippets` または `PUT /api/snippets/term`（`{ custom, overrides, reset }`）をプロキシ。
   - **ログ・監査ログ閲覧**:
     - `GET /logs?file=gateway|errors|pilot&lines=120` → `~/.hermes/logs/<file>.log` および `audit.jsonl`（`file=audit`）の末尾を `redact()`（トークン秘匿フィルタ）に通して返す。

### 4.2 標準 Web UI フロントエンド拡張（`apps/dashboard/index.js` & `style.css`）

既存の「Status Bar」「Pairing QR」「Connection & Port Settings」「Service Control」に加え、以下の 3 カードを追加する（EN/JA 辞書対応）:

1. **Repositories Card（リポジトリ管理）**:
   - 検出済みリポジトリ一覧テーブル（ラベル、パス、検出元 `scan`/`board`/`session`/`custom`、対応カンバンボード有無、非表示トグル、カスタム削除ボタン、「＋ Create Board」ボタン）。
   - 個別リポジトリパス追加フォーム（`~/work/my-repo` → `Add`）。
2. **Snippets Card（Chat / Terminal スニペット管理）**:
   - `[Chat Snippets] [Terminal Commands]` タブ切替。
   - 組み込みスニペットの `Hot` / `Hidden` チェックボックス切替。
   - カスタムスニペットの追加・編集・削除・`Run on long-press` 切替・`Reset to Defaults` ボタン。
3. **Logs & Audit Card（ログ・監査ビューア）**:
   - `[Gateway Log] [Error Log] [Pilot Bridge Log] [Audit Trail]` チップ切替＋`Refresh` ボタン＋等幅スクロールビュー（トークンは自動マスク済み）。

---

## 5. 詳細仕様：「意思決定コックピット」UI/UX 5 大機能（D15）

### 5.1 【機能 ①】Quick Review「⚡ 推奨案で一括承認（Accept All Recommended）」＆連続決済プログレス（`1 / N`）

- **対象ファイル**: `apps/web/src/features/ReviewPane.jsx`, `apps/web/src/lib/reviewView.js`, `apps/web/src/styles.css`
- **仕様**:
  1. `reviewView.js` に純粋関数 `extractRecommendedAnswers(sheetData)` を追加する:
     - `sheetData.questions` の各設問 `q` について、`q.options.find(o => o.recommended)`（またはラベルに `推奨` / `Recommended` を含む選択肢）を探し、1 問以上推奨選択肢が存在する場合に `{ canFastTrack: true, summary: 'Q1:A · Q2:A · Q3:B', answers: [{ id: 'q1', choice: 'A', note: '' }, ...] }` を返す。
  2. `ReviewPane.jsx` で `waiting` 状態の Quick Review シートを開いているとき、`canFastTrack === true` ならシート最上部に **`⚡ 推奨案（Q1:A · Q2:A…）で一括承認して再開` / `⚡ Accept All Recommended (Q1:A · Q2:A…) & Resume`** ボタン（`.btn.fast-track`）を表示する。
  3. タップすると `haptic('success')` を鳴らし、推奨回答セットで `POST /api/review/:id/answer` を即時送信し、そのまま次の判断待ち（`nextWaiting`）へスライド遷移する。
  4. 判断待ちが複数件ある場合、シートヘッダーに **`1 / N Waiting`** ピルを表示し、最後の 1 件を送信し終えたら一覧画面に **`🎉 All Clear — 全件の判断が完了し、ワーカーが自走中です`** トースト/バナーを表示する。

### 5.2 【機能 ②】Annotation「Before ↔ After ワンタップ比較トグル」＆「✅ 検収 OK（Done）」

- **対象ファイル**: `apps/bridge/src/review.js`, `apps/web/src/features/ReviewPane.jsx`, `apps/web/src/features/AnnotationEditor.jsx`
- **仕様**:
  1. **比較対象画像の自動解決（`apps/bridge/src/review.js`）**:
     - タスクの `image` が `shots/<slug>-<round>.png`（`round >= 2`）または同名の `.before.png` が存在する場合、あるいは同一 `label` の前ラウンドタスクに `.annotated.png` / 元画像が存在する場合、`list()` および `GET /api/review/:id/image?compare=1` で比較用画像（Before 画像）を返す（存在有無はアイテムの `hasCompare: boolean` で通知）。
  2. **ワンタップ比較 UI（`AnnotationEditor.jsx` / `ReviewPane.jsx`）**:
     - `hasCompare === true` の場合、キャンバス上部に **`🔀 長押し/タップで比較: [After (最新)] ↔ [Before (前回赤入れ)]`** トグルピルを表示し、タップで下地画像を Before / After 切り替えできる。
  3. **赤入れ不要の 1 タップ検収完了（`POST /api/review/:id/approve`）**:
     - 修正後のスクショを見て問題なければ、赤入れを描かずに **`✅ 検収 OK（完了にする）` / `✅ Looks Good (Mark Done)`** ボタン 1 タップでカンバンタスクにコメント `"Visual check passed"` を残して `done`（または `unblock`）へ遷移させる。

### 5.3 【機能 ③】チャットからの意思決定トリガーチップ強調

- **対象ファイル**: `apps/web/src/features/ChatPane.jsx`, `apps/web/src/styles.css`
- **仕様**:
  - 3.2 節で定義した `trigger: true` のスニペット（`📋 Quick Review`, `📸 Annotate Shot`）をチャット入力欄上のスニペットバー先頭に固定表示し、ティール＋アンバーのグラデーション枠線（`.chip.trigger`）で通常のテキスト補助チップと視覚的に区別する。

### 5.4 【機能 ④】Spec Launchpad（`docs/SPEC-*.md` 自動検出 → カンバン一括起票・自走ランチャー）

- **対象ファイル**: 新規 `apps/bridge/src/specs.js`, `apps/bridge/src/server.js`, `apps/web/src/features/TasksPane.jsx`, `apps/web/src/features/ChatPane.jsx`
- **仕様**:
  1. **`apps/bridge/src/specs.js`**:
     - `listSpecs(repoPath)`: 指定リポジトリの `docs/SPEC*.md`（および直下の `SPEC*.md`）を走査し、タイトル（`# ...`）、更新日時（`mtime`）、および本文中のバッチ見出し（`### Batch <ID>: <Title>` または `### <ID>: <Title>`）を抽出して返す。
     - `launchSpec({ repoPath, board, specRelPath, batchIds, assignee })`:
       - 選択されたバッチごとにカンバンタスク（タイトル: `[<BatchID>] <BatchTitle>`, 本文: `Spec: <specRelPath>\nTarget: <repoPath>\n\n<バッチセクションの抜粋とVerify受入条件>`）を `hermes kanban create` で起票する。
       - 既に同一ボード上に同じ `[<BatchID>]` を含む未完了タスクが存在する場合は重複起票せずスキップする（冪等性保証）。
  2. **API エンドポイント**:
     - `GET /api/specs?repo=<repoId>` → `{ ok: true, repo, specs: [{ path, title, mtime, batches: [{ id, title, objective }] }] }`
     - `POST /api/specs/launch` → `{ ok: true, created: [...], skipped: [...] }`
  3. **UI（`TasksPane.jsx`）**:
     - 選択中のボードに紐づくリポジトリに `docs/SPEC-*.md` が存在する場合、タスク画面上部に **`🚀 Spec Launchpad: <SPEC名>（N バッチ）`** バーを表示し、タップでバッチ一覧シートを開いて **「選択したバッチをカンバンに一括起票して自走開始」** が 1 タップで行えるようにする。

### 5.5 【機能 ⑤】上部ステータスバーの「コックピット計器盤（Telemetry Strip）」化

- **対象ファイル**: `apps/web/src/App.jsx`, `apps/web/src/styles.css`
- **仕様**:
  - 上部 `.strip` を「パイロットが 1 秒で状況を把握してボトルネックへ飛べる計器盤」に進化させる:
    1. **GW ＆ 接続ステータスピル**: 正常時はコンパクトな緑ドット `● GW`、異常時のみ赤ラベル展開。
    2. **🔔 判断待ちピル（Human Bottleneck Gauge）**:
       - `reviewWaiting + inboxPending > 0` のとき、琥珀色のパルスアニメーション（`.pill-warn-pulse`）で `🔔 Review N` / `🔔 判断待ち N` を強調表示。
       - **タップすると現在どのタブにいても即座に `Review` タブ（または `Inbox` シート）の最初の判断待ちアイテムを開く**。
    3. **⚡ 自律稼働ピル（Autonomous Factory Gauge）**:
       - `liveCount > 0` または `tasksRunning > 0` のとき、ティール色の回転/パルスドット付きで `⚡ N Running · <直近ツール名>` を表示。タップで `LiveSheet` を開く。
    4. **💎 キャッシュ燃費ピル（Cache Telemetry Gauge）**:
       - `/api/usage` の集計（60 秒キャッシュ）からキャッシュヒット率（例: `💎 98%`）を 1 ピルで表示し、タップで `UsageSheet` を開く。

---

## 6. Hermes Agent 自走用カンバンタスク分割（Batch P1〜P5）

Hermes Agent（DeepSeek V4.1 Flash）は以下の **5 バッチ（P1 → P2 → P3 → P4 → P5）** を順番に実行し、各バッチ完了時に `npm run verify` と実機/ヘッドレス画面検証（`npm run deploy` 後）を行うこと。

---

### Batch P1: スニペット i18n バグ修正・既定スニペット刷新（Chat & Term）・統一カスタマイズモデル

- **目的**: 英語設定時にスニペットが日本語になるバグ（G1）と Service Worker の旧キャッシュ（G4）を修正し、Chat/Term の既定スニペットを Pilot 特化セット（3.2 / 3.3 節）へ刷新、さらに組み込みの Hot/Hidden 切替と端末スニペットのカスタム追加/編集/リセット（3.4 節）を実装する。
- **変更ファイル**:
  - `apps/web/src/i18n/lang.js`, `apps/web/src/i18n/index.js`, `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ja.json`
  - `apps/bridge/src/snippets.js`, `apps/bridge/src/term-snippets.js`, `apps/bridge/src/server.js`
  - `apps/web/src/features/ChatPane.jsx`, `apps/web/src/features/TermPane.jsx`, `apps/web/src/features/SettingsPane.jsx`
  - `apps/web/public/sw.js`
  - テスト: `apps/bridge/test/snippets.test.js`, `apps/bridge/test/term-snippets.test.js`, `apps/web/test/i18n.test.js`
- **受入条件（Verify）**:
  - 設定画面で `English` ↔ `日本語` を切り替えた際、リロードなしで即座にチャットスニペットと端末スニペットの表示言語が切り替わること。
  - チャット・端末の両スニペットについて、組み込みの Hot/Hidden 切替・カスタム追加/編集/削除・「既定に戻す（Reset）」が動作し永続化されること。
  - `npm run verify` が全件パスすること。

---

### Batch P2: Quick Review「⚡ 推奨案で一括承認」＆ Annotation「Before ↔ After 比較・1タップ検収」

- **目的**: 5.1 節（推奨案 1 タップ一括承認＋`1 / N` プログレス表示）と 5.2 節（Annotation の Before/After 画像比較トグル＋`POST /api/review/:id/approve` による 1 タップ検収完了）を実装する。
- **変更ファイル**:
  - `apps/bridge/src/review.js`, `apps/bridge/src/server.js`
  - `apps/web/src/lib/reviewView.js`, `apps/web/src/features/ReviewPane.jsx`, `apps/web/src/features/AnnotationEditor.jsx`, `apps/web/src/styles.css`
  - `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ja.json`
  - テスト: `apps/bridge/test/review.test.js`, `apps/web/test/reviewView.test.js`
- **受入条件（Verify）**:
  - 推奨選択肢（`recommended: true`）を持つ Quick Review シートで `⚡ Accept All Recommended` ボタンが表示され、1 タップで全問推奨値が送信・unblock されること。
  - 前ラウンドまたは `.before.png` / `.annotated.png` を持つ Annotation タスクで `Before ↔ After` 比較トグルと `✅ Looks Good`（1 タップ検収完了）が動作すること。
  - `npm run verify` が全件パスすること。

---

### Batch P3: Spec Launchpad（`docs/SPEC-*.md` 自動検出 → カンバン一括起票）＆ コックピット計器盤ヘッダー

- **目的**: 5.4 節（`GET /api/specs`, `POST /api/specs/launch` および `TasksPane.jsx` の Spec Launchpad UI）と 5.5 節（`App.jsx` のコックピット計器盤ステータスストリップ：判断待ちジャンプ・稼働ツールティッカー・キャッシュ率ピル）を実装する。
- **変更・新規ファイル**:
  - 新規: `apps/bridge/src/specs.js`, `apps/bridge/test/specs.test.js`
  - 変更: `apps/bridge/src/server.js`
  - 変更: `apps/web/src/App.jsx`, `apps/web/src/features/TasksPane.jsx`, `apps/web/src/styles.css`
  - 変更: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ja.json`
- **受入条件（Verify）**:
  - `GET /api/specs` がリポジトリ内の `docs/SPEC-*.md` とバッチ一覧（`Batch T1`〜、`Batch P1`〜 等）を正確に抽出し、`POST /api/specs/launch` が重複なしでカンバンタスクを起票できること（ユニットテストで検証）。
  - 上部ステータスバーの `🔔 Review N` ピルをタップすると即座に `Review` タブへ遷移し、`💎 XX%` ピルをタップすると `UsageSheet` が開くこと。
  - `npm run verify` が全件パスすること。

---

### Batch P4: Hermes 標準 Web UI（`apps/dashboard/*`）のフル設定・管理統合

- **目的**: 4.1 / 4.2 節に基づき、`scanDirs` の不整合（G3）を解消し、標準 Hermes ダッシュボードの「Hermes Pilot」タブ上で ①リポジトリ管理（`repos.json` 同期・追加・非表示・ボード作成）、②チャット＆端末スニペット編集、③ログ＆監査ログ閲覧を完結できるようにする。
- **変更ファイル**:
  - `apps/dashboard/pilot_dashboard.py`
  - `apps/dashboard/plugin_api.py`
  - `apps/dashboard/index.js`
  - `apps/dashboard/style.css`
  - テスト: `apps/bridge/test/dashboard-plugin.test.js`
- **受入条件（Verify）**:
  - 標準ダッシュボード側で変更した `scanDirs`・カスタムリポジトリ・チャット/端末スニペットが `~/.hermes/plugin-data/hermes-pilot/{repos.json,snippets.json,term-snippets.json}` にアトミック反映され、PWA 側と 100% 同期すること。
  - すべてのレスポンスが `redact()` を通り、256-bit トークンがブラウザへ一切漏洩しないことを `dashboard-plugin.test.js` で検証。
  - `hermes-pilot init --force` で `~/.hermes/plugins/hermes-pilot` のプラグインファイル群も最新に更新されること。

---

### Batch P5: 実機リモートデバッグ総合検証（390×844 / 820×1180・EN/JA・Dark/Light）＆ ドキュメント更新

- **目的**: `npm run deploy` 後に実機/リモートデバッグで全タブ・全言語・全テーマ・標準ダッシュボードの表示と操作を検証し、`README.md` / `README.ja.md` に新機能（Spec Launchpad、1-Tap Fast-Track、Before/After 比較、標準ダッシュボード連携）を記載する。
- **変更ファイル**:
  - `README.md`, `README.ja.md`
  - 視覚検証で発見した CSS 微調整（`apps/web/src/styles.css`, `apps/dashboard/style.css`）
- **受入条件（Verify）**:
  - `npm run verify` ＆ `npm run deploy` が成功すること。
  - `390×844`（スマホ）と `820×1180`（タブレット）で `en` / `ja` ともに `scrollWidth <= clientWidth`（横溢れゼロ）であり、チャットスニペットと端末スニペットが選択言語どおりに表示されていること。

#### P5 実測結果（2026-11-14 ヘッドレス実測）

- `npm run verify` → exit 0（**402 tests / fail 0**、check:pwa **34 項目 ok**、build ok）／ `npm run deploy` → 成功。
- **8 通りマトリクス**: 390x844・820x1180 × `en`/`ja` × `dark`/`light` で 5 タブ（タスク / レビュー / チャット / 端末 / 設定）を通しで開き、`documentElement.scrollWidth === clientWidth`（390/390・820/820、**横溢れ 0 件／40 計測**）。スクショは `review/shots/pilot-p5-202611140205-1..40.after.png`。
- **スニペットの言語追従**（G1）: 設定で `English` に切り替え→リロード無しでチャット `📋 Quick Review / 📸 Annotate Shot / …`・端末 `Restart Pilot / GW Status / …` に切替（`/api/snippets?lang=en`・`/api/snippets/term?lang=en` を実測）。`日本語` に戻すと即座に日本語へ復帰。
- **Before ↔ After 比較・1 タップ検収**: 注釈タスクを作成 → 比較トグルが `🔀 After (latest)` ⇄ `🔀 Before (previous red pen)` で切替（画像も切替）→ `✅ Looks Good` でタスクが `done`（`result: Visual check passed`）に遷移（実測 `t_5089807b`）。
- **Spec Launchpad**: リポジトリのあるボードで `🚀 Spec Launchpad … 5 batches` バーが出て、シートに P1〜P5 と起票済み表示。`POST /api/specs/launch` は既存の未完了バッチを `skipped: [{id: "P5", reason: "exists", taskId: "t_d0bca558"}]` として**重複起票しない**ことを実 API で確認。
- **計器盤ピル**: `💎 99%` タップで Usage シート（Cost $4.71 / Input 4.99M / Output 2.19M / Cache read 825.93M (99.4%) / API calls 3,475 / Sessions 20）が開く。`⚡ Running 2 · <tool>` は実行中ツール名がライブ更新。
- **直した不具合（P5）**: チャット/端末タブでトーストがスニペット帯と入力欄に重なり、押したい定型文が隠れていた（修正前の証拠: `pilot-p5-202611140156-13.after.png`）。`.toast.chat` / `.toast.term` の `bottom` を 108px 持ち上げ、修正後の実測はトースト下端 678px < スニペット帯上端 698px（重なり 0、`pilot-p5-202611140205-toast-fixed2.after.png`）。
