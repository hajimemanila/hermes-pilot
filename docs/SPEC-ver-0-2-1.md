# SPEC: Ver.0.2.1 — メモ表示・タブレット横持ち 2 カラム・赤ペン注釈の磨き込み

対象: `~/Projects/hermes-mobile-pwa`（PWA `apps/web`）
決定: 赤ペンシート `spec-ver-0-2-1-1` round 1（回答は `plugin-data/hermes-pilot/review/sheets/spec-ver-0-2-1-1.answer.json`・4 問すべて A）
起票先: board `hermes-pilot`（レビュー実体は board `mobile` 固定 — `apps/bridge/src/review.js:562`）

---

## 0. 決定（人が選んだもの・変更不可）

- **Q1 = A**: 右は本文だけ。**バナー・インジケーターチップ・スニペット帯・入力欄を左カラム下端へ移す**。
- **Q2 = A**: メモの表示切替は**検索行の右端に 3 分割セグメント**。**既定=二列・端末に保存**（`localStorage` の `hm.memosView`）。
- **Q3 = A**: メモ編集シートを未保存で閉じたときは、**変更があるときだけ「保存する／破棄する／戻る」の 3 択**。
- **Q4 = A**: 二列カードは**高さ 220px 固定**。**本文 4 行＋「…」**、**チェックリストは先頭 3 件＋「+N」**。

### 0.1 事実で決めた 3 点（聞いていない）

- **注釈ドロワーの対象リポ**: `localStorage` の新キー **`hm.reviewRepo`** に保存し、無ければ `hm.repo` に落とす。`ReviewPane.jsx:930` の `useState('')` を直前値で初期化する。
- **実行中ドットの色抜け**: `.working-dot` の `hm-working-pulse` が `opacity` を 1→0.45 に動かすため背景色ごと薄くなり、暗い面で黒く見える。**色は動かさずリングだけを明滅**させる。
- **リスト表示の三点ドット**: 既存の 3 ボタン＋ピン留めを 1 つの `⋯` メニューへ畳む。**削除は現状カードに無いので足さない**。

### 0.2 Q1 の適用範囲（解釈・レビューで差し戻し可）

Q1 が名指しする 4 つは、いま**チャットタブ**に実在する（`ChatPane.jsx:1945` の `.chat-head` チップ / `.banner` / `ChatPane.jsx:2498` の `.action-bar` / `ChatPane.jsx:2536` の `.composer`）。
したがって本 SPEC は**タブレット横持ちのチャットタブに 2 カラムを作る**（左 = セッション一覧、右 = タイムライン）。
レビュータブの 2 ペイン（`ReviewPane.jsx:1240`）は**触らない** — すでに「左一覧／右本文」で、右カラム下部の閉じる理由入力は読みながら打つ類の入力ではない。

---

## 1. 実測（すべて現物の file:line・2026-11-19）

### 1.1 レイアウト

- 2 ペインの境界は **820px の 1 本**（`styles.css:3610`）。数値の正本は `apps/web/src/lib/layout.js:20-23`（`SPLIT_MIN=680` / `SPLIT_WIDE_MIN=820` / `MASTER_W`）、判定は `lib/useSplitLayout.js:53`。
- 2 ペインは**レビュータブとタスクタブだけ**（`ReviewPane.jsx:1150,1240` / `TasksPane.jsx:803,1104`）。**チャットタブは 1 カラムのみ**（`ChatPane.jsx` に `useSplitLayout` の import が無い）。
- チャットの縦の積み方（全幅時・上から）: `.chat-head`（`ChatPane.jsx:1945` — プロファイル／リポジトリのチップを含む・幅が狭いと 2〜3 行に折り返す）→ オフライン `.banner` → `.chat-report-banner` → `ArchitectJobBar`（`:2459`）→ `SpecReadyBanner`（`:2479`）→ `.chat-body`（`:2080`・ここだけスクロール）→ `.action-bar`（`:2498`・定型チップ帯）→ `.composer`（`:2536`）。
- セッション一覧は **ドロワーの `Sheet`**（`ChatPane.jsx:2895`）で、中身は `ChatPane` の JSX に直書き。2 カラム化には一覧の抽出が要る。

### 1.2 メモ

- 一覧は自動列で**表示切替 UI が無い**: `styles.css:6316-6320` の `repeat(auto-fill, minmax(165px, 1fr))`、グリッドは `MemosPane.jsx:384`。
- 本文は **5 行 clamp**（`styles.css:6373-6381`）。**カード全体の高さ上限は無い** — チェックリスト・タグ・操作行で伸びる（`MemosPane.jsx:388-455`）。
- 検索行は `MemosPane.jsx:323-331`、フィルタチップは `:334-356`、カード操作行は `:430-449`（ブレスト `:431` / 仕様策定 `:434` / 会話を開く `:440`）、ピン留めは `:397`。
- 編集シートは `onClose={() => setEditing(null)}` で**無条件に閉じる**（`MemosPane.jsx:458`）。新規作成も同じ経路（`openEditor` の `id: null` 分岐・`:179-188`）。`Sheet`（`components/Ui.jsx:193`）は**背景タップ・✕・端末の戻る**の 3 経路すべてで `onClose` を呼ぶので、ガードは `onClose` 1 箇所で足りる。

### 1.3 注釈とドット

- 注釈シートを開くたび `setNewTarget('')` で対象リポを捨てる（`ReviewPane.jsx:930` の初期値、`:1252-1255` のボタン）。`initialTarget` は `/api/review/targets` の **`path`** としか照合していない（`ReviewPane.jsx:719-724, 749-751`）。targets の実体は `{id, label, path}`（`apps/bridge/src/review.js:1331-1343`）。
- 直前を残す部品は既にある: `lib/repoPicker.js:16` の `hm.repo`、`:81` の `readLastRepo`、`:133` の `rememberRepo`。**repo id を保存している**（`:138`）。
- `.working-dot` は `styles.css:1352-1360`、アニメは `:1361-1369`（`opacity` 1→0.45 と `box-shadow` を同時に動かす）。他タブの `.dot.running` は `styles.css:903-907`（`--accent` ベタ＋淡いリングのみ）。

---

## 2. 設計

### 2.1 基盤（注釈の対象リポ・ドット）

- `lib/repoPicker.js` に `REVIEW_REPO_KEY = 'hm.reviewRepo'`、`readReviewRepo(storage)`（`hm.reviewRepo` → `hm.repo` → `''` の順）、`rememberReviewRepo(storage, id)` を追加。既存 3 関数の契約は変えない。
- `ReviewPane.jsx`:
  - `newTarget` の初期値を `readReviewRepo()` にする。
  - `NewAnnotationSheet` の照合を **id か path**（小文字比較）に広げる（`:719-724` と `:749-751` の 2 箇所・同じ規則）。これで `hm.repo`（id）と `ReadOnlyDetail` の `onStartAnnotation(t)`（path）が両方そのまま効く。
  - 新規注釈ボタン（`:1252-1255`）の `setNewTarget('')` を廃止し、シートで target が確定したら `rememberReviewRepo(storage, selectedTarget.id)` を書く。
- `styles.css` の `hm-working-pulse` から `opacity` を外す。0%/50%/100% は `box-shadow` のリング半径と不透明度だけで動かす（色 `rgba(45, 212, 191, …)` と背景 `var(--accent)` は固定）。`.dot.running` と同じ見え方に揃える。

### 2.2 メモ表示（3 モード・上限・⋯・未保存）

- 新規 `lib/memoView.js`: `MEMOS_VIEW_KEY = 'hm.memosView'`、`VIEWS = ['one','two','list']`、`parseMemosView(raw)`（未知・欠損は `'two'`）、`rememberMemosView(storage, v)`。純関数（storage は引数）。
- `MemosPane.jsx`:
  - `view` state（初期 `parseMemosView(localStorage.getItem('hm.memosView'))`）。検索行の右端に `.memos-view-seg` の 3 ボタン（`1` / `2` / `☰`、`aria-pressed`、`aria-label` は i18n）。切替時に `rememberMemosView`。
  - `.memos-grid` に `view-${view}` クラス。`view-two` のとき、チェックリストは `slice(0, 3)` ＋ `+N` 行（`t('notes.moreItems', { n })`、タップで編集ドロワーを開く）。
  - 編集シート: `baseline`（開いた時点の `{title, body, tagsText, color, pinned, checklist}` の JSON）と `confirming` state。`Sheet onClose={requestClose}` にし、dirty のときだけ 3 択を出す。3 択はシート本文の**インライン**（Sheet を重ねない）。
- 新規 `lib/memoDraft.js`: `isDraftDirty(current, baseline)` — 新規は `title || body || checklist.length`、既存は 6 フィールドの JSON 比較。
- `styles.css`: `.memos-search-row` を flex（input `flex:1; min-width:0` ＋ セグメント `flex:none`）、`.memos-view-seg`、`view-two` は `repeat(2, minmax(0,1fr))`、`view-two .memo-card { height: 220px; overflow: hidden }`、`view-two .memo-card-body { -webkit-line-clamp: 4 }`、`.memo-card-actions { margin-top: auto }`、`view-list` は 1 列の行レイアウト（本文 1 行 clamp・操作は `⋯`）。
- `⋯` メニュー: ボタン 1 個（`t('notes.more')`）→ `Sheet`（タイトル = メモ名）に 4 行（ピン留め/解除・🧠 ブレスト・📝 仕様策定・💬 元チャット＝`chatId` がある時だけ）。一列・二列では従来のボタン列を残す（`⋯` はリスト表示のときだけ出す）。

### 2.3 チャット 2 カラム

- `ChatPane.jsx` に `useSplitLayout()` を入れ、**`wide`（820px 以上）のときだけ** `div.pane.chat.split-layout` で 2 カラムにする。境界値は `lib/layout.js` の 820 を再利用し、**新しい `@media` を増やさない**（`web/test/layoutBreakpoints.test.js` が集合一致を機械で見ている）。
- 左カラム `.chat-split-master`（幅は `--split-master-w` を流用・チャットは 380px）: 上 = セッション一覧、下端 = 固定スタック。一覧は現ドロワー（`ChatPane.jsx:2895-`）の中身を `ChatSessionList` として抽出し、1 ペインの `Sheet` と 2 ペインの左カラムで共用する（行の見た目・バッジ・未読は現行のまま）。
- 左カラム下端の固定スタック（上から Q1 の言う順）: バナー群（`.banner` / `.chat-report-banner` / `ArchitectJobBar` / `SpecReadyBanner`）→ インジケーターチップ（`.prof-chip` / `.prof-chip.repo-chip`）→ 定型チップ帯（`.action-bar`）→ 入力欄（`.composer` / `.composer-ro`）。
- 右カラム `.chat-split-detail`: 最小ヘッダ（タイトル・↻・＋だけ）＋ `.chat-body`。**バナー・チップ・スニペット帯・入力欄は置かない**（＝右の縦を全部タイムラインに使う）。
- 1 ペイン（820px 未満）は現状不変: `.chat-head` に全部載り、一覧はドロワー。
- 新規 `lib/chatSplit.js`: `chatSplitChrome()` が左へ移す 4 グループの名前を返す純関数（テストの唯一の正本にし、JSX とテストで二重管理しない）。

### 2.4 検証

- `npm run verify` が全件パスすること（`test` → `check:dashboard` → `check:pwa` → `check:oauth` → `build` → `audit:responsive`）。
- `scripts/audit-responsive.mjs` の既存 viewport に `820x1180` と `1180x820` を**足さず**（すでにある場合）、**タブ別チェック**として「メモタブ: 二列カードの高さが 220px」「チャットタブ（2 ペイン）: `.chat-body` 以外の高さが ≤ ヘッダ 1 行」を追加する。足りなければ viewport を追加してよいが、違反 0 で exit 0 を維持する。
- スクショ 2 枚を `shots/` に残す（`820x1180` メモ二列 / `1180x820` チャット 2 カラム）。

---

## 3. バッチ（依存順・すべて Zero-Stop）

### Batch ver-0-2-1-1: 基盤 — 注釈の対象リポ記憶と実行中ドットの色抜け

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: 注釈シートを開くたび対象リポが空に戻る／実行中ドットが暗い面で黒く見える、という 2 つの既知の不具合を事実で決めた設計どおり直す（§2.1）。
- **変更・新規ファイル**:
  - `apps/web/src/lib/repoPicker.js`（`REVIEW_REPO_KEY` / `readReviewRepo` / `rememberReviewRepo` 追加）
  - `apps/web/src/features/ReviewPane.jsx`（`newTarget` の初期値・`initialTarget` の id/path 照合 2 箇所・確定時の記憶）
  - `apps/web/src/styles.css`（`hm-working-pulse` から `opacity` を除去）
  - 新規 `apps/web/test/reviewRepoMemory.test.js`、新規 `apps/web/test/workingDot.test.js`
- **受入条件（Verify）**:
  - `npm run verify` が exit 0
  - `readReviewRepo` が `hm.reviewRepo` → `hm.repo` → `''` の順に落ちる（両キーあり／片方だけ／どちらも無しの 3 ケース）
  - `styles.css` の `@keyframes hm-working-pulse` ブロックに `opacity` が 1 回も出現しない（`workingDot.test.js`）

### Batch ver-0-2-1-2: メモ表示 3 モード切替と二列カードの上限

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: 検索行の右端に 1/2/☰ のセグメントを置き、既定=二列・端末保存で切り替えられるようにする。二列ではカードを高さ 220px・本文 4 行・チェックリスト 3 件＋`+N` に切り、行の下端を揃える（Q2=A / Q4=A）。
- **変更・新規ファイル**:
  - 新規 `apps/web/src/lib/memoView.js`（`MEMOS_VIEW_KEY` / `parseMemosView` / `rememberMemosView`）
  - `apps/web/src/features/MemosPane.jsx`（`view` state・セグメント・`view-*` クラス・二列のチェックリスト 3 件＋`+N`）
  - `apps/web/src/styles.css`（`.memos-view-seg` / `view-two` の 2 列・220px・clamp 4 / `view-list` の行レイアウト）
  - `apps/web/src/i18n/ja.json` / `en.json`（`notes.viewOne` / `viewTwo` / `viewList` / `moreItems`）
  - 新規 `apps/web/test/memosView.test.js`
- **受入条件（Verify）**:
  - `npm run verify` が exit 0
  - `parseMemosView` が `'one'|'two'|'list'` を通し、未知・欠損は `'two'` を返す
  - `styles.css` に `.memos-grid.view-two` の 2 列・`.view-two .memo-card` の `height: 220px`・`.view-two .memo-card-body` の `-webkit-line-clamp: 4` が揃って存在する（`memosView.test.js`）
  - 390px 幅で検索入力が潰れない（`min-width: 0` と `flex: 1`）

### Batch ver-0-2-1-3: メモ編集シートの未保存確認

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: 編集シートを未保存で閉じたとき、変更があるときだけ「保存する／破棄する／戻る」の 3 択を出し、誤タップで入力を失わない（Q3=A）。
- **変更・新規ファイル**:
  - 新規 `apps/web/src/lib/memoDraft.js`（`isDraftDirty(current, baseline)`）
  - `apps/web/src/features/MemosPane.jsx`（`baseline`・`confirming`・`requestClose`・シート内 3 択）
  - `apps/web/src/i18n/ja.json` / `en.json`（`notes.unsavedTitle` / `saveAndClose` / `discard` / `keepEditing`）
  - 新規 `apps/web/test/memoDraft.test.js`
- **受入条件（Verify）**:
  - `npm run verify` が exit 0
  - 未変更で閉じると確認なしで閉じる／変更ありで 3 択が出る／「戻る」で入力が残る／「破棄する」で入力が消える（`memoDraft.test.js` が純関数で 6 ケース）
  - 新規メモは本文 1 文字以上（またはチェックリスト 1 件以上）で dirty と判定される

### Batch ver-0-2-1-4: リスト表示の ⋯ メニュー

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: リスト表示で 1 行に収めるため、カードの 3 ボタン＋ピン留めを `⋯` の 1 メニューに畳む（§2.2）。一列・二列の見た目は変えない。
- **変更・新規ファイル**:
  - `apps/web/src/features/MemosPane.jsx`（`⋯` ボタン・`Sheet` メニュー・`view-list` のときだけボタン列を隠す）
  - `apps/web/src/styles.css`（リスト行の 1 行レイアウト・`⋯` の 44px タップ領域）
  - `apps/web/src/i18n/ja.json` / `en.json`（`notes.more` / `notes.menuTitle`）
  - 新規 `apps/web/test/memosListMenu.test.js`
- **受入条件（Verify）**:
  - `npm run verify` が exit 0
  - リスト表示のメニューに「ピン留め/解除・ブレスト・仕様策定・元チャット」が揃い、`chatId` が無いメモでは元チャット行が出ない
  - 一列・二列では従来のボタン列が残る（`⋯` を出さない）

### Batch ver-0-2-1-5: タブレット横持ちのチャット 2 カラム

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: 820px 以上のチャットタブを「左 = セッション一覧＋下端スタック／右 = タイムラインだけ」の 2 カラムにし、右カラムの上部 3 段を本文へ回す（Q1=A・§2.3）。
- **変更・新規ファイル**:
  - 新規 `apps/web/src/lib/chatSplit.js`（`chatSplitChrome()`）
  - `apps/web/src/features/ChatPane.jsx`（`useSplitLayout`・ドロワー一覧の `ChatSessionList` 抽出・2 カラム分岐・右は最小ヘッダ＋`.chat-body`）
  - `apps/web/src/styles.css`（`.pane.chat.split-layout` / `.chat-split-master` / `.chat-split-detail` / 下端スタックの固定。820px の既存ブロック内に置く）
  - 新規 `apps/web/test/chatSplit.test.js`
- **受入条件（Verify）**:
  - `npm run verify` が exit 0（`audit:responsive` の違反 0 を維持）
  - `ChatPane` が `wide` のときだけ 2 カラムになる（1 ペインは DOM 順も見た目も不変）
  - 右カラムにバナー・チップ・スニペット帯・入力欄が 1 つも出ない（`chatSplit.test.js` + JSX 検査）
  - 新しい `@media (min-width: …)` を 1 本も足していない（`layoutBreakpoints.test.js` が緑のまま）

### Batch ver-0-2-1-6: 実測検証とスクショ

- **Execution Mode**: `[Mode: Zero-Stop]`
- **Recommended Role**: `role:builder`
- **目的**: 変更を機械で測り直し、目視用のスクショ 2 枚を残す（§2.4）。
- **変更・新規ファイル**:
  - `scripts/audit-responsive.mjs`（メモ二列のカード高 220px・チャット 2 カラムの右カラム構成のチェック）
  - `shots/ver-0-2-1-memos-820x1180.png` / `shots/ver-0-2-1-chat-1180x820.png`
  - `docs/SPEC-ver-0-2-1.md`（実測値をこの節に追記＝「未検証」を残さない）
- **受入条件（Verify）**:
  - `npm run verify` が exit 0（`audit:responsive` 0 違反）
  - スクショ 2 枚が存在し、1 枚目にメモ二列のカードが 2 列、2 枚目に左一覧＋右タイムラインが見える
  - この SPEC の §1 に「実測後の値」追記がある

---

## 4. やらないこと（今回のスコープ外）

- レビュータブの 2 ペイン再編（§0.2）。左カラム下端への入力移動は**チャットだけ**。
- メモカードへの削除ボタン追加（現状カードに無い）。
- three-dot をポップオーバーで出すこと（`Sheet` で足りる。位置決めの座標バグを持ち込まない）。
- `styles.css` の px → rem 一括変換、フォントスケール（別件・211 箇所）。
- 本番デプロイ（`npm run deploy`）と `git push`。バッチ完了は**ローカル commit まで**。
