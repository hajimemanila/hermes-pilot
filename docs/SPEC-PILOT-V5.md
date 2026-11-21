# SPEC: Hermes Pilot v5 (`SPEC-PILOT-V5`) — A2Bパイプライン統合・Dopamine/Serotonin UX・ゼロタイピング操縦 ＆ PC/スマホ対応ライブデモ仕様書

- **Status**: archived
- **アーカイブ日**: 2026-11-21（COH-4・全バッチ完了済み。以後は参照用に保持し、新規起票の対象外）

状態: **仕様確定（2026-11-15 インタビュー D23〜D27 合意済み）**
前提仕様: [SPEC-PILOT-V4.md](./SPEC-PILOT-V4.md)（Batch V4-1 〜 V4-4 / `47523c8` 完走済み）
想定実装ランナー: **Hermes Agent / DeepSeek V4.1 Flash**（Batch V5-1 〜 V5-6 カンバン自走 ＋ 実機相当検証）

> **注意（プロジェクト制約）**:
> - `apps/web/src/` 配下では `apps/web/test/noHardcodedJapanese.test.js` により JSX/JS への生日本語リテラル記述が禁止されている。UI 文言は必ず `apps/web/src/i18n/en.json`・`ja.json` に定義し `t(...)` 経由で参照すること。
> - 一方、`apps/dashboard/index.js`（標準 Hermes ダッシュボード用プラグイン）はバンドラ無しの単一 IIFE 構成であり、同ファイル内の `STRINGS.en` / `STRINGS.ja` オブジェクトに文言を保持する。
> - `apps/bridge/src/specs.js`（Spec Launchpad）がカンバンバッチとして誤認しないよう、バッチ以外の `###` 見出しは必ず数字で始めること（バッチ見出しのみ `### Batch V5-x:`）。
> - **用語の統一ルール**: 既存 UI（`en.json` / `ja.json`）に合わせ、ゲーム的な過剰表現（「出撃」「戦果」など）は UI 文言に使わない。通常表現は **「一括起票」「バッチを起票して自走開始」「実行サマリ」「完了レシート」** 等で統一し、Dopamine モードの爽快感はパーティクル・多段バイブ・Web Audio 効果音・SSR ホログラムデザインで表現する。

---

## 1. コンセプトとV4からの進化点

`SPEC-PILOT-V1 〜 V4` によって「モバイルからの1タップ意思決定（Quick Review / Annotation）」「SPEC からのバッチ一括起票（Spec Launchpad）」「ドロワー未読解消・即時同期」「パイプライン完走時統合 Markdown レポート」の実用基盤が完成した。

`SPEC-PILOT-V5` はこの V4 基盤の上に、**Architect（仕様策定）から Builder（カンバン自走実装・実機検証）までを途切れなく繋ぐ「A2B Pipeline（Architect-to-Builder Pipeline）」** と **ゼロタイピング操縦 UX**、そして **「触って気持ちいい」報酬演出（Dopamine ⇄ Serotonin）＆ PC/スマホ対応の静的ライブデモ** を完成させる。

1. **Vibe Mode 切替：`Dopamine（フル・ドパガキ仕様）` ⇄ `Serotonin（現V4標準＋基本触覚維持）`**
   - **Dopamine モード（初回既定 / OS の `prefers-reduced-motion: reduce` 時は自動で `Serotonin`）**: 1タップ承認・赤入れ送信・バッチ一括起票・完走カード展開時に、画面パーティクルバースト・ゴールド＆ティール発光・連続操作コンボ（`🔥 2x Combo`）・全件消化祝い（`🎉 All Clear!`）・Web Audio 合成効果音（iOS Safari でも鳴る音設定トグル付き）・ヘッダ節約額ティッカー・SSR ホログラム風 **完了レシートカード** を発動させる。
   - **Serotonin モード**: **現 V4 の落ち着いた UI/UX とボタン押下時の標準ハプティック（`haptic('tap' | 'action' | 'success')`）はそのまま維持**し、過剰なパーティクル・コンボ・発光・効果音だけを無効化した静謐でプロフェッショナルなモード。

2. **三段構えの「ゼロ外部依存」A2B パイプライン基盤**
   - 公開プラグインとして「インストールしただけで 100% 自走する」自己完結性を厳守する:
     - 第1段: `skills/spec-architect/SKILL.md` を標準同梱し、`hermes-pilot init` で `~/.hermes/skills/` へ自動配置。
     - 第2段: `apps/bridge/src/specs.js` が各バッチの `- **Execution Mode**: [Mode: Zero-Stop | Fast-Track Review | Visual Gate]` を解析し、カンバン起票時に行動契約ブロック `[Hermes Pilot Execution Contract]` を自動注入（`SOUL.md` 未編集でも自走完走を保証）。
     - 第3段: さらに最適化したいユーザー向けに、設定タブおよび標準 Web UI（`apps/dashboard`）から 1 タップで `~/.hermes/SOUL.md` 冪等追記・バックアップ作成および Antigravity / Hermes 用スキル配置を行える **`POST /api/pipeline/optimize`** を提供。

3. **A2B ハンドオフ（`Hermes Native` ＆ Opt-in `agy` 両対応 Architect → ハイブリッド自動/1タップ起票）**
   - **`🎙️ Spec Seed`**: チャット欄と仕様ランチャーから音声ディクテーション / 1行メモで仕様策定インタビューを開始（既定は `Hermes Native`、設定で公式ローカル `agy` CLI へ Opt-in 切替可 — トークン盗み出しや非公式プロキシは一切禁止）。
   - **ハイブリッド A2B 接続（D23）**: Quick Review で設計方針を 1タップ承認 → `docs/SPEC-<SLUG>.md` が生成された瞬間、Chat タイムラインおよび Tasks 画面へ **「🚀 仕様書の準備が完了しました — N バッチを起票して自走開始」** バナーを即時表示する（`Spec Seed` 起票シートのチェックボックス **「承認後に自動でバッチを起票して開始」** を ON にした場合は確認タップすら不要で即カンバン起票へ接続）。

4. **ゼロタイピング入力の徹底（`🎙️ Spec Seed` ＆ Annotation `🏷️ 1-Tap Stamps`）**
   - Annotation キャンバスに6種の1タップ指示スタンプ（`💥 Overlap / 重なり`、`📏 Spacing / 余白`、`✂️ Overflow / 文字切れ`、`🎨 Contrast / 視認性`、`🔼 Shift Up / 上へ`、`🗑️ Remove / 削除`）を追加し、スマホのソフトウェアキーボードを開かずに的確な視覚修正指示を送れるようにする。

5. **完了レシート（`🏆 Completion Receipt Card`）＆ PC対応インタラクティブライブデモ（`npm run build:demo`）**
   - V4 で実装済みの「パイプライン完走統合レポート（`pipeline-watcher.js` / `ChatPane` / `TasksPane`）」および `UsageSheet` と連動し、「人間の入力文字数 / タップ数 / コスト / キャッシュ率 / 推定節約額 / 合格テスト数」を可視化する **実行サマリ＆完了レシートカード（Canvas 1200×630 PNG 保存 ＆ X投稿テキストコピー）** を実装。
   - **Interactive Demo Mode (`npm run build:demo`)**: GitHub Pages 等に配置でき、スマホ直接アクセスはもちろん、**PC ブラウザ（>= 960px）からアクセスした際も `📱 Phone (390×844)` / `📟 Tablet (820×1180 2ペイン)` / `🖥️ Full` のデバイスシミュレータ筐体と Vibe・効果音・EN/JA・Dark/Light 切替バー** を備えた 4 ステップ A2B 体験ツアーを提供する。

---

## 2. 合意決定表（インタビュー D23〜D27）

| # | 論点 | 決定内容 | 根拠・背景 |
|---|---|---|---|
| **D23** | A2B Pipeline（Architect → Builder）接続方式とUI用語 | **ハイブリッド方式（1タップ一括起票カード即時表示 ＋ Seed 時の任意「承認後自動起票」チェック）**。<br>また、UI上の用語は「出撃」「戦果」のような幼いゲーム表現を避け、V4既存の「**バッチを起票して自走開始 / 一括起票**」「**仕様ランチャー**」「**実行サマリ / 完了レシート**」等、一般的かつ端正な語彙へ統一する。 | 初見の自動暴走を防ぎつつ最短1タップ（任意チェックで完全自動）で Architect から Builder へ繋ぎ、一般公開ツールとして違和感のない語調を保つため。 |
| **D24** | Vibe Mode（`Dopamine` ⇄ `Serotonin`）の差別化と触覚維持 | **`Dopamine`（フル・ドパガキ仕様）と `Serotonin`（V4標準UI＋基本ハプティック維持）の2モード制**。<br>・`Serotonin` でも `haptic('tap' / 'action' / 'success')` によるボタン押下の物理感は必ず残す（`hm.haptic` 設定に従う）。<br>・`Dopamine` ではパーティクルバースト・発光・`🔥 Nx Combo`・`🎉 All Clear!`・**Web Audio API 合成効果音（`hm.sound` トグル付き、iOS対応）**・キャッシュ節約ティッカー・SSR ホログラム風レシートカードを有効化する。 | iOS では `navigator.vibrate` が効かないため、Web Audio 合成音＋視覚バーストが特に効果的。一方日常運用用の `Serotonin` でも操作時の触覚フィードバックを失わないため。 |
| **D25** | 三段構えのゼロ依存パイプライン最適化 ＆ Architect エンジン | ① `skills/spec-architect/SKILL.md` 同梱（`init` 自動配置）＋② `specs.js` による `[Mode: ...]` 行動契約インジェクト＋③ `POST /api/pipeline/optimize`（1タップ `SOUL.md` 冪等更新＆スキル配置）。<br>Architect エンジンは既定 `Hermes Native`、設定から `agy` CLI を Opt-in 切替（公式サブプロセス起動のみ、OAuth/トークン直接読み出し厳禁）。 | 公開プラグインとしての単体完動性と ToS 完全準拠、既存環境への非破壊導入を両立するため。 |
| **D26** | ゼロタイピング入力 ＆ V4統合レポート連動レシート | ① `ChatPane` / `TasksPane` の **`🎙️ Spec Seed`**（音声/1行起票＋自動起票チェック）。<br>② `AnnotationEditor` の **`🏷️ 1-Tap Redline Stamps`**（6種）。<br>③ V4 のパイプライン完了レポートカード（Chat / Tasks）および `UsageSheet` から 1タップで開ける **`🏆 Completion Receipt Card`**（`GET /api/telemetry/receipt`、1200×630 PNG生成＆X投稿コピー）。 | V4 で構築済みの統合レポート導線に自然に組み込み、別画面へ迷わせず到達させるため。 |
| **D27** | PC ブラウザ対応「Interactive Demo Mode」の体験構成 | **`npm run build:demo`（`VITE_DEMO_MODE=1`）で単一静的アプリ（`apps/web/dist-demo`）を生成**。<br>・**PC 筐体シミュレータ（`DemoStage`）**: デスクトップ幅では上部コントロールバーから `📱 Phone (390×844)` / `📟 Tablet (820×1180)` / `🖥️ Full` と `Dopamine ⇄ Serotonin` / `🔊 音` / `🌙 Dark ⇄ Light` / `EN ⇄ JA` を即時切替可能。<br>・**A2B 4ステップ体験ツアー**: Step 1（Spec Interview 1タップ承認）→ Step 2（新SPEC生成 → 一括起票＆自走進捗）→ Step 3（Annotation 赤入れスタンプ / Before-After比較＆検収）→ Step 4（統合完了サマリ＆完了レシートカード表示）。 | スマホ実機を持っていない段階で PC からレビュー・試用する開発者にも、モバイル/タブレット2ペイン両方の操作感を即体験してもらうため。 |

---

## 3. 詳細技術仕様

### 3.1 Vibe Mode（`Dopamine` ⇄ `Serotonin`）＆ 効果音・触覚エンジン（D24）

対象: `apps/web/src/lib/vibe.js`（新規）, `apps/web/src/lib/soundFx.js`（新規）, `apps/web/test/vibe.test.js`（新規）, `apps/web/src/components/FxLayer.jsx`（新規）, `apps/web/src/App.jsx`, `apps/web/src/features/ReviewPane.jsx`, `apps/web/src/features/TasksPane.jsx`, `apps/web/src/features/SettingsPane.jsx`, `apps/web/src/styles.css`, `apps/web/src/i18n/{en,ja}.json`

1. **状態管理（`apps/web/src/lib/vibe.js`）**:
   - 保存キー: `hm.vibe`（`'dopamine' | 'serotonin'`）。
   - `getVibe(storage, matchMedia)`:
     - 保存値が `'dopamine'` / `'serotonin'` ならそれを返す。
     - 未保存時、`window.matchMedia?.('(prefers-reduced-motion: reduce)').matches` が `true` なら `'serotonin'`、それ以外は **`'dopamine'`** を返す。
   - `setVibe(mode, storage, doc)`:
     - `'dopamine' | 'serotonin'` を正規化し、`localStorage` に保存、`document.documentElement.dataset.vibe = next` を即時設定し、`window.dispatchEvent(new CustomEvent('hm:vibe', { detail: { vibe: next } }))` を通知する。
   - **連続操作コンボ追跡（`ComboTracker` / 純関数 `nextComboState`）**:
     - `Dopamine` 時に `quick-review` 承認・`annotation` 承認・`specs.launch` 等を **20秒以内** に連続実行すると `combo` カウンタが `1 -> 2 -> 3 ...` と上昇する。`Serotonin` 時やタイムアウト時は `0` 扱い。

2. **ハプティック維持 ＋ 多段触覚 ＆ Web Audio 合成効果音（`apps/web/src/lib/soundFx.js` + `vibe.js`）**:
   - **重要方針**: 既存の `apps/web/src/lib/haptic.js` の基本動作（`tap`, `action`, `success`, `error`）は **`Serotonin` モードでも常にそのまま動作**させる（ユーザーが設定で `hm.haptic` を OFF にした場合のみ停止）。
   - `celebrateAction(kind, { vibe, hapticFn, soundFn })`:
     - `'serotonin'` の場合: 既存の `hapticFn('success')`（または `'tap'`）のみを呼び、パーティクルや効果音は一切鳴らさない。
     - `'dopamine'` の場合:
       1. 多段ハプティック（例: `allClear` / `receipt` は `[10, 30, 16, 30, 40]`、`fastTrack` / `stamp` / `launch` は `'success'` 振動）。
       2. 視覚パーティクルイベント `window.dispatchEvent(new CustomEvent('hm:fx-burst', { detail: { kind, combo, x, y } }))` を発火（`FxLayer.jsx` が軽量な CSS/SVG コンフェッティを最大 18 粒、450ms〜750ms で非同期描画して即破棄。レイアウト再計算や操作ブロックを起こさない `pointer-events: none; position: fixed; z-index: 9999` 構成）。
       3. `isSoundEnabled()` が有効なとき、`soundFx.js` が **Web Audio API（`AudioContext` / 外部ファイルゼロ）** で短いシンセ効果音を鳴らす:
          - `'approve'` / `'stamp'`: 上昇系デュアルサイン/トライアングルクリック（~80ms、心地よい 523Hz → 784Hz）。
          - `'combo'`: ピッチ上昇アルペジオ（コンボ数に応じ +2 半音シフト）。
          - `'allClear'` / `'receipt'`: 和音ファンファーレ（C5-E5-G5-C6 の軽いシンセパッド、~240ms、音量 `<= 0.14` で耳障りにしない）。
          - 保存キー `hm.sound`（既定 `'1'` = Dopamine 時 ON、`0` でミュート）。Autoplay 制限のあるブラウザでも、ユーザー操作ハンドラ内で `ctx.resume()` するだけで安全に動作（`AudioContext` 非対応環境は no-op）。

3. **Dopamine UI の追加装飾（`styles.css` ＋ 計器盤 / Review / Tasks）**:
   - **`html[data-vibe="serotonin"]`**: 現 V4 と完全同等のフラット・プロフェッショナル外観（`.fx-burst` 非表示、コンボピル非表示、節約額サブリッチテキスト非表示、パルス系アニメーション抑止）。
   - **`html[data-vibe="dopamine"]`**:
     - `ReviewPane`: `⚡ Accept All Recommended` にアンバー＆ティールの微細パルス発光、上部/完了時に `🔥 {n}x COMBO` ピルおよび全件消化時の **`🎉 All Clear!`** フラッシュカード。
     - `App.jsx` 計器盤: `💎 {cachePct}%` ピルの横（またはサブ展開表示）に ` · Saved ~$XX`（直近24時間の `cacheRead` 相当節約見込額、純関数 `estimatedSavedUsd(totals, models)` で算出。24h コストの過剰主張にならぬよう実トークン単価ベースまたは概算ラベル付き）を控えめに添える。
     - 画面切替なしの 1タップ切替: `SettingsPane` 最上部の「外観・端末（`#sec-appearance`）」に **Vibe Mode セグメント切替（`⚡ Dopamine` / `🧘 Serotonin`）** と **効果音スイッチ（`Dopamine 時のみ有効`）** を追加（計器盤または設定からすぐ切替可能）。

---

### 3.2 三段構えゼロ依存 A2B パイプライン基盤 ＆ モード自動注入（D23 / D25）

対象: `skills/spec-architect/SKILL.md`（新規）, `bin/hermes-pilot.mjs`, `apps/bridge/src/specs.js`, `apps/bridge/test/specs.test.js`, `apps/bridge/src/pipeline-optimizer.js`（新規）, `apps/bridge/test/pipelineOptimizer.test.js`（新規）, `apps/bridge/src/capabilities.js`, `apps/bridge/src/architect.js`（新規）, `apps/bridge/test/architect.test.js`（新規）, `apps/bridge/src/server.js`, `package.json`

1. **`package.json` & `bin/hermes-pilot.mjs`**:
   - `package.json` の `files` 配列に `"skills/spec-architect/"` を追加（`quick-review/`, `annotation/` と並べる）。
   - `bin/hermes-pilot.mjs` の `BUNDLED_SKILLS` を `['quick-review', 'annotation', 'spec-architect']` に更新し、`hermes-pilot init` 実行時に `~/.hermes/skills/spec-architect/` へ自動配置する。

2. **`skills/spec-architect/SKILL.md`**:
   - Architect 役割（Hermes Native / `agy` 両用）の標準プロトコルを定義:
     - **Round 1（Quick Review 直結インタビュー）**: チャットへ長文の箇条書き質問を並べる代わりに、`review/sheets/spec-<slug>-1.json`（または `.html`）へ 2〜5 問の設計論点シート（各選択肢に最も妥当な `recommended: true` を付与）を書き出し、`kanban create ... --body "[review] label=spec-<slug> round=1 mode=standard ..."` ＋ `block --kind needs_input` で即 Quick Review タブへ届ける。
     - **Round 2（SPEC 生成）**: 回答を受けたら `docs/SPEC-<SLUG>.md`（V3/V4/V5 互換形式）を生成する。各バッチ見出し `### Batch <ID>: <Title>` 直下に必ず `- **Execution Mode**: [Mode: Zero-Stop | Fast-Track Review | Visual Gate]`、`- **目的**: ...`、`- **受入条件（Verify）**: ...` を出力し、`autoStart=true` タグがあれば続けて自動起票を促す完了サマリを出す。

3. **`apps/bridge/src/specs.js` の Execution Mode 解析・契約注入（第2段）**:
   - `parseSpec(text)` 内の各バッチ抽出において、`EXECUTION_MODE_RE = /^[-*]?\s*\*\*\s*(?:Execution\s*Mode|実行モード)\s*\*\*\s*[:：]\s*\[?\s*Mode\s*[:：]\s*([A-Za-z-]+)\s*\]?/im` を解析し、`batch.mode`（`'zero-stop' | 'fast-track-review' | 'visual-gate' | null`）を返す（後方互換: 書かれていない過去 SPEC では `null`）。
   - `buildTaskBody({ specRelPath, repoPath, board, batch, chat })`:
     - `batch.mode` がある場合、`Mode: <mode>` 行を追加し、本文末尾へ **[Hermes Pilot Execution Contract]** ブロックを自動注入する（`BODY_MAX = 6000` 内に収まるよう抜粋長を調整しつつ契約ブロックが途中で切れないようにする）:
       - `zero-stop`: 「チャットへ確認質問をせず、`npm run verify` とテストを通過するまで自律修復して `done` にすること（解消不能な設計矛盾時のみ `quick-review` を起票）」
       - `fast-track-review`: 「選択肢分岐が発生したら実装前に `quick-review` シート（`recommended: true` 付き）を起票して 1タップ承認を待つこと」
       - `visual-gate`: 「実装後 `npm run deploy` を行い、`390×844`・`820×1180` の実画面検証・スクリーンショット取得のうえ、必要に応じて `annotation` レビューを起票して視覚検収を通すこと」
   - さらに、`listSpecs` / `/api/specs` が返すバッチオブジェクトに `mode` フィールドを含め、PWA 側（`TasksPane` の Spec シート）でも各バッチの横にコンパクトなモードピル（`⚡ Zero-Stop` / `🖊 Visual Gate` 等）を表示する。

4. **第3段: 1タップ環境最適化 API (`apps/bridge/src/pipeline-optimizer.js` + `POST /api/pipeline/optimize` + `GET /api/pipeline/status`)**:
   - **機能**:
     - `optimizeHermesSoul({ hermesHome, now })`:
       - `<hermesHome>/SOUL.md` が存在する場合、`<hermesHome>/SOUL.md.bak-<stamp>` へ事前バックアップ。
       - マーカー `<!-- hermes-pilot:a2b:start -->` 〜 `<!-- hermes-pilot:a2b:end -->` の間に簡潔な A2B パイプライン行動規範（長文チャット質問の抑止・Quick Review / Annotation 起票優先・`[Mode: ...]` 遵守・完走要約）を記述。既にあれば該当ブロックのみ冪等置換、ファイルが無ければ最小限の `SOUL.md` として新規作成。
     - `optimizeAntigravitySkills({ home, skillsSrcDir })`:
       - `~/.gemini/config/plugins/hermes-pilot-architect/skills/` および `~/.agents/skills/`（存在する構成先、またはオプション指定）に `quick-review`, `annotation`, `spec-architect` を安全にリンク/コピー配置。
     - `getOptimizeStatus({ hermesHome, home })`: `SOUL.md` 適用済みか・バックアップ有無・`spec-architect` スキル配置状態・Antigravity 連携状態を返す（`redact` 上の秘密情報やユーザー名以外の機密を露出しない）。

5. **Architect ランナー (`apps/bridge/src/architect.js` + `capabilities.js` + `POST /api/architect/seed`)**:
   - `capabilities.js` の `detectCapabilities` に **`hasAgyCli`**（`hasBinary('agy', ...)`）を追加。
   - **セキュリティ／ToS 厳守境界**:
     - Antigravity OAuth クレデンシャルファイル（`oauth_creds` 等）の読み取り・トークン流用・非公式エンドポイントプロキシを**絶対に行わない**。`agy` 利用時は標準のローカル `agy` CLI サブプロセス呼び出し（Opt-in）のみを行う。
   - **`POST /api/architect/seed`**:
     - 入力: `{ repoId?, board?, seedText, runner?: 'hermes'|'antigravity', autoStart?: boolean, chat?: string, lang?: 'en'|'ja' }`
     - 処理:
       1. 対象リポジトリとカンバンボードを解決。
       2. バックグラウンドで選択ランナー（`hermes` CLI または Opt-in `agy` CLI、テスト時は DI モックランナー）を起動し、`spec-architect` プロトコルに沿って `quick-review` インタビューシート（または即時 SPEC 下書き）を作成・実行する。`autoStart: true` を指定した場合は、生成予定メタデータに `autoStart: true` を紐づける。
       3. ステータスと起動した `runId` / `jobId` を即時 `202 Accepted` で返す（PWA がタイムアウト待ちで固まらない設計）。
     - **`GET /api/architect/jobs?board=<slug>`** ＆ **A2B 仕様完成検知**:
       - `pipeline-watcher.js` または `architect.js` が「新規/更新された `docs/SPEC-*.md`（直近 Seed に連動して完成したもの、または未起票の新 SPEC）」を検知し、`chat-reports.jsonl` へ `kind: 'spec_ready'` イベント（または `GET /api/architect/jobs` の `completedSpec`）として通知。
       - **`autoStart: true`** が選ばれていた場合は、対象 SPEC の未起票バッチ（`dryRun: false`）を安全に 1 回だけ `specs.launchSpec(...)` で自動起票して結果を `chat-reports.jsonl` に記録する（冪等制御で二重起票を絶対防止）。

---

### 3.3 ゼロタイピング入力（`🎙️ Spec Seed` ＆ `🏷️ 1-Tap Stamps`）＆ 完了レシートカード（D26）

対象: `apps/web/src/features/ChatPane.jsx`, `apps/web/src/features/SpecSeedSheet.jsx`（新規）, `apps/web/src/features/TasksPane.jsx`, `apps/web/src/features/AnnotationEditor.jsx`, `apps/web/test/annotationStamps.test.js`（新規）, `apps/bridge/src/telemetry.js`（新規）, `apps/bridge/test/telemetry.test.js`（新規）, `apps/web/src/features/MissionReceiptSheet.jsx`（新規）, `apps/web/src/features/UsageSheet.jsx`, `apps/web/src/features/SettingsPane.jsx`, `apps/dashboard/index.js`

1. **`🎙️ Spec Seed` シート（`apps/web/src/features/SpecSeedSheet.jsx`）**:
   - `ChatPane` 入力欄横のコンパクトボタンおよび `TasksPane` 仕様ランチャー横の **`🎙️`** ボタンから 1タップで起動。
   - **機能**:
     - Web Speech API（`window.SpeechRecognition || window.webkitSpeechRecognition`）対応時は 1タップで連続音声認識スタート（現在の UI 言語 `en-US` / `ja-JP` に自動一致）。非対応時はワンタップフォーカスされる簡易入力欄。
     - よく使うテンプレートチップ（例:「新機能の仕様化」「UI/UX改善の仕様化」「バグ修正・安定化の仕様化」）で喋る手間すら省ける補助。
     - トグルチェック: **「承認後に自動でバッチを起票して自走開始する（Auto-file & start after approval）」**（既定 OFF = 安全なハイブリッド、ON で完全シームレス A2B）。
     - 実行ランナーバッジ表示（`Hermes Native` または設定で有効化時の `Antigravity (agy)`）。
   - `POST /api/architect/seed` 送信成功時、`triggerFx('launch')`（Vibe 連動効果＋触覚）を発火し、「インタビューシートが間もなく Review に届きます」とトースト通知する。
   - また `ChatPane` 上に `spec_ready` 通知または未起票の新規 `docs/SPEC-*.md` バナー（**「🚀 新しい仕様書が準備完了 — {n} バッチを一括起票して開始」**）が表示された際、1タップで起票できる（確認不要の即時起票または確認シート選択可）。

2. **Annotation `🏷️ 1-Tap Redline Stamps`（`apps/web/src/features/AnnotationEditor.jsx`）**:
   - キャンバス下の操作バーに横スクロール不要の 2段折り返しまたはスマート 6 チップ（390px で横溢れゼロ）を配置:
     1. `overlap` (`💥 重なり修正` / `💥 Overlap`): `"Fix element overlap around this marked area."`
     2. `spacing` (`📏 余白調整` / `📏 Spacing`): `"Adjust padding and spacing balance here."`
     3. `overflow` (`✂️ 文字切れ` / `✂️ Overflow`): `"Fix horizontal overflow or truncated text here."`
     4. `contrast` (`🎨 視認性` / `🎨 Contrast`): `"Improve text/background contrast ratio here."`
     5. `shift_up` (`🔼 上へ移動` / `🔼 Shift Up`): `"Shift this element up to clear the bottom bar."`
     6. `remove` (`🗑️ 削除・非表示` / `🗑️ Remove`): `"Remove or hide this element."`
   - **動作仕様（純関数 `applyStampToStrokes` を別出しして単体テスト対象化）**:
     - 既にキャンバス上に最後のストロークがあれば、そのストロークに `stamp: { id, label, instruction }` を紐づける。まだ1本も描かれていない状態でスタンプを押した場合は、キャンバス中央付近に小さなマーク（矩形ボックス `[0.35..0.65]`）を自動生成して紐づける。
     - キャンバス再描画時に、各スタンプ付きストロークのそばへ視認性の高いレッド/アンバーの小ピル（例 `#1 💥`）を描画する。
     - `submit()` 送信時、`marks` 配列に `stamp` メタデータを含め、さらにスタンプ由来の一覧文字列を `note` に自動合成してワーカーへ渡す（キーボード入力 0 文字で送信完了）。

3. **Zero-Typing 実行サマリ集計（`apps/bridge/src/telemetry.js`）＆ `🏆 Completion Receipt Card`（`apps/web/src/features/MissionReceiptSheet.jsx`）**:
   - **サーバ側集計 (`GET /api/telemetry/receipt?board=<slug>&spec=<path>`)**:
     - `state.db`（24時間または対象ラン期間・セッション群のトークン、キャッシュヒット率、総コスト USD、ツール実行回数 `toolCalls`）、`kanban.db`（完了タスク数 `batchesDone`、所要時間 `durationMin`）、最新のテスト/検証結果ヒント（`pipeline-reports.jsonl` の `counts` やタスク `result` から抽出されたテスト合格件数・PWA チェック件数）、`audit.jsonl` + レビュー回答記録（人間のタップ判断数 `humanTaps`、赤入れ送信数 `redlines`、チャット手動入力推定文字数 `typedChars`）を安全な範囲で読み取り集計する（ファイル欠損時は 0 / null に優雅にフォールバック）。
     - 推定節約額 `savedUsd`: キャッシュ無しの入力単価 vs `cacheRead` 割引差額、または `cacheHitRate` から算出した保守的推定値（単位・概算である旨を UI 注記に明記し誤認させない）。
   - **クライアント UI (`MissionReceiptSheet.jsx`)**:
     - **到達導線（どこからでも 1 タップ）**:
       1. `ChatPane`: V4 で追加した `PipelineReportCard` のフッタ（`💬 次の一手を相談` `📋 ボードを見る` の隣）に **`🏆 完了レシートを見る`** ボタン。
       2. `TasksPane`: `pipeline-summary-card` バナー内、および Spec 全バッチ完了バーに **`🏆 完了レシート`** ボタン。
       3. `UsageSheet`: コスト＆キャッシュ詳細上部に **`🏆 完了レシートカードを作成`** ボタン。
     - **描画デザイン**:
       - `data-vibe="dopamine"`: ダークティール＆ゴールドのホログラム調シマー枠・`SSR` クリアバッジ・大きな主要 KPI（コスト、キャッシュヒット率、`ZERO-TYPING` 度合い、所要時間）。
       - `data-vibe="serotonin"`: 端正なモノスペース調「**`AUTONOMOUS EXECUTION SUMMARY`**」監査カード。
     - **1タップエクスポート**:
       - **`📸 PNG画像を保存 / Save PNG`**: HTML5 Canvas（1200×630px、2x Retina 対応、Vibe モードを反映した見た目）にクライアント側でレンダリングし、`canvas.toBlob` からダウンロードまたは `navigator.share({ files })` を起動。
       - **`📋 シェア用テキストをコピー / Copy Share Summary`**: 選択言語（EN / JA）で要約テキストをクリップボードへコピー（`t('receipt.copied')`）。

---

### 3.4 PC 筐体シミュレータ付き Interactive Demo Mode（`npm run build:demo`）（D27）

対象: `package.json`, `apps/web/vite.config.js`, `apps/web/src/api.js`, `apps/web/src/lib/useChatSocket.js`, `apps/web/src/demo/mockApi.js`（新規）, `apps/web/src/demo/DemoBanner.jsx`（新規）, `apps/web/src/demo/DemoStage.jsx`（新規）, `apps/web/test/demoMode.test.js`（新規）, `apps/web/src/App.jsx`, `apps/web/src/styles.css`, `README.md`, `README.ja.md`

1. **ビルドパイプライン**:
   - `package.json` に `"build:demo": "VITE_DEMO_MODE=1 vite build --config apps/web/vite.config.js --outDir dist-demo --base ./"` を追加する。
   - `VITE_DEMO_MODE === '1'` のときのみビルドに含まれ、**通常ビルド（`npm run build`）ではモックデータ等を一切バンドルしない**（vite の dead-code elimination / conditional import、もしくは極めて軽量なチェック）。通常 PWA 本番バンドルサイズを汚さないこと。

2. **完全インメモリ API ＆ WebSocket モック（`apps/web/src/demo/mockApi.js`）**:
   - `api.js` と `useChatSocket.js` が `import.meta.env.VITE_DEMO_MODE === '1'` を検知したとき、HTTP リクエスト先と WebSocket (`rpc`) を `mockApi` に委譲する（ログイン画面 `authNeeded` は自動スキップして 0 秒でメイン画面を開く）。
   - **内蔵リアルサンプルデータ**:
     - Architect 生成直後の `Quick Review` 設問 3 問（各問 `recommended: true` 付き・英語/日本語 UI 両対応または現在言語追従）。
     - 1タップ承認後に `docs/SPEC-DEMO-V1.md`（3バッチ）が自動登録・状態進行（800ms ごとに `ready -> running -> done` を気持ちよく遷移）し、`Spec Launchpad` から一括起票・開始できる。
     - Visual Gate サンプルとして、Toast が下部ナビに重なっている `Before` 画像と修正済みの `After` 画像（Canvas で動的生成または超軽量 inline SVG Data URL — 外部画像依存ゼロ！）を内蔵した `Annotation` タスクを用意。スタンプ押下→再検収で「`👍 Looks Good`」が可能。
     - 全工程完了で V4 の統合レポートカード（`kind: 'pipeline'`）＋ `🏆 Completion Receipt` データ（例: `402 Tests`, `$1.08`, `99.4% Cache`, `0 Typed Chars`）が出現。

3. **PC ブラウザ対応 デバイス筐体シミュレータ（`DemoStage.jsx`）＆ 4ステップツアー（`DemoBanner.jsx`）**:
   - **PC デバイスフレーム（`DemoStage.jsx`）**:
     - デモビルド起動時、ビューポート幅が狭いスマホ等（`< 900px` またはユーザー手動 `Full` 選択時）はそのまま全画面 PWA として動作。
     - **PC ブラウザ（`>= 900px`）で開いた場合**: 初期表示として美しいダークキャンバスの背景上に **`📱 Phone (390×844)`** ベゼル筐体（角丸・動的リサイズ可能な中央フレーム、`position: relative; contain: layout;` 等で PWA の `fixed` UI や `Sheet` を筐体内に綺麗に閉じ込める設計！）を既定表示し、上部シミュレータバーから 1タップで以下を切り替え可能にする:
       - **Viewport 切替**: `📱 Phone (390×844)` / `📟 Tablet (820×1180 2ペイン)` / `🖥️ Full Window`
       - **環境即時トグル**: `⚡ Dopamine ⇄ 🧘 Serotonin` / `🔊 SE ON/OFF` / `🌙 Dark ⇄ ☀️ Light` / `🌐 EN ⇄ JA` / `↺ ツアーを最初から`
   - **4 ステップガイドバー（`DemoBanner.jsx`）**:
     - アプリ最上部に現在ステップ・次のタップ誘導・ワンタップジャンプボタンを表示:
       1. `Step 1/4 — Architect Review`: 「`🔔 Review` で設計判断シートを開き **`⚡ Accept All Recommended`** をタップ」
       2. `Step 2/4 — A2B Batch Launch`: 「生成された仕様書の **`🚀 File batches & start`** をタップ」
       3. `Step 3/4 — Visual Gate`: 「`Before ↔ After` 比較 ＋ **`🏷️ 1-Tap Stamp`** または **`👍 Looks Good`** で視覚検収」
       4. `Step 4/4 — Summary & Receipt`: 「チャット/Tasks の統合完了サマリから **`🏆 Completion Receipt`** を確認＆シェア」

---

## 4. Hermes Agent 自走用カンバンタスク分割（Batch V5-1 〜 Batch V5-6）

Hermes Agent（DeepSeek V4.1 Flash）は以下の **6 バッチ（V5-1 → V5-2 → V5-3 → V5-4 → V5-5 → V5-6）** を順番に実行し、各バッチで `Execution Mode` に従い `npm run verify` を通し、Visual Gate バッチでは `npm run deploy` 後のマルチビューポート実画面検査を行うこと。

---

### Batch V5-1: 三段構えゼロ依存A2Bパイプライン基盤（`spec-architect`同梱・モード注入・1タップ環境最適化API）

- **Execution Mode**: `[Mode: Zero-Stop]`
- **目的**: D25 に基づき、① `skills/spec-architect/SKILL.md` 同梱と `bin/hermes-pilot.mjs`（`init`）および `package.json` への登録、② `apps/bridge/src/specs.js` における `- **Execution Mode**: [Mode: ...]` 解析と `[Hermes Pilot Execution Contract]` タスク本文自動注入（＋ Tasks シートでのモードピル表示）、③ `apps/bridge/src/pipeline-optimizer.js`（`POST /api/pipeline/optimize` / `GET /api/pipeline/status`）による冪等な `SOUL.md` 追記＋バックアップおよび Antigravity / Hermes スキル配置を実装する（Section 3.2）。
- **変更・新規ファイル**:
  - 新規: `skills/spec-architect/SKILL.md`
  - 新規: `apps/bridge/src/pipeline-optimizer.js`, `apps/bridge/test/pipelineOptimizer.test.js`
  - 変更: `apps/bridge/src/specs.js`, `apps/bridge/test/specs.test.js`, `apps/bridge/src/server.js`, `bin/hermes-pilot.mjs`, `package.json`
  - 変更（UI 小改）: `apps/web/src/features/TasksPane.jsx`（バッチ一覧へモードピル表示）
- **受入条件（Verify）**:
  - `specs.js` が `docs/SPEC-PILOT-V5.md` の Batch V5-1 〜 V5-6 と各 `Execution Mode` を抽出し、`buildTaskBody` が `[Hermes Pilot Execution Contract]` を適切に注入すること（`specs.test.js`）。
  - `pipeline-optimizer.js` をダミーの `~/.hermes/SOUL.md` に複数回実行してもバックアップが作られ、ルールブロックが1回分だけ冪等更新されること（`pipelineOptimizer.test.js`）。
  - `npm run verify` が全件パスすること。

---

### Batch V5-2: Vibe Mode（`Dopamine` ⇄ `Serotonin`）＋ 基本触覚維持 ＋ Web Audio 効果音＆粒子演出

- **Execution Mode**: `[Mode: Visual Gate]`
- **目的**: D24 に基づき、`apps/web/src/lib/vibe.js`（`<html data-vibe="dopamine|serotonin">`、`prefers-reduced-motion` フォールバック、コンボ計算）、`apps/web/src/lib/soundFx.js`（Web Audio API ゼロ依存効果音）、`apps/web/src/components/FxLayer.jsx`（Dopamine 時パーティクルバースト・コンボ／オールクリア演出）を実装し、`Serotonin` 時も標準ハプティック（`haptic.js`）を維持したまま静穏モードへ切替られるようにする（Section 3.1）。
- **変更・新規ファイル**:
  - 新規: `apps/web/src/lib/vibe.js`, `apps/web/src/lib/soundFx.js`, `apps/web/src/components/FxLayer.jsx`, `apps/web/test/vibe.test.js`
  - 変更: `apps/web/src/App.jsx`, `apps/web/src/features/ReviewPane.jsx`, `apps/web/src/features/TasksPane.jsx`, `apps/web/src/features/SettingsPane.jsx`, `apps/web/src/styles.css`
  - 変更: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ja.json`
- **受入条件（Verify）**:
  - `vibe.test.js` で `dopamine` / `serotonin` 切替・`prefers-reduced-motion` 自動選択・`Serotonin` 時も基本 `haptic` が呼ばれること・`Combo` カウンタ遷移がテストされること。
  - `SettingsPane` の外観カードから Vibe Mode（`Dopamine` / `Serotonin`）と効果音トグルが操作でき、`noHardcodedJapanese` 違反ゼロ。
  - `npm run verify` 後、`npm run deploy` を行い、`390×844` / `820×1180` で `dopamine`・`serotonin` 両モードの表示・横溢れゼロ（`scrollWidth <= clientWidth`）を検証する。

---

### Batch V5-3: `Hermes Native` ＆ Opt-in `agy` Architect ＋ `🎙️ Spec Seed` ＆ ハイブリッド A2B 一括起票

- **Execution Mode**: `[Mode: Zero-Stop]`
- **目的**: D23 / D25 / D26 ① に基づき、`capabilities.js` で `agy` CLI を安全検出し（OAuth/トークン盗み出しゼロ境界厳守）、`apps/bridge/src/architect.js`（`POST /api/architect/seed`, `GET /api/architect/jobs`）、`SpecSeedSheet.jsx`（音声ディクテーション＋テンプレートチップ＋「承認後自動起票」チェック）、新規 SPEC 完成時の A2B クイック起票カード（Chat/Tasks）、ならびに設定タブ＆標準 Web UI（`apps/dashboard/*`）の「パイプライン＆Architect 最適化」パネルを実装する（Section 3.2・3.3）。
- **変更・新規ファイル**:
  - 新規: `apps/bridge/src/architect.js`, `apps/bridge/test/architect.test.js`
  - 新規: `apps/web/src/features/SpecSeedSheet.jsx`
  - 変更: `apps/bridge/src/capabilities.js`, `apps/bridge/src/server.js`, `apps/bridge/src/pipeline-watcher.js`, `apps/bridge/src/snippets.js`
  - 変更: `apps/web/src/features/ChatPane.jsx`, `apps/web/src/features/TasksPane.jsx`, `apps/web/src/features/SettingsPane.jsx`, `apps/dashboard/index.js`, `apps/dashboard/pilot_dashboard.py`
  - 変更: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ja.json`
- **受入条件（Verify）**:
  - リポジトリ全体で `.gemini.*oauth` / `oauth_creds` 等へのアクセスが `0` 件であること。
  - モックランナーを用いた `architect.test.js` で `POST /api/architect/seed` → シート起票・ジョブ管理・`autoStart` 冪等連携が検証されること。
  - 標準 Web UI（`apps/dashboard`）の `dashboard-plugin.test.js` と `npm run verify` が全件パスすること。

---

### Batch V5-4: Annotation「🏷️ 1-Tap Redline Stamps（ゼロタイピング指示スタンプ）」

- **Execution Mode**: `[Mode: Visual Gate]`
- **目的**: Section 3.3 ② に基づき、`AnnotationEditor.jsx` に文字入力不要で視覚修正指示を構造化添付できる 6 種のスタンプチップバー（`Overlap`, `Spacing`, `Overflow`, `Contrast`, `Shift Up`, `Remove`・EN/JA 対応）と純粋ヘルパー `annotationStamps.js` を実装する。
- **変更・新規ファイル**:
  - 新規: `apps/web/src/lib/annotationStamps.js`, `apps/web/test/annotationStamps.test.js`
  - 変更: `apps/web/src/features/AnnotationEditor.jsx`, `apps/web/src/styles.css`
  - 変更: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ja.json`
- **受入条件（Verify）**:
  - `annotationStamps.test.js` で既存ストロークへの紐づけ、ストローク未描画時の自動ボックス生成、送信テキスト・JSON 変換を検証すること。
  - `npm run verify` および `npm run deploy` 後、`390×844` / `820×1180`（EN/JA・Dark/Light）で `AnnotationEditor` のスタンプバーとキャンバスに文字切れ・横溢れがないことを検証する。

---

### Batch V5-5: Zero-Typing テレメトリ ＆「🏆 完了レシートカード（Canvas PNG ＋ X共有）」

- **Execution Mode**: `[Mode: Visual Gate]`
- **目的**: D26 ③ に基づき、`apps/bridge/src/telemetry.js`（`GET /api/telemetry/receipt`）と `apps/web/src/features/MissionReceiptSheet.jsx`（Dopamine SSR ホログラム調 ⇄ Serotonin 端正サマリ調、1200×630 PNG 生成保存、シェア文コピー）を実装し、`ChatPane` の統合レポートカード・`TasksPane` の完走バナー・`UsageSheet` の 3 箇所から 1タップで開けるよう統合する。
- **変更・新規ファイル**:
  - 新規: `apps/bridge/src/telemetry.js`, `apps/bridge/test/telemetry.test.js`
  - 新規: `apps/web/src/features/MissionReceiptSheet.jsx`, `apps/web/src/lib/receiptCanvas.js`, `apps/web/test/receipt.test.js`
  - 変更: `apps/bridge/src/server.js`, `apps/web/src/features/ChatPane.jsx`, `apps/web/src/features/TasksPane.jsx`, `apps/web/src/features/UsageSheet.jsx`, `apps/web/src/styles.css`
  - 変更: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ja.json`
- **受入条件（Verify）**:
  - `telemetry.test.js` でキャッシュ率・節約見込額・操作メトリクス集計と空データ時の優雅なフォールバックを検証、`receipt.test.js` で EN/JA シェアテキスト生成とラベル整合を検証する。
  - `npm run verify` 後、`npm run deploy` し、`390×844` / `820×1180` で `Dopamine` / `Serotonin` 両モードのレシート表示・横溢れゼロを検証する。

---

### Batch V5-6: PC対応「🎮 Interactive Demo Mode（`npm run build:demo`）」・README整備・総合視覚監査

- **Execution Mode**: `[Mode: Visual Gate]`
- **目的**: D27 に基づき、バックエンド不要で GitHub Pages 等に公開でき、スマホ直接閲覧でも **PC ブラウザ閲覧（Phone 390×844 / Tablet 820×1180 / Full フレーム切替＋Vibe/音/言語/テーマ即時切替）** でも A2B パイプラインの 4 ステップ（Spec 承認 → バッチ起票 → Redline スタンプ/Before-After 検収 → 統合完了サマリ＆完了レシート PNG/共有）を体験できる静的デモ `apps/web/dist-demo`（`npm run build:demo`）を構築し、`README.md` / `README.ja.md` を更新して最終マルチビューポート検証を行う（Section 3.4）。
- **変更・新規ファイル**:
  - 新規: `apps/web/src/demo/mockApi.js`, `apps/web/src/demo/DemoBanner.jsx`, `apps/web/src/demo/DemoStage.jsx`, `apps/web/test/demoMode.test.js`
  - 変更: `apps/web/src/api.js`, `apps/web/src/lib/useChatSocket.js`, `apps/web/src/App.jsx`, `apps/web/src/styles.css`, `package.json`
  - 変更: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ja.json`, `README.md`, `README.ja.md`
- **受入条件（Verify）**:
  - `npm run verify`（通常ビルド・`noHardcodedJapanese` 含む全テスト）と `npm run build:demo`（`apps/web/dist-demo` 生成）の両方が exit 0 で完了すること。
  - 通常本番ビルド（`apps/web/dist`）側にデモ用モックやテストフィクスチャが混入しないこと（`npm pack --dry-run` でも `dist-demo` や一時スクショが入らないこと）。
  - `apps/web/dist-demo` を単体静的サーブした状態でヘッドレスブラウザ実測を行い、コンソールエラー 0 件で:
    - PC（`1280×800`）で Phone 枠・Tablet 2ペイン枠の切替が崩れず、筐体内に `Sheet` / トースト / ナビが綺麗に収まること。
    - Step 1 → Step 2 → Step 3 → Step 4 まで 4 ステップ体験が完走し、完了レシートが開けること。
    - 本番環境 `npm run deploy` 後の `390×844` / `820×1180` × `en`/`ja` × `dark`/`light` × `dopamine`/`serotonin` で横溢れゼロ（`scrollWidth <= clientWidth`）を確認すること。

---

## 5. Hermes Agent 自律実行プロンプト（コピペ用）

以下のプロンプトをチャットへ貼り付けるか、PWA「Tasks → 🚀 仕様ランチャー（Spec Launchpad）」から `docs/SPEC-PILOT-V5.md`（Batch V5-1 〜 V5-6）を一括起票して実行してください:

```text
docs/SPEC-PILOT-V5.md を精読し、Section 4 の Batch V5-1 から Batch V5-6 までを順番に自律実装・検証してください。

厳守事項:
1. 各バッチの開始前に既存コード（V4実装済みの pipeline-watcher.js / specs.js / ChatPane.jsx / TasksPane.jsx / AnnotationEditor.jsx / ReviewPane.jsx / SettingsPane.jsx / dashboard）と関連テストを読み、V1〜V4 までの既存動作とプロジェクト制約（apps/web/test/noHardcodedJapanese.test.js、OAuth/秘密情報非露出、review/feed.jsonl 境界）を絶対に壊さないこと。
2. 各バッチ記載の `Execution Mode`（[Mode: Zero-Stop] / [Mode: Visual Gate]）に従って動作し、1 バッチごとに必ず `npm run verify` を通してから次へ進むこと。
3. [Mode: Visual Gate] バッチ（V5-2 / V5-4 / V5-5 / V5-6）では `npm run deploy` 後、ヘッドレスブラウザで 390×844（スマホ）および 820×1180（タブレット2ペイン）、さらに V5-6 では PC 1280×800（Interactive Demo 筐体シミュレータ）を EN/JA・Dark/Light・Dopamine/Serotonin で実測し、横溢れ（scrollWidth > clientWidth）・文字切れ・コンソールエラーがゼロであることを確認すること。
4. 判断が必要な論点が出た場合のみ quick-review または annotation タスクを起票し、それ以外は完走まで止まらず走り切ること。
```
