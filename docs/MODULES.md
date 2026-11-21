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

## Bridge の HTTP 層

- `apps/bridge/src/http/respond.js`: 応答の共通形（`sendJson` / `sendError` / `sendFailure`）・本文読み取り・
  `langOf`・`MIME`。
- `apps/bridge/src/http/rate-limit.js`: 書き込み / ペアリング / 読み取りの 3 系統（バケットを混ぜない）。
- `apps/bridge/src/http/login-page.js`: ログイン画面の HTML と日英文言。
- `apps/bridge/src/http/static-files.js`: `dist` → `dist.prev` フォールバックを含む静的配信。
- ルーティングとドメイン判断は `apps/bridge/src/server.js` に残す（ここは「読む／書く」だけ）。
