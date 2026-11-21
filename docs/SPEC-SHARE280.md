# SPEC: 完了レシートのシェア文を「X 換算 280」に収める（share280）

- **Status**: archived
- **アーカイブ日**: 2026-11-21（COH-4・全バッチ完了済み。以後は参照用に保持し、新規起票の対象外）

対象: `~/Projects/hermes-mobile-pwa`（`apps/web` の `lib/receiptCanvas.js`）
決定: 赤ペンシート `spec-share280-01` round 1（回答は `plugin-data/hermes-pilot/review/sheets/spec-share280-01-1.answer.json`）
起票先: board `hermes-pilot`（実体はこのリポジトリ）

---

## 0. 決定（人が選んだもの・変更不可）

- **Q1 = A**: **280 ちょうどまで使う**。予算は 280、余白は持たない（270/240 にしない）。
- **Q2 = A**: **行ごと落とす**。落とす順は **フッター → 人の手数 → 節約見込 → 所要時間の併記**（末尾を `…` で切る案・1 行に圧縮する案は採らない）。数値は 1 つも落とさない。
- **Q3 = B**: **残数カウンタは出さない**。→ `MissionReceiptSheet.jsx` の UI は**変更しない**（「📏 276 / 280」の行は足さない）。
- **Q4 = A**: **JA と EN の両方**。規則は 1 本、両言語が同じ経路を通る。

---

## 1. 実測（2026-11-15 16:39 PST・`apps/web/test/receipt.test.js` の固定データを node 実行）

### 1.1 X の数え方（先に固定する）

X（twitter-text）の weightedLength: **既定 2**、次の符号位置だけ **1**:
`U+0000–U+10FF` / `U+2000–U+200D` / `U+2010–U+201F` / `U+2032–U+2037`。

したがって `🏆`（U+1F3C6）= 2、`·`（U+00B7）= 1、`—`（U+2014）= 1、`（`（U+FF08）= 2。改行 = 1。

**シートに出した「JA 312 / EN 291」は `—` を 2 と数えた測り方**。上の規則どおりだと **JA 310 / EN 289**（差 2 = L1 と L5 の `—` 各 1 個）。行別の差も同じ理由で L1・L5 が 1 ずつ小さい（27→26 / 35→34、EN 43→42 / 30→29）。**どちらの数え方でも 280 を超えるので決定は変わらない。** 以後この SPEC の数字は規則どおりの値で書く。

### 1.2 行別（base = test の固定データ）

| | L1 見出し | L2 KPI | L3 コスト | L4 人の手数 | L5 フッター | 改行 4 | 合計 | 見た目 |
|---|---|---|---|---|---|---|---|---|
| JA | 26 | 117 | 63 | 66 | 34 | 4 | **310** | 224 |
| EN | 42 | 96 | 52 | 66 | 29 | 4 | **289** | 276 |

現行 `buildShareText()` はこの 5 行を**制限なく**連結しているだけ（`receiptCanvas.js:204-232` の末尾 `[line1..line5].join('\n')`）。

### 1.3 落とす段の実測（base / 数字を大きくした receipt / 極端な見出し）

| 入力 | 言語 | 開始 | −L5 | −L4 | −L3 | −所要時間 | 見出しを詰める | 確定 |
|---|---|---|---|---|---|---|---|---|
| base | JA | 310 | **275** | — | — | — | — | 275・4 行 |
| base | EN | 289 | **259** | — | — | — | — | 259・4 行 |
| big（数字を大きく） | JA | 343 | 308 | **227** | — | — | — | 227・3 行 |
| big | EN | 322 | 292 | **211** | — | — | — | 211・3 行 |
| 見出し 120 字 | JA | 455 | 420 | 339 | **270** | — | — | 270・2 行 |
| 極端（見出し 400 字） | JA | 735 | 700 | 619 | 550 | 530 | **280** | 280・2 行 |

「−所要時間」= L2 の ` (経過 1 時間 35 分)` / ` (wall 1h 35m)` の併記だけを外す（数値は残る）。
「見出しを詰める」= L1 の末尾（＝レポート名）を符号位置単位で `…` 付きに詰める。実データでは 3 段目までで必ず収まる。

### 1.4 既存テストの当たり

- `apps/web/test/receipt.test.js:189-190` が base fixture の **5 行**を固定している（`en.split('\n').length === 5` / `ja` も同様）。→ **JA/EN とも 4 行になるのでここは落ちる。置換必須。**
- `apps/web/test/receipt.test.js:193-198`（欠損値でも 5 行・`—` を出す）は、空 receipt が **JA 245 / EN 233** で 5 行のまま収まるので**そのまま緑**。
- それ以外の `buildShareText` の検査（数値・語彙・経過時間の併記）は行数を見ていないので影響なし。

---

## 2. 設計

### 2.1 新規 `apps/web/src/lib/shareBudget.js`（純関数・DOM 非依存）

```js
export const X_WEIGHT_LIMIT = 280

/** X の加重長（§1.1 の規則） */
export function xWeight(text): number

/** 末尾を符号位置単位で削り、`…` の 2 加重を含めて budget 以下にする（必ず <= budget） */
export function truncateToWeight(text, budget, ellipsis = '…'): string

/**
 * blocks を joiner で連結した加重が limit 以下になるまで steps を順に適用する。
 * 各 step は「まだ超過しているときだけ」適用し、収まったら残りは適用しない。
 * 落とした block は空行を残さず消す（filter(Boolean)）。
 * @returns {{ text: string, applied: number[] }} applied = 実際に適用した step の index
 */
export function fitBlocks(blocks, { limit = X_WEIGHT_LIMIT, joiner = '\n', steps = [] } = {})
```

step の形は 4 種だけ:

- `{ drop: i }` … blocks[i] を落とす
- `{ set: [i, text] }` … blocks[i] を差し替える（空文字なら実質「親を外す」）
- `{ truncate: i }` … blocks[i] の末尾を `…` 付きで詰める（残り block の加重を引いた残予算で）
- `{ cutAt: [i, sep] }` … blocks[i] を `sep` の最後の出現より前で切り落とす

### 2.2 `buildShareText()` の変更（`apps/web/src/lib/receiptCanvas.js:204-232`）

- 5 行を組み立てたあと `fitBlocks()` に通す。**戻り値は今までどおり `string`**（呼び出し側 `MissionReceiptSheet.jsx:143/199` は無変更・diff 0）。
- `line2` は **2 版**作る（所要時間の併記あり／なし）。両方 `tr()` 由来なので文言は i18n のまま。
- steps はこの 6 段・この順で固定:

```js
const steps = [
  { drop: 4 },                      // フッター
  { drop: 3 },                      // 人の手数
  { drop: 2 },                      // 節約見込（コスト・キャッシュも一緒に落ちる＝「行ごと」の決定どおり）
  { set: [1, line2NoWall] },        // 所要時間の併記だけ外す（数値は残る）
  { truncate: 0 },                  // 見出し（レポート名）を … で詰める
  { cutAt: [0, ' — '] },            // それでも駄目なら見出しごと落とす
]
```

- `opts` に `limit`（既定 `X_WEIGHT_LIMIT`）を受けられるようにする（テストで 80 など極小値も試すため）。
- i18n キーの追加・変更は**なし**（`receipt.share.*` は現行のまま。Q3=B なのでカウンタ用キーも作らない）。

### 2.3 触らないもの

- `MissionReceiptSheet.jsx`（Q3=B）。コピー／共有の経路、`receipt.shareNote` の文言も不変。
- `drawReceipt()`（PNG は 1200×630 の枠内の別問題。シェア文とは独立）。
- URL: シェア文に URL は入らない。将来 URL を入れる場合、X は URL を 23 加重固定で数えるので `xWeight()` は過大評価になる（付録 A）。

---

## 3. バッチ（board `hermes-pilot` / assignee `mobile` / 直列）

| # | 内容 | 主な変更 | 従属 |
|---|---|---|---|
| 1 | 予算関数の土台 | `apps/web/src/lib/shareBudget.js`(新), `apps/web/test/shareBudget.test.js`(新) | — |
| 2 | `buildShareText` に適用 | `apps/web/src/lib/receiptCanvas.js`, `apps/web/test/receipt.test.js` | 1 |
| 3 | 性質テストで再発防止 | `apps/web/test/receipt.test.js` | 2 |

直列にする理由: 2 が 1 の API を使い、3 が 2 の戻り値（行数・`applied`）を検査する。並列にすると同じテストファイルを 2 枚が触る。

### Batch SHARE280-1 — 予算関数の土台

- **Execution Mode**: `[Mode: Zero-Stop]`（止まらず commit まで）
- **目的**: 280 の数え方と「収める」手続きを 1 ファイルに固定し、`receiptCanvas.js` を触らずに検証できる状態にする。
- **変更・新規ファイル**:
  - 新規 `apps/web/src/lib/shareBudget.js` … `X_WEIGHT_LIMIT` / `xWeight()` / `truncateToWeight()` / `fitBlocks()`
  - 新規 `apps/web/test/shareBudget.test.js`
- **受入条件（Verify）**: `node --test apps/web/test/shareBudget.test.js` が **0 fail**。少なくとも
  - `xWeight('🏆 完了レシート — V5 batch') === 26`、`xWeight('—') === 1`、`xWeight('（') === 2`、`xWeight('🏆') === 2`
  - `xWeight` が base fixture の 5 行連結で **310（JA）/ 289（EN）**
  - `truncateToWeight` は返り値が**必ず `<= budget`**、切ったときは `…` で終わる、`budget` が十分なら原文のまま
  - `fitBlocks` が `{drop}` / `{set}` / `{truncate}` / `{cutAt}` を期待順に適用し、**収まった段で止まる**（`applied` で確認）、落とした block は空行を残さない

### Batch SHARE280-2 — `buildShareText` に適用

- **Execution Mode**: `[Mode: Zero-Stop]`
- **目的**: コピー／共有される文字列を、JA/EN とも X 換算 280 以下にする（§1.3 の段どおり）。
- **変更・新規ファイル**:
  - `apps/web/src/lib/receiptCanvas.js` … `buildShareText()` のみ（`fitBlocks` を import、`line2NoWall` を追加、6 段の steps）
  - `apps/web/test/receipt.test.js` … `:189-190` の「5 行固定」を新契約（`<= 280`・4〜5 行・落ちた行の順序）へ置換
- **受入条件（Verify）**: `npm test` が **0 fail**、かつ実測が §1.3 と一致:
  - base JA = **275 / 4 行**、base EN = **259 / 4 行**
  - big JA = **227 / 3 行**、big EN = **211 / 3 行**
  - 空 receipt（`{kpi:{}}`）は **JA 245 / EN 233 の 5 行のまま**（`:193-198` が無変更で緑）
  - `MissionReceiptSheet.jsx` は **diff 0**（Q3=B）

### Batch SHARE280-3 — 性質テストで再発防止

- **Execution Mode**: `[Mode: Zero-Stop]`
- **目的**: KPI や語彙を将来増やしたときに 280 超過が**テストで**止まるようにする（カウンタを出さない決定の代わり）。
- **変更・新規ファイル**: `apps/web/test/receipt.test.js`（性質テストを追加。`big` / 長い見出し / 極端な見出しの fixture を足す）
- **受入条件（Verify）**: `npm run verify` が緑。加えて全 12 通り（base・big・見出し 120 字・見出し 400 字 × JA/EN）で
  - `xWeight(buildShareText(r, {lang})) <= 280`
  - **数値が 1 つも落ちていない**: `kpiValue()` の各値と `receiptBatches()` が確定文字列に含まれる
  - 行数が 2〜5、**末尾に空行なし**、`\n\n` が無い
  - `applied` が想定順（base = `[0]`、big = `[0,1]`、見出し 400 字 = `[0,1,2,3,4]`）

---

## 4. 検証（共通）

- `npm run verify`（= `npm test` + `check:pwa` + `check:oauth` + `build` + `audit:responsive`）が緑。
- ベースライン実測（2026-11-15 16:39 PST）: `npm test` = **717 tests / 0 fail / 2.3 s**。
- 画面は変わらない（Q3=B で UI 追加なし・シェア文はクリップボード／共有シートにだけ出る）ので、**スクリーンショットは撮らない**。確認は文字列の実測（`xWeight` と行数）で行う。

---

## 5. 起票（この SPEC では起票しない）

本文の指示どおり、**バッチの起票はしない**。人が「File batches & start」を押したときに、§3 の 3 枚を board `hermes-pilot` / assignee `mobile` で**直列**に起票する（1 → 2 → 3）。

---

## 6. 付録

### A. 数え方の限界

- URL は X 側で 23 加重固定。`xWeight()` は文字どおり数えるので、URL を含む文では過大評価になる（現在のシェア文に URL は無い）。
- 絵文字の ZWJ 連結（👨‍👩‍👧 など）は X が 1 個ぶんに畳む場合がある。本 SPEC の絵文字は単体（🏆 ✅ ⏱ 🧪 🔌 🪙 💰 💎 ✨ 👆 🖊 ⌨️）なので影響なし。
- 上限 280 は X の現行仕様。**X が上限を変えたら `X_WEIGHT_LIMIT` の 1 箇所だけ**を直す（Q1=A の代償として受け入れた点）。

### B. 実測の再現

`node` で `apps/web/src/lib/receiptCanvas.js` を直接 import し、`receipt.test.js` の固定データを渡して
`buildShareText(r, { lang })` を 1 行ずつ `xWeight()` に通す（§1 の表はこの方法で採取）。§1.3 の段は
`fitBlocks` 相当を 1 段ずつ適用して採取した。実装後は `shareBudget.xWeight` をそのまま使える。
