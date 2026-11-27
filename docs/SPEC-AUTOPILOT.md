# SPEC: v0.3.0 Autopilot Mode — スワイプデッキ＆ビジュアル優先 A2B パイプライン (`SPEC-AUTOPILOT`)

- **Status**: archived
- **状態**: 完了（`v0.3.0`・`AP-1`〜`AP-6` 実装＆検証済み）
- **対象リポジトリ**: `~/projects/hermes-mobile-pwa`（`v0.2.5` → `v0.3.0`）
- **前提・関連仕様**:
  - [SPEC-COHERENCE.md](./SPEC-COHERENCE.md) / [SPEC-COHERENCE-RESIDUAL-DRIFT.md](./SPEC-COHERENCE-RESIDUAL-DRIFT.md)（4 つの正本原則: `sync-owner` / `transport-owner` / `transition-owner` / `board-tick-owner`）
  - [PITFALLS.md](./PITFALLS.md)（P7: Theme × Vibe 4 通り検査 / P9: 正本原則）/ [MODULES.md](./MODULES.md)（800 行上限ラチェット）

---

## 1. コンセプトと全体像（Zero-Fork Architecture）

初心者は **Autopilot（Tinder ライクな 4 方向スワイプ＋赤入れ）** だけで開発を完結でき、中上級者はヘッダの `[✨ Autopilot | 🎛 Cockpit]` でいつでも既存のコックピット画面（Tasks / Review / Chat / Memos / Terminal）へ降りられる **2 段階・単一データソース構成** を構築する。

- **Zero-Fork 投影（Lens）**: Autopilot 画面は独立 DB・独自ポーリングを持たず、現在ボードの `ArchitectJobBar`・待機中 `review/sheets`・進行中 `live`・完走後 `MissionReceipt`・`Brainstorm` 提案を 1 つのカードデッキとして投影する。
- **7 つのコア品質要件（ロードマップ準拠）**:
  1. **Deck Buffering（待ち時間ゼロ）**: レシピ起票の 1 枚目はプリレンダ／軽量テンプレートで即時表示し、Round 1 は 1 シート＝3 枚デッキ（例: レイアウト / 操作フロー / データ方針）を一括生成して 3 連続スワイプ後に一括 Unblock する。
  2. **左スワイプ（REMIX）の却下理由チップ**: 左スワイプ直後に 1.5〜2 秒だけワンタップチップ（`🎨 色・雰囲気` / `📐 シンプル化` / `📊 情報量増` / `💬 一言入力`）を出し、無操作なら別案、タップ時はその方向で再生成する。
  3. **上スワイプ（ANNOTATE）→ SPEC `Verify` 自動注入**: 軽量 HTML モックへの赤入れ座標・コメントを「赤入れ付きで採用（Approve with Annotations）」として回答 JSON に含め、Round 2 の `Objective` / `Verify` と実装後 `Visual-Gate` へ直結させる。
  4. **親指スワイプの物理 UX と誤操作防止**: 左右端 24px デッドゾーン（ブラウザ戻るジェスチャー回避）、距離閾値 90px 以上＋角度判定、4 方向ゴーストスタンプ（GO / REMIX / ANNOTATE / HOLD）、Haptics 連動、下部常設 4 ボタン、3 秒 Undo フローティングピル。
  5. **下スワイプ（HOLD）の文脈別動作**: 設問カードでは `recommended` 委譲（パイプラインを止めない）、Brainstorm カードでは `MemosPane` へのアイデア保存。
  6. **2 段階のシームレスな橋渡し**: `[✨ Autopilot | 🎛 Cockpit]` トグル、実行中のモック↔実装スクショのワイプ変化ライブ進捗カード、Cockpit 側の `✨ Swipe in Autopilot (N)` 導線。
  7. **品質ガードレール内蔵**: `AutopilotDeck.jsx` / `autopilot.css` として最初から独立モジュール化（800 行未満）、4 つの正本原則遵守、Dark/Light × Dopamine/Serotonin の 4 通り検証。

---

## 2. Phase 1 データ契約＆スキル拡張

### 2.1 `review/sheets/*.json` の無破壊拡張

既存の `mode=standard`（`Quick Review`）と `Autopilot` が同一 JSON を読めるよう、オプショナルな `visualMock` フィールドを許容する（未指定の既存シートは従来どおり `<StandardForm>` で動く）。

```json
{
  "label": "spec-focusflow-1",
  "round": 1,
  "mode": "standard",
  "deck": true,
  "title": "FocusFlow — 方向性デッキ",
  "questions": [
    {
      "id": "q1",
      "text": "メインタイマー画面のレイアウト",
      "visualMock": {
        "shot": "shots/spec-focusflow-1-q1.png",
        "html": "sheets/spec-focusflow-1-q1.html",
        "layoutVariant": "A",
        "template": "timer-card"
      },
      "options": [
        { "id": "A", "label": "円形リング＋下部 1 ボタン", "detail": "…", "recommended": true },
        { "id": "B", "label": "コンパクト横並び", "detail": "…" }
      ]
    }
  ]
}
```

- **パス安全**: `visualMock.shot` / `visualMock.html` は `isSafeRel()`（`apps/bridge/src/review/parse.js`）で検証し、`thumbs/`・`shots/`・`sheets/` 配下のみ許可する。
- **カード単位の赤入れ**: 既存の `answer(id, { answers, global, annotations })`（`apps/bridge/src/review.js:403`）は既に `annotations` 配列を受理・ハッシュ化できる。各要素に `{ questionId, shot, marks, note }` を持たせ、`answer.txt` の人間向け出力にも赤入れ要約を出力する。
- **REMIX（別案再生成）契約**: `POST /api/review/:id/remix` を追加し、`{ questionId, reason, hint, chat }` を受け、`transitions` 経由または再生成コメント＋ワーカー再起動（または `sheets/<label>-<round>.remix.json` 記録）を行えるようにする。`API_ROUTES`（`apps/bridge/src/contracts/routes.js`）に `demo: 'mocked'` で登録し、デモモードでも同じ経路を通す。

### 2.2 `skills/spec-architect/SKILL.md` / `skills/quick-review/SKILL.md`

- Autopilot ビジュアル優先モード（`visualMock` 付き 3 枚デッキ）をオプショナルな出力プロトコルとして定義する。
- 汎用スキル原則（`skillsGeneric.test.js`）を守り、特定リポジトリ固有のコマンド名・画面サイズ直書きを避け、「対象リポジトリが定めるモバイル画面幅・検証契約」に従う記述とする。

---

## 3. Phase 2 UI・モジュール配置（800 行ラチェット準拠）

| ファイル | 役割 |
|---|---|
| `apps/web/src/lib/autopilotDeck.js` | 純関数（デッキ構築・スワイプ方向/閾値判定・デッドゾーン判定・3 秒 Undo 状態・回答ペイロード組み立て） |
| `apps/web/src/features/autopilot/AutopilotDeck.jsx` | フルスクリーンカードデッキ UI・ゴーストスタンプ・REMIX チップ・ライブ進捗ワイプ・`AnnotationEditor` 連携 |
| `apps/web/src/styles/autopilot.css` | Autopilot 専用スタイル（`styles.css` へ 1 行 `@import` 追加・CSS トークンのみ使用） |
| `apps/web/src/App.jsx` | ヘッダ `[✨ Autopilot | 🎛 Cockpit]` 切替と `syncSources` 購読の橋渡し |
| `apps/web/src/demo/` | `payloads.js` / `fixtures.js` / `shots.js` / `fetch.js` の Autopilot デモデータ＆モックハンドラ |

---

## 4. バッチ（`AP-1` 〜 `AP-6`）

すべて `[Mode: Zero-Stop]`・1 バッチ 1 テーマ。`--parent` で順に実行されるため、依存は `1 → 2 → 3 → 4 → 5 → 6` の一方向とする。中間バッチ（`AP-1`〜`AP-5`）は高速 Verify（関連テスト＋`npm test && npm run build && npm run check:coherence`）、最終バッチ（`AP-6`）でフル `npm run verify` を実行する。

### Batch AP-1: PHASE1-DATA — 無破壊データ契約拡張（`visualMock` / `annotations` / `remix`）

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: 既存の `kanban.db` / `specs.js` / `parseReviewLine` 契約を一切壊さず、`sheets/*.json` の `visualMock` フィールド・`annotations` 配列のテキスト化・`POST /api/review/:id/remix` 契約を追加する。
- **変更・新規ファイル**:
  - Changed: `apps/bridge/src/review/parse.js`（`visualMock` の安全パス判定ヘルパ）
  - Changed: `apps/bridge/src/review/text.js` / `apps/bridge/src/review.js`（`annotations` 付き `answer` の `.answer.txt` 整形と `remix()` ハンドラ）
  - Changed: `apps/bridge/src/contracts/routes.js` / `apps/bridge/src/server.js` / `apps/bridge/src/server/api-boards.js`（`POST /api/review/:id/remix` ルート登録とハンドラ）
  - Changed: `apps/bridge/test/review.test.js` / `apps/bridge/test/routeContracts.test.js`（`visualMock` 許容・旧シート非破壊・`annotations`・`remix` テスト）
- **Verify**: `node --test apps/bridge/test/review.test.js apps/bridge/test/routeContracts.test.js && npm test && npm run check:coherence`

### Batch AP-2: PHASE1-SKILLS — `spec-architect` / `quick-review` ビジュアル優先プロトコル拡張

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:planner`
- **目的**: `spec-architect` と `quick-review` に、3 枚デッキ（`deck: true`, `visualMock`）および「モックへの赤入れ座標→SPEC `Objective` / `Verify` 注入→実装後 `Visual-Gate` 重点検証」のプロトコルを追加する。
- **変更・新規ファイル**:
  - Changed: `skills/spec-architect/SKILL.md` / `skills/quick-review/SKILL.md`
  - Changed: `apps/bridge/test/skillsGeneric.test.js` / `apps/bridge/test/architectJobView.test.js`（汎用性チェック維持＋デッキ／赤入れ注入契約のテスト追加）
- **Verify**: `node --test apps/bridge/test/skillsGeneric.test.js apps/bridge/test/architectJobView.test.js && npm test && npm run check:coherence`

### Batch AP-3: DECK-UI — `AutopilotDeck.jsx` / `autopilot.css` スワイプ基盤と誤スワイプ防止

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: 左右端 24px デッドゾーン・90px 閾値・4 方向ゴーストスタンプ（GO / REMIX / ANNOTATE / HOLD）・Haptics 連動・下部常設 4 ボタン・3 秒 Undo トースト・プリレンダ／テンプレート 0 秒表示を備えた独立スワイプデッキを実装する。
- **変更・新規ファイル**:
  - New: `apps/web/src/lib/autopilotDeck.js` / `apps/web/test/autopilotDeck.test.js`
  - New: `apps/web/src/features/autopilot/AutopilotDeck.jsx` / `apps/web/src/styles/autopilot.css`
  - Changed: `apps/web/src/styles.css`（`@import './styles/autopilot.css'` 追加）
  - Changed: `apps/web/src/i18n/en.json` / `apps/web/src/i18n/ja.json`（Autopilot 用 EN/JA 辞書キー同時追加）
- **Verify**: `node --test apps/web/test/autopilotDeck.test.js apps/web/test/stylesManifest.test.js apps/web/test/i18nParity.test.js && npm test && npm run build && npm run check:coherence`

### Batch AP-4: DECK-ACTIONS — 左 REMIX チップ・上 ANNOTATE 赤入れ・下 HOLD 連携

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: 3 つの非右スワイプアクションを実機能に接続する（左＝1.5〜2 秒ワンタップ却下理由チップ→`/api/review/:id/remix`、上＝`AnnotationEditor` 起動→赤入れ付き採用としてデッキ回答へ結合、下＝設問は `recommended` 委譲・Brainstorm は `MemosPane` 保存）。
- **変更・新規ファイル**:
  - Changed: `apps/web/src/features/autopilot/AutopilotDeck.jsx` / `apps/web/src/lib/autopilotDeck.js`
  - Changed: `apps/web/src/features/AnnotationEditor.jsx`（必要最小限の「デッキへ赤入れを返す」コールバック対応・800 行未満維持）
  - Changed: `apps/web/src/styles/autopilot.css`（REMIX チップ帯・Undo ピルのスタイル）
  - Changed: `apps/web/test/autopilotDeck.test.js`（REMIX チップ・赤入れ付き採用・HOLD 文脈分岐の単体テスト）
- **Verify**: `node --test apps/web/test/autopilotDeck.test.js && npm test && npm run build && npm run check:coherence`

### Batch AP-5: COCKPIT-LENS — Zero-Fork 統合レンズ・`Cockpit Switcher`・ライブ進捗カード

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: `App.jsx` に `[✨ Autopilot | 🎛 Cockpit]` 切替と Zero-Fork 投影を組み込み、進行中のモック↔実装スクショのワイプ比較カードおよび Cockpit 側からの `✨ Swipe in Autopilot (N)` 導線を実装する。
- **変更・新規ファイル**:
  - Changed: `apps/web/src/App.jsx`（モード切替状態・`syncSources` 共有購読のみ、新規 `setInterval` なし）
  - Changed: `apps/web/src/features/ReviewPane.jsx` / `apps/web/src/features/TasksPane.jsx`（`Swipe in Autopilot` 導線。サイズ増加に注意し、`coherence-baseline.json` が縮小/超過しないよう管理）
  - Changed: `apps/web/src/features/autopilot/AutopilotDeck.jsx` / `apps/web/src/styles/autopilot.css`（ライブ進捗ワイプカード）
  - Changed: `apps/web/src/i18n/en.json` / `apps/web/src/i18n/ja.json` / `scripts/coherence-baseline.json`（必要時のみ `--update-baseline`）
- **Verify**: `npm test && npm run build && npm run check:coherence`

### Batch AP-6: DEMO-VERIFY — Interactive Demo パリティ・4 通り画面監査・総合検証

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:visual-reviewer`
- **目的**: `npm run build:demo` で Autopilot デッキ（プリレンダモック・REMIX・ANNOTATE・HOLD・ライブ進捗ワイプ）がゼロインストールで動作するようにし、Dark/Light × Dopamine/Serotonin の 4 通り実画面確認・ドキュメント更新・フル `verify` を完了する。
- **変更・新規ファイル**:
  - Changed: `apps/web/src/demo/payloads.js` / `apps/web/src/demo/fixtures.js` / `apps/web/src/demo/shots.js` / `apps/web/src/demo/fetch.js` / `apps/web/src/demo/mockApi.js`
  - Changed: `docs/MODULES.md`（`features/autopilot/` と `styles/autopilot.css` の置き場所追記）
  - Changed: `apps/web/test/demoMode.test.js`（Autopilot デモ経路の検証追加）
- **Verify**: `npm run build:demo && npm run verify`

---

## 5. Round 2 自己点検チェック（実装時の落とし穴）

1. **既存ラチェット上限**: `TasksPane.jsx`・`ReviewPane.jsx`・`App.jsx` は `scripts/coherence-baseline.json` に登録済みのため、UI 実装は極力 `apps/web/src/features/autopilot/` と `apps/web/src/lib/autopilotDeck.js` へ逃がし、既存ファイルを肥大化させない（縮小時は `node scripts/check-coherence.mjs --update-baseline` を実行）。
2. **4 つの正本原則**: Autopilot 内に `setInterval(`（1 秒時計以外）を書かない。すべての定期取得は `lib/syncSources.js` のトピック購読を使い、状態遷移は `review/transitions.js` 経由に統一する。
3. **デモ整合（`routeContracts.test.js`）**: `POST /api/review/:id/remix` を `routes.js` に追加したら、同時に `apps/web/src/demo/mockApi.js`（または `fetch.js`）と `server.js` 側も揃える。
4. **汎用スキル境界（`skillsGeneric.test.js`）**: `skills/*.md` に特定リポジトリ固有のコマンド名（`npm run verify` 等）や固定ピクセル表記を書かない。

---

## 6. 全体の完了条件

1. `npm run verify` が exit 0（`npm test`・`check:dashboard`・`check:pwa`・`check:oauth`・`build`・`audit:responsive`・`check:term-enter`・`check:coherence`・`check:cold-install` すべて通過）。
2. `npm run build:demo` が成功し、デモモード上で Autopilot デッキの一連の操作（右採用・左 REMIX・上 ANNOTATE・下 HOLD・Cockpit 切替）が完結する。
3. Dark/Light × Dopamine/Serotonin の 4 組み合わせで色直書きゼロ・44px タップ領域違反ゼロ・横溢れゼロを確認済み。
