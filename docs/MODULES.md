# モジュール分割の置き場所（COHERENCE / HOTSPOTS）

大きくなったファイルは「意味の単位」で切り出してある。**追記先を間違えると元に戻る**ので、
新しいコードは次の置き場所を先に探す（無ければ新しいファイルを作る）。
分割はどれも**公開契約を変えない**（HTTP の口・JSX の出力・CSS のカスケードは同一）。

## CSS

- 入口は `apps/web/src/styles.css` の `@import` manifest だけ（規則を書き戻さない）。
- 実体は `apps/web/src/styles/*.css`（`tokens` / `shell` / `chat` / `review` / `vibe-fx` …）。
- **読み込み順＝カスケード順**。順序は動かさない。新しい見た目は意味の合うファイルへ追記し、
  どれにも合わなければ新ファイル＋manifest に 1 行。
- 各ファイルは ratchet の上限（`scripts/coherence-baseline.json` の `maxLines` = 800 行）以下に保つ。
- テストは `apps/web/test/helpers/styles.js` の `readStyles()` で全ソースを展開して読む
  （`apps/web/test/stylesManifest.test.js` が manifest・参照先・行数・`:root` の単一性を機械検査）。
- 分割前後で**ビルド済み CSS バンドルがバイト一致**することを実測して確認した（2026-11-21）。

## チャットの表示パーツ

- `apps/web/src/features/chat/ChatParts.jsx`: 本文 Markdown / ツール行 / 統合レポートカード /
  過去セッション一覧 / 入力欄の自動伸長。
- 会話全体の状態（ソケット・送信・スクロール・添付・ドロワー開閉）は `apps/web/src/features/ChatPane.jsx` に残す。

## レビューの表示パーツ

- `apps/web/src/features/review/Chip.jsx`: `.ak-chip` のチップ（一覧の行・「推奨」・読取専用が共有）。
  定義は 1 箇所だけに置く。
- `apps/web/src/features/review/ReviewForms.jsx`: 設問から描く `StandardForm` / sandbox iframe と
  貼り付け回答の `IframeForm` / 詳細シートへの `SheetLink`、挿絵の拡大用 `toZoom`（内部専用）。
- `apps/web/src/features/review/ReviewDetail.jsx`: 判断待ち以外の読み取り専用詳細 `ReadOnlyDetail`
  （回答履歴・before/after・再オープン）。
- `apps/web/src/features/review/AnnotationCreate.jsx`: 「＋ 注釈」シート `NewAnnotationSheet` と、
  開く前の先読み `prefetchAnnotationData`（キャッシュはこのモジュールが持つ）。
- 一覧（`ItemRow`）・作業ログ（`WorkerFeed`）・タブ・選択状態・送信後の遷移（次の判断待ちを開く／
  全件完了バナー）は `apps/web/src/features/ReviewPane.jsx` に残す。

## Bridge の HTTP 層

- `apps/bridge/src/http/respond.js`: 応答の共通形（`sendJson` / `sendError` / `sendFailure`）・本文読み取り・
  `langOf`・`MIME`。
- `apps/bridge/src/http/rate-limit.js`: 書き込み / ペアリング / 読み取りの 3 系統（バケットを混ぜない）。
- `apps/bridge/src/http/login-page.js`: ログイン画面の HTML と日英文言。
- `apps/bridge/src/http/static-files.js`: `dist` → `dist.prev` フォールバックを含む静的配信。
- ルーティングとドメイン判断は `apps/bridge/src/server.js` に残す（ここは「読む／書く」だけ）。

## Bridge の A2B パイプライン最適化

- 入口は `apps/bridge/src/pipeline-optimizer.js` の**バレルだけ**（明示的な named re-export・実装を置かない）。
  公開している 23 export は分割前と同一なので、新しい呼び出し元はこのパスを import する。
- 実体は `apps/bridge/src/pipeline/` の 4 ファイル。依存は `paths` ← `soul` ← `profile` ← `skills` の DAG
  （`pipeline/` の内部は直接 import し、バレル経由にしない＝循環を作らない）。
  - `paths.js`: `REPO_ROOT` / `BUNDLED_SKILLS` / `DEFAULT_SKILLS_SRC` だけの葉。
  - `soul.js`: A2B マーカーと規範文・`mergeSoul` / `backupStamp` / `nextBackupPath` / `applySoulFile` /
    `inspectSoulFile` / `profileSoulState` / `optimizeHermesSoul`（† の 3 つは `pipeline/` 内部共有専用）。
  - `profile.js`: プロファイル名の正規化・探索と `SOUL.md` の同期（`ensurePilotProfile` / `optimizeProfileSouls`）。
  - `skills.js`: 同梱スキルのファイル配置と適用状況（`installSkill` / `optimizeAgentSkills` / `getOptimizeStatus`）。
- `optimizeAntigravitySkills`（現行名 `optimizeAgentSkills`）は `pipeline/skills.js` が定義元なので、
  `scripts/check-coherence.mjs` の `LEGACY_SYMBOLS` の allow にこのパスが入っている（消すと hard fail）。
