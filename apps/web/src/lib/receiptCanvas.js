/**
 * 完了レシート（`🏆 Completion Receipt Card`）の描画・共有ロジック（SPEC-PILOT-V5 §3.3 ③ / D26③）。
 *
 * React にも DOM にも依存しない純関数だけを置く（`apps/web/test/receipt.test.js` の対象）:
 *  - `receiptKpis()`    … 画面と PNG が **同じラベル・同じ値** を使うための唯一の定義
 *  - `buildShareText()` … EN / JA のシェア文（X 投稿用）
 *  - `drawReceipt()`    … 1200×630 のデザイン空間へ描く（ctx は 2D コンテキスト互換なら何でもよい）
 *  - `receiptFilename()` … 保存ファイル名
 *
 * 実体の `<canvas>` 生成・`toBlob`・`navigator.share` は `MissionReceiptSheet.jsx` 側。
 */

import { fmtCost, fmtNumber } from './format.js'
import { X_WEIGHT_LIMIT, fitBlocks } from './shareBudget.js'
import { translate } from '../i18n/lang.js'

/** デザイン空間の幅（px）。 */
export const RECEIPT_W = 1200

/** デザイン空間の高さ（px）。 */
export const RECEIPT_H = 630

/** PNG の書き出し倍率（Retina。1200×630 の等倍へ縮小して保存する）。 */
export const RECEIPT_SCALE = 2

/** 画面・PNG 共通の KPI 定義（順序がそのまま表示順・`4×2` の 8 項目）。 */
export const KPI_KEYS = ['cost', 'cache', 'saved', 'zeroTyping', 'tests', 'duration', 'apiCalls', 'totalTokens']

/** KPI タイルの列数（1200px 幅で `4×2`）。 */
export const KPI_COLUMNS = 4

/**
 * トークン数の短縮表記（`950` / `480K` / `1.2M`）。レシートの狭いタイルに収めるため、
 * `format.js` の `fmtTokens` より 1 桁短く丸める。
 * @param {number} n トークン数
 * @returns {string} 表示値
 */
export function fmtTokenShort(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0) return '0'
  if (v >= 1e6) {
    const m = v / 1e6
    return `${m >= 100 ? Math.round(m) : Math.round(m * 10) / 10}M`
  }
  if (v >= 1e3) return `${Math.round(v / 1e3)}K`
  return String(Math.round(v))
}

/**
 * 表示言語つきの翻訳。`lang` を省くと現在の言語。
 * @param {string|undefined} lang `en` / `ja`
 * @param {string} key 辞書キー
 * @param {object} [vars] 差し込み
 * @returns {string} 訳文（辞書に無ければキー）
 */
function tr(lang, key, vars) {
  return translate(lang, key, vars)
}

/**
 * KPI 1 つぶんの表示値。`null` は「—」に落とす（空データでも崩れない）。
 * @param {string} key KPI キー
 * @param {object} receipt API 応答
 * @param {string} [lang] 言語
 * @returns {string} 表示値
 */
export function kpiValue(key, receipt, lang) {
  const k = receipt?.kpi ?? {}
  const na = tr(lang, 'receipt.value.na')
  switch (key) {
    case 'cost':
      return k.costUsd === null || k.costUsd === undefined ? na : fmtCost(k.costUsd)
    case 'cache':
      return k.cachePct === null || k.cachePct === undefined ? na : `${fmtNumber(k.cachePct, { maximumFractionDigits: 1 })}%`
    case 'saved':
      return k.savedUsd === null || k.savedUsd === undefined ? na : `~${fmtCost(k.savedUsd)}`
    case 'zeroTyping':
      return k.zeroTypingScore === null || k.zeroTypingScore === undefined
        ? na
        : `${fmtNumber(k.zeroTypingScore, { maximumFractionDigits: 0 })}%`
    case 'tests':
      return k.tests === null || k.tests === undefined ? na : fmtNumber(k.tests, { maximumFractionDigits: 0 })
    case 'duration':
      if (k.durationMin === null || k.durationMin === undefined) return na
      // 窓の開始で切り上げた（＝窓より前に始まった作業を含む）ときは「24h 以上」と出す
      if (k.durationCapped) return tr(lang, 'receipt.value.over', { h: fmtNumber(receipt?.windowHours ?? 24, { maximumFractionDigits: 0 }) })
      if (Number(k.durationMin) >= 60) {
        return tr(lang, 'receipt.value.hours', {
          h: fmtNumber(Math.floor(Number(k.durationMin) / 60), { maximumFractionDigits: 0 }),
          m: fmtNumber(Math.round(Number(k.durationMin) % 60), { maximumFractionDigits: 0 }),
        })
      }
      return tr(lang, 'receipt.value.min', { min: fmtNumber(k.durationMin, { maximumFractionDigits: 0 }) })
    case 'apiCalls':
      return k.apiCalls === null || k.apiCalls === undefined
        ? na
        : tr(lang, 'receipt.value.calls', { n: fmtNumber(k.apiCalls, { maximumFractionDigits: 0 }) })
    case 'totalTokens':
      return k.totalTokens === null || k.totalTokens === undefined ? na : fmtTokenShort(k.totalTokens)
    default:
      return na
  }
}

/**
 * 分を「42 分」「1 時間 2 分」へ整形する（キャップ表現なしの素の整形）。
 * 所要時間の主指標と経過時間の併記で同じ書式を使う。
 *
 * @param {number|null|undefined} min 分
 * @param {string} [lang] 言語
 * @returns {string|null} 表示値（算出不能なら null）
 */
export function durationLabel(min, lang) {
  if (min === null || min === undefined) return null
  const v = Number(min)
  if (!Number.isFinite(v) || v <= 0) return null
  if (v >= 60) {
    return tr(lang, 'receipt.value.hours', {
      h: fmtNumber(Math.floor(v / 60), { maximumFractionDigits: 0 }),
      m: fmtNumber(Math.round(v % 60), { maximumFractionDigits: 0 }),
    })
  }
  return tr(lang, 'receipt.value.min', { min: fmtNumber(v, { maximumFractionDigits: 0 }) })
}

/**
 * 画面と PNG が共有する KPI タイル一覧。
 *
 * ラベルは `receipt.kpi.<key>`（辞書）から引く。JSX 側もこの関数だけを使うので、
 * **画面・PNG・シェア文のラベルが必ず一致する**（`receipt.test.js` で固定）。
 *
 * @param {object} receipt `/api/telemetry/receipt` の応答
 * @param {string} [lang] 言語
 * @returns {Array<{key: string, label: string, value: string, note: string}>} タイル
 */
export function receiptKpis(receipt, lang) {
  const k = receipt?.kpi ?? {}
  return KPI_KEYS.map((key) => ({
    key,
    label: tr(lang, `receipt.kpi.${key}`),
    value: kpiValue(key, receipt, lang),
    // 節約額・ゼロタイピング・スコープ集計は「概算・範囲」であることを添える。
    // 欠損（—）のタイルは理由を出す（空欄を「壊れている」と読ませない）。
    note:
      key === 'saved' && k.savedUsd !== null && k.savedUsd !== undefined
        ? tr(lang, 'receipt.kpi.savedNote', { pct: Math.round((k.savedRatio ?? 0.9) * 100) })
        : key === 'zeroTyping' && k.zeroTypingScore !== null && k.zeroTypingScore !== undefined
          ? tr(lang, 'receipt.kpi.zeroTypingNote')
          : key === 'duration' && (k.durationMin === null || k.durationMin === undefined)
            ? tr(lang, 'receipt.kpi.durationNote', { hours: receipt?.windowHours ?? 24 })
            : key === 'duration' && durationLabel(k.wallDurationMin, lang)
              ? tr(lang, 'receipt.kpi.wallNote', { wall: durationLabel(k.wallDurationMin, lang) })
              : key === 'tests' && (k.tests === null || k.tests === undefined)
                ? tr(lang, 'receipt.kpi.testsNote')
                : key === 'apiCalls' && (k.apiCalls === null || k.apiCalls === undefined)
                  ? tr(lang, 'receipt.kpi.apiCallsNote')
                  : key === 'apiCalls'
                    ? tr(lang, 'receipt.kpi.apiCallsScope')
                    : key === 'totalTokens' && (k.totalTokens === null || k.totalTokens === undefined)
                      ? tr(lang, 'receipt.kpi.totalTokensNote')
                      : key === 'totalTokens'
                        ? tr(lang, 'receipt.kpi.totalTokensScope')
                        : '',
  }))
}

/**
 * レシートの見出し（レポート名 / ボード名 / Spec パスの順で採用）。
 * @param {object} receipt API 応答
 * @returns {string} 見出し
 */
export function receiptHeading(receipt) {
  const label = String(receipt?.label ?? '').trim()
  if (label) return label
  const board = String(receipt?.board ?? '').trim()
  if (board) return board
  const spec = String(receipt?.spec ?? '').trim()
  return spec || '—'
}

/**
 * バッチ進捗の表示（`4/5`）。総数が無ければ `null`。
 * @param {object} receipt API 応答
 * @returns {string|null} 進捗
 */
export function receiptBatches(receipt) {
  const k = receipt?.kpi ?? {}
  const total = Number(k.batchesTotal)
  const done = Number(k.batchesDone)
  if (!Number.isFinite(done) || done <= 0) return null
  if (!Number.isFinite(total) || total <= 0) return String(done)
  return `${done}/${total}`
}

/**
 * X（Twitter）などへ貼るシェア文。EN / JA で生成する。
 *
 * 数値は `kpiValue()` と同じ整形を使うので、画面・PNG・シェア文でブレない。
 * `null` の項目は「—」で残す（行ごと消すとレイアウトが不安定になるため）。
 *
 * 出来上がった 5 行は `fitBlocks()` に通し、X の加重長（`X_WEIGHT_LIMIT` = 280）に収める。
 * 落とす順は SPEC-SHARE280 §2.2 で固定（フッター → 人の手数 → 節約見込 → 所要時間の併記 →
 * 見出しを `…` で詰める → 見出しごと落とす）。**数値は 1 つも落とさない。**
 *
 * @param {object} receipt API 応答
 * @param {{lang?: string, limit?: number}} [opts] 言語と予算（既定 `X_WEIGHT_LIMIT`）
 * @returns {string} 複数行のシェア文
 */
export function buildShareText(receipt, opts = {}) {
  return buildShareTextDetailed(receipt, opts).text
}

/**
 * `buildShareText()` の計画つき版（テストが「どの段で収まったか」を検査するために使う）。
 * 戻り値の `text` は `buildShareText()` と完全に同じ文字列。
 *
 * @param {object} receipt API 応答
 * @param {{lang?: string, limit?: number}} [opts] 言語と予算
 * @returns {{text: string, applied: number[]}} 確定したシェア文と適用した段の index
 */
export function buildShareTextDetailed(receipt, opts = {}) {
  const lang = opts.lang
  const k = receipt?.kpi ?? {}
  const done = Number(k.batchesDone) || 0
  const total = Number(k.batchesTotal) || done
  const batches = receiptBatches(receipt) ?? '—'
  const batchesText = tr(lang, 'receipt.share.batches', { batches, done, total })
  const line1 = `🏆 ${tr(lang, 'receipt.share.title')} — ${receiptHeading(receipt)}`
  const wall = durationLabel(k.wallDurationMin, lang)
  const wallPart = wall ? ` (${tr(lang, 'receipt.share.wall', { wall })})` : ''
  const line2With = (withWall) =>
    [
      `✅ ${batchesText}`,
      `⏱ ${kpiValue('duration', receipt, lang)}${withWall ? wallPart : ''}`,
      `🧪 ${kpiValue('tests', receipt, lang)} ${tr(lang, 'receipt.share.testsSuffix')}`,
      `🔌 ${kpiValue('apiCalls', receipt, lang)}`,
      `🪙 ${kpiValue('totalTokens', receipt, lang)} ${tr(lang, 'receipt.share.tokensSuffix')}`,
    ].join(' · ')
  const line2 = line2With(true)
  const line2NoWall = line2With(false)
  const line3 = `💰 ${kpiValue('cost', receipt, lang)} · 💎 ${kpiValue('cache', receipt, lang)} ${tr(
    lang,
    'receipt.share.cacheSuffix',
  )} · ✨ ${kpiValue('saved', receipt, lang)} ${tr(lang, 'receipt.share.savedSuffix')}`
  const line4 = `👆 ${fmtNumber(k.humanTaps ?? 0)} ${tr(lang, 'receipt.share.tapsSuffix')} · 🖊 ${fmtNumber(
    k.redlines ?? 0,
  )} ${tr(lang, 'receipt.share.redlinesSuffix')} · ⌨️ ${fmtNumber(k.typedChars ?? 0)} ${tr(
    lang,
    'receipt.share.typedSuffix',
  )} · ${kpiValue('zeroTyping', receipt, lang)} ${tr(lang, 'receipt.share.zeroSuffix')}`
  const line5 = tr(lang, 'receipt.share.footer')

  // 6 段・この順で固定（SPEC-SHARE280 §2.2 / D45）。収まった段で止まる。
  const steps = [
    { drop: 4 }, // フッター
    { drop: 3 }, // 人の手数
    { drop: 2 }, // 節約見込（コスト・キャッシュも一緒に落ちる＝「行ごと」の決定どおり）
    { set: [1, line2NoWall] }, // 所要時間の併記だけ外す（数値は残る）
    { truncate: 0 }, // 見出し（レポート名）を … で詰める
    { cutAt: [0, ' — '] }, // それでも駄目なら見出しごと落とす
  ]
  const limit = Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : X_WEIGHT_LIMIT
  return fitBlocks([line1, line2, line3, line4, line5], { limit, steps })
}

/**
 * 保存ファイル名（`hermes-pilot-receipt-20261115-1234.png`）。
 * @param {object} receipt API 応答
 * @param {number} [at] epoch ms
 * @returns {string} ファイル名
 */
export function receiptFilename(receipt, at) {
  const d = new Date(Number(receipt?.generatedAt) || Number(at) || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
  const board = String(receipt?.board ?? 'pilot')
    .replace(/[^a-z0-9-]/gi, '')
    .slice(0, 24)
  return `hermes-pilot-receipt-${board || 'pilot'}-${stamp}.png`
}

/**
 * 角丸矩形のパスを作る（`ctx.roundRect` は Safari 16 未満に無いので自前で組む）。
 * @param {object} ctx 2D コンテキスト互換
 * @param {number} x 左上X
 * @param {number} y 左上Y
 * @param {number} w 幅
 * @param {number} h 高さ
 * @param {number} r 角半径
 */
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.arcTo(x + w, y, x + w, y + rr, rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr)
  ctx.lineTo(x + rr, y + h)
  ctx.arcTo(x, y + h, x, y + h - rr, rr)
  ctx.lineTo(x, y + rr)
  ctx.arcTo(x, y, x + rr, y, rr)
  ctx.closePath()
}

/**
 * 幅に収まるよう切り詰める（`measureText` が無い環境では文字数で概算）。
 * @param {object} ctx 2D コンテキスト互換
 * @param {string} text 文字列
 * @param {number} maxWidth 最大幅
 * @returns {string} 収めた文字列
 */
function fitText(ctx, text, maxWidth) {
  const s = String(text ?? '')
  if (!s) return ''
  const measure = typeof ctx.measureText === 'function' ? (v) => Number(ctx.measureText(v)?.width ?? 0) : null
  if (!measure) return s.length * 8 <= maxWidth ? s : `${s.slice(0, Math.max(1, Math.floor(maxWidth / 8) - 1))}…`
  if (measure(s) <= maxWidth) return s
  let lo = 1
  let hi = s.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measure(`${s.slice(0, mid)}…`) <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return `${s.slice(0, lo)}…`
}

/**
 * 1200×630 のデザイン空間へレシートを描く。
 *
 * - `dopamine`: ダークティール + ゴールドのホログラム調シマー枠（SSR バッジ）
 * - `serotonin`: 端正なモノスペース調の監査カード
 *
 * 呼び出し側は `ctx.scale(RECEIPT_SCALE, RECEIPT_SCALE)` 済みでも未スケールでもよい
 * （この関数は 1200×630 の座標系で描く前提。テストはスタブ ctx で呼ぶ）。
 *
 * @param {object} ctx 2D コンテキスト互換（`fillText` / `measureText` 等）
 * @param {object} receipt API 応答
 * @param {{lang?: string, vibe?: string}} [opts] 言語と Vibe
 * @returns {{width: number, height: number, kpis: Array<object>}} 描画結果の要約
 */
export function drawReceipt(ctx, receipt, opts = {}) {
  const lang = opts.lang
  const vibe = opts.vibe === 'serotonin' ? 'serotonin' : 'dopamine'
  const dopamine = vibe === 'dopamine'
  const W = RECEIPT_W
  const H = RECEIPT_H
  const kpis = receiptKpis(receipt, lang)

  // 背景（グラデーションが無いスタブでも動くよう単色へフォールバック）
  const bgFrom = dopamine ? '#06202a' : '#14161c'
  const bgTo = dopamine ? '#0b3440' : '#1b1e26'
  let fill = bgTo
  if (typeof ctx.createLinearGradient === 'function') {
    const g = ctx.createLinearGradient(0, 0, W, H)
    g.addColorStop(0, bgFrom)
    g.addColorStop(1, bgTo)
    fill = g
  }
  ctx.fillStyle = fill
  ctx.fillRect(0, 0, W, H)

  // 枠（Dopamine はゴールド、Serotonin は控えめな線）
  ctx.lineWidth = 3
  ctx.strokeStyle = dopamine ? '#e8c47a' : '#3a3f4b'
  roundRectPath(ctx, 24, 24, W - 48, H - 48, 26)
  ctx.stroke()

  const text = (value, x, y, { font, color, align = 'left', maxWidth } = {}) => {
    ctx.font = font
    ctx.fillStyle = color
    ctx.textAlign = align
    ctx.fillText(maxWidth ? fitText(ctx, value, maxWidth) : String(value ?? ''), x, y)
  }

  const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace'
  const sans = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif'
  const head = dopamine ? sans : mono

  // バッジ
  const badge = dopamine ? 'SSR' : tr(lang, 'receipt.badge.audit')
  roundRectPath(ctx, 60, 62, dopamine ? 92 : 168, 34, 17)
  ctx.fillStyle = dopamine ? 'rgba(232,196,122,0.18)' : 'rgba(255,255,255,0.08)'
  ctx.fill()
  text(badge, 60 + (dopamine ? 46 : 84), 86, {
    font: `600 17px ${mono}`,
    color: dopamine ? '#e8c47a' : '#c9ced8',
    align: 'center',
  })

  // 見出し
  text(dopamine ? tr(lang, 'receipt.canvas.titleDopamine') : tr(lang, 'receipt.canvas.titleSerotonin'), 60, 158, {
    font: `700 42px ${head}`,
    color: '#ffffff',
    maxWidth: W - 120,
  })

  // レポート名 / Spec パス
  text(receiptHeading(receipt), 60, 200, {
    font: `500 24px ${sans}`,
    color: dopamine ? '#8fe3d6' : '#aab2c0',
    maxWidth: W - 120,
  })
  const meta = [
    receipt?.spec ? String(receipt.spec) : null,
    tr(lang, 'receipt.canvas.window', { hours: receipt?.windowHours ?? 24 }),
    receiptBatches(receipt) ? tr(lang, 'receipt.canvas.batches', { batches: receiptBatches(receipt) }) : null,
  ]
    .filter(Boolean)
    .join('  ·  ')
  text(meta, 60, 236, { font: `400 18px ${mono}`, color: '#8b95a5', maxWidth: W - 120 })

  // KPI タイル（4 列 × 2 行 = 8 項目）
  const gap = 20
  const cols = KPI_COLUMNS
  const tileW = (W - 120 - gap * (cols - 1)) / cols
  const tileH = 128
  const top = 272
  kpis.forEach((k, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const x = 60 + col * (tileW + gap)
    const y = top + row * (tileH + gap)
    roundRectPath(ctx, x, y, tileW, tileH, 18)
    ctx.fillStyle = dopamine ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.04)'
    ctx.fill()
    ctx.strokeStyle = dopamine ? 'rgba(232,196,122,0.32)' : 'rgba(255,255,255,0.14)'
    ctx.lineWidth = 1.5
    ctx.stroke()
    text(k.label, x + 18, y + 34, {
      font: `500 15px ${sans}`,
      color: '#93a0b1',
      maxWidth: tileW - 36,
    })
    text(k.value, x + 18, y + 86, {
      font: `700 32px ${dopamine ? sans : mono}`,
      color: dopamine ? '#ffd98a' : '#f2f5fa',
      maxWidth: tileW - 36,
    })
  })

  // フッター
  text(tr(lang, 'receipt.canvas.footer'), 60, H - 54, {
    font: `400 18px ${mono}`,
    color: '#7d8798',
    maxWidth: W - 120,
  })
  text(tr(lang, 'receipt.canvas.size'), W - 60, H - 54, {
    font: `400 16px ${mono}`,
    color: '#5f6a7b',
    align: 'right',
  })

  return { width: W, height: H, kpis }
}
