# ドッグフーディング結果 — `v0.2.0` ピン → `0.2.4`（カタログ SHA bump PR 前）

実施: 2026-11-23 / 対象: `hermes-mobile-pwa`（plugin `hermes-pilot`）
比較元: カタログ掲載ピン `5c82ba62`（v0.2.0、`plugin-catalog/hermes-pilot.yaml` が指す SHA）

カタログ規則 4 により SHA bump は「旧→新の差分の再レビュー」なので、審査側が実際に踏む経路を
**ユーザーと同じ手順で**通した。観点は 3 つ: ①素の環境で install できるか ②390×844 で全タブが使えるか
③英語設定で UI に CJK が混ざらないか。

---

## 1. サマリ

| # | 重要度 | 状態 | 症状 |
| :--- | :--- | :--- | :--- |
| 1 | **P0** | 修正済 `fc00590` | `hermes plugins install` が `plugin.json` の manifest 検証で失敗し、**カタログ掲載済みの版すら入らない** |
| 2 | P1 | 修正済 `4b118b1` / `d598be6` | README の install 手順が CLI 仕様と不一致（`--ref` にタグ、owner/repo は `--force` 必須）、`verify` が install 経路を検査していない |
| 3 | P1 | 修正済 `13e0632` | 遅延チャンクが空モジュールで返ると `TermPane` 参照で TypeError（自動復旧しない） |
| 4 | P2 | 修正済 `13e0632` | メモの既定表示が 2 列で、390px でも 1 列に落ちない（178px カード・4 行クランプ・タグ非表示） |
| 5 | P3 | 修正済 `13e0632` | レビュー作業フィードの時刻が絶対表記で、下の Done リスト（相対時刻）と不揃い |

確認して**問題が無かった**もの: i18n 辞書の ja/en キー一致（各 1230 件・差分 0）、EN 値に含まれる CJK は
`settings.languageJa`（=「日本語」）の 1 件のみ、6 タブ + 言語切替を通してコンソールエラー 0 件、
全タブで実データが描画された。

未検証: ターミナルへのキー入力（CDP の合成キーが xterm に届かず・手動確認が必要）、シートの回答送信と
注釈送信（副作用が出るため意図的に未実施）。

---

## 2. 詳細

### #1 P0 — カタログ掲載版が install できない（修正済）

- 再現: 新規 `HERMES_HOME` で `hermes plugins install hermes-pilot`（catalog 名・pin `5c82ba62`）→ exit 1
  `plugin.json declares an unsupported or missing Agent Plugins schema`。`hajimemanila/hermes-pilot --ref <sha>` でも同じ。
- 原因: `hermes_cli/agent_plugins.py:239` が `$schema` を必須化し、`author` も object を要求する。
  `hermes plugins validate .` はこの不整合を検出しない（caution のまま緑）ため、**CI が緑でもユーザーは入れられない**。
- 修正: `plugin.json` を Agent Plugins v1 準拠へ（`$schema` 追加・`author` object 化・独自キーを
  `extensions["hermes-pilot"]` へ退避）。読み手 `apps/bridge/test/releaseParity.test.js` も追随。
- 検証: 新規 `HERMES_HOME` で install → enable → `npm ci` → `init`（token 0600 / skills 3 件）→ bridge 起動 →
  `/api/capabilities` authed 200 / unauth 401 を実測。

### #2 P1 — install 手順と CI ゲート（修正済）

- 手順書の `--ref v0.2.4` は CLI が拒否する（`--ref must be a full 40-character commit SHA.`）。
  owner/repo 指定は「未レビューの community source」としてスキャンされ `Decision: BLOCKED`（`--force` で解除）。
- 修正: README / README.ja / OPERATIONS の主経路をカタログ名指定へ。SHA 指定は 40 桁固定と明記。
- `scripts/check-cold-install.mjs` を新設し `npm run verify` の末尾に追加（使い捨て `HERMES_HOME`、
  `hermes` CLI が無い環境では skip、所要 30 秒）。上記 #1 と同種の退行を CI で塞ぐ。

### #3 P1 — 遅延チャンクの空モジュールで TypeError（修正済）

- 証拠: `~/.hermes/plugin-data/hermes-pilot/client-errors.log`（13 行）に 2 件。
  `Cannot read properties of undefined (reading 'TermPane')` — `at Lazy / at Suspense`、`tab=term`、
  8444（Tailscale 配信）で 2026-11-21 に 2 回、別々の asset ハッシュで発生。
- 経路: `apps/web/src/App.jsx:44-45` の `retryImport(() => import('./features/TermPane.jsx')).then((m) => ({ default: m.TermPane }))`。
  `retryImport`（`lib/lazyRetry.js`）は「Failed to fetch dynamically imported module」等の**メッセージ一致**でしか
  chunk error を判定しないため、チャンクが空応答で成功扱いになると `m` が undefined のまま factory が TypeError を投げ、
  自動復旧（再読込 1 回）の対象外になる。
- 修正: `retryImport` に `expect`（解決したモジュールの検証）を足し、満たさない場合は
  `name = 'ChunkLoadError'` の例外にして再試行と単発読み直しの対象に寄せた。`App.jsx` は
  `expect: (m) => Boolean(m && m.TermPane)` を渡す。回帰テストは `apps/web/test/lazyRetry.test.js` に 3 件追加。

### #4 P2 — メモ既定 2 列が 390px でも効く（修正済）

- 既定は `DEFAULT_MEMOS_VIEW = 'two'`（`apps/web/src/lib/memoView.js`）。CSS は
  `styles/memos.css:377` の `.memos-grid.view-two { grid-template-columns: repeat(2, minmax(0, 1fr)) }` に
  画面幅の条件が無い。
- 390×844 実測: `gridTemplateColumns: 178px 178px`、カード高 220px 固定、本文 `-webkit-line-clamp: 4`、
  出典行とタグは非表示。EN では "Brainst…" / "Spec S…" とボタンも切れる。
- 修正: `styles/memos.css` に `@media (max-width: 430px)` を 1 箇所足し、1 列・高さ自動・clamp 5・
  出典とタグ表示へ戻した（決定 Q2=A/Q4=A は 431px 以上でそのまま）。
- 修正後の実測（390×844・再ビルド後）: `gridTemplateColumns: 366px`（1 列）/ カード高 231・131（固定 220 でない）/
  `.memo-tags` は `flex` で表示。

### #5 P3 — レビュー作業フィードの時刻表記（修正済）

- 上部の `.ak-feed`（`/api/review/feed` の作業フィード）は絶対時刻（`03:07 PM`）、下の Done リストは
  相対時刻（`Done · 19h ago`）。フィードには前日以前のイベントも残るため、時刻だけではいつの話か分からない。
- 修正: フィードの時刻を `relTime()` に統一。修正後の実測: `20 時間前 / 19 時間前 / 19 時間前`（Done リストと同書式）。

---

## 3. 再現手順

```bash
# ① install 経路（P0 の再発検知・約 30 秒）
cd ~/Projects/hermes-pilot && npm run check:cold-install

# ② 審査側の静的検査
hermes plugins validate .          # security scan が safe であること

# ③ 390×844 の実機確認（ブリッジを起動した状態で）
open "http://127.0.0.1:4097/?t=$(cat ~/.hermes/plugin-data/hermes-pilot/token)"
```

## 4. 手法メモ（次回に効く注意）

- `capture_screenshot()` は**同一パスを上書き**する。証拠を残すなら撮った直後に `shutil.copy` で退避する。
- 縮小表示のスクショで文言を判断しない。1 度「ラベルが欠けている」と誤読し、拡大したら正しい文字列だった
  （`review.addAnnotation` = 「🖊 スクショに赤入れして追加指示」）。
- カード内の要素を掴むときは `innerText` 一致で**最も内側**を選ぶ（外側の `div` は viewport 全体を返す）。
