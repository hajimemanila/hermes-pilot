import test from 'node:test'
import assert from 'node:assert/strict'
import {
  KPI_KEYS,
  RECEIPT_H,
  RECEIPT_SCALE,
  RECEIPT_W,
  buildShareText,
  buildShareTextDetailed,
  drawReceipt,
  fmtTokenShort,
  kpiValue,
  receiptBatches,
  receiptFilename,
  receiptHeading,
  receiptKpis,
} from '../src/lib/receiptCanvas.js'
import { X_WEIGHT_LIMIT, xWeight } from '../src/lib/shareBudget.js'
import { translate } from '../src/i18n/lang.js'

/** 実 API 応答に近い固定データ（`/api/telemetry/receipt`）。 */
const receipt = {
  ok: true,
  generatedAt: Date.parse('2026-11-15T12:34:00+08:00'),
  board: 'hermes-pilot',
  spec: 'docs/SPEC-PILOT-V5.md',
  label: 'V5 batch',
  windowHours: 24,
  status: 'done',
  kpi: {
    costUsd: 1.08,
    cacheHitRate: 0.994,
    cachePct: 99,
    savedUsd: 3.25,
    savedRatio: 0.9,
    inputTokens: 12000,
    outputTokens: 8000,
    cacheReadTokens: 16000000,
    toolCalls: 120,
    sessions: 4,
    humanTaps: 34,
    redlines: 2,
    typedChars: 0,
    zeroTypingScore: 100,
    batchesDone: 5,
    batchesTotal: 5,
    durationMin: 62,
    activeDurationMin: 62,
    wallDurationMin: 95,
    durationCapped: false,
    apiCalls: 128,
    totalTokens: 12448000,
    tests: 402,
    pwaChecks: 12,
  },
  scope: {
    scoped: true,
    taskIds: ['a', 'b'],
    batchIds: ['V5-1', 'V5-2'],
    tasks: 5,
    intervals: 3,
    usage: { sessionIds: 4, sinceMs: null, untilMs: null, fallback: false },
    usageScoped: true,
  },
  missing: [],
}

/**
 * 描画呼び出しを記録するだけの 2D コンテキスト互換スタブ。
 * `drawReceipt()` が DOM に触れていないことの証明にもなる（ノードだけで動く）。
 */
function fakeCtx() {
  const calls = []
  return {
    calls,
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    textAlign: 'left',
    beginPath() {
      calls.push({ op: 'beginPath' })
    },
    moveTo(x, y) {
      calls.push({ op: 'moveTo', x, y })
    },
    lineTo(x, y) {
      calls.push({ op: 'lineTo', x, y })
    },
    arcTo(x1, y1, x2, y2, r) {
      calls.push({ op: 'arcTo', x: x1, y: y1, x2, y2, r })
    },
    closePath() {
      calls.push({ op: 'closePath' })
    },
    fill() {
      calls.push({ op: 'fill' })
    },
    stroke() {
      calls.push({ op: 'stroke' })
    },
    fillRect(x, y, w, h) {
      calls.push({ op: 'fillRect', x, y, w, h })
    },
    fillText(text, x, y) {
      calls.push({ op: 'fillText', text: String(text), x, y })
    },
    measureText(text) {
      return { width: String(text).length * 9 }
    },
    createLinearGradient() {
      return { addColorStop() {} }
    },
  }
}

test('receiptKpis は辞書のラベルだけを使い、価格/キャッシュ/ゼロタイピングを整形する', () => {
  for (const lang of ['en', 'ja']) {
    const kpis = receiptKpis(receipt, lang)
    assert.equal(kpis.length, KPI_KEYS.length)
    assert.equal(KPI_KEYS.length, 8, '4×2 の 8 KPI')
    assert.deepEqual(kpis.map((k) => k.key), KPI_KEYS)
    for (const k of kpis) assert.equal(k.label, translate(lang, `receipt.kpi.${k.key}`), '画面とPNGでラベルが一致する')
    const by = Object.fromEntries(kpis.map((k) => [k.key, k]))
    assert.equal(by.cost.value, '$1.08')
    assert.equal(by.cache.value, '99%')
    assert.equal(by.saved.value, '~$3.25')
    assert.equal(by.zeroTyping.value, '100%')
    assert.equal(by.tests.value, '402')
    assert.equal(by.duration.value, lang === 'ja' ? '1 時間 2 分' : '1h 2m', '60 分以上は時間＋分で出す')
    assert.equal(by.apiCalls.value, lang === 'ja' ? '128 回' : '128 calls')
    assert.equal(by.totalTokens.value, '12.4M', 'トークンは 1.2M / 480K / 950 の短縮表記')
    assert.match(by.saved.note, /90%/, '節約額には概算の根拠（割引率）を添える')
    assert.match(by.duration.note, lang === 'ja' ? /経過/ : /wall/, '所要時間には経過時間を併記する')
    assert.equal(by.apiCalls.note, translate(lang, 'receipt.kpi.apiCallsScope'), 'スコープの注記が付く')
    assert.equal(by.totalTokens.note, translate(lang, 'receipt.kpi.totalTokensScope'))
  }
})

test('kpiValue はトークンを 950 / 480K / 1.2M の 3 段で短縮する', () => {
  assert.equal(fmtTokenShort(950), '950')
  assert.equal(fmtTokenShort(480_000), '480K')
  assert.equal(fmtTokenShort(1_240_000), '1.2M')
  assert.equal(fmtTokenShort(12_400_000), '12.4M')
  assert.equal(fmtTokenShort(0), '0')
  assert.equal(kpiValue('totalTokens', { kpi: { totalTokens: 950 } }, 'en'), '950')
  assert.equal(kpiValue('apiCalls', { kpi: { apiCalls: 0 } }, 'en'), '0 calls', '0 は — ではなく 0 と出す')
})

test('receiptKpis は空データでも「—」で崩れない', () => {
  const kpis = receiptKpis({ ok: true, kpi: {} }, 'en')
  for (const k of kpis) assert.equal(k.value, '—')
  assert.equal(kpiValue('unknown', {}, 'en'), '—')
  assert.deepEqual(receiptKpis(null, 'ja').map((k) => k.value), ['—', '—', '—', '—', '—', '—', '—', '—'])
  // 欠損タイルは理由を出す（空欄を「壊れている」と読ませない）
  const by = Object.fromEntries(kpis.map((k) => [k.key, k]))
  assert.equal(by.apiCalls.note, translate('en', 'receipt.kpi.apiCallsNote'))
  assert.equal(by.totalTokens.note, translate('en', 'receipt.kpi.totalTokensNote'))
  assert.equal(by.duration.note, translate('en', 'receipt.kpi.durationNote', { hours: 24 }))
})

test('buildShareText は EN / JA で必要な数値とラベルを含む', () => {
  const en = buildShareText(receipt, { lang: 'en' })
  const ja = buildShareText(receipt, { lang: 'ja' })

  // 見出しと作成元（レポート名 → ボード → Spec の順）
  assert.match(en, /🏆 Autonomous execution summary — V5 batch/)
  assert.match(ja, /🏆 完了レシート — V5 batch/)
  assert.equal(receiptHeading(receipt), 'V5 batch')
  assert.equal(receiptHeading({ board: 'mobile' }), 'mobile')
  assert.equal(receiptHeading({}), '—')

  // 数字は画面と同じ整形を通る（KPI とシェア文でブレない）
  for (const text of [en, ja]) {
    assert.ok(text.includes(kpiValue('cost', receipt, 'en')), 'コスト表記が一致する')
    assert.ok(text.includes(kpiValue('cache', receipt, 'en')), 'キャッシュ率が一致する')
    assert.ok(text.includes('402'), 'テスト合格件数')
    assert.ok(text.includes('34'), 'タップ数')
    assert.ok(text.includes('100%'), 'ゼロタイピング度')
    assert.ok(text.includes('5/5'), 'バッチ進捗')
    assert.ok(text.includes(kpiValue('apiCalls', receipt, 'en')) || text.includes('128'), 'API コール数')
    assert.ok(text.includes('12.4M'), 'トークン数')
    assert.ok(text.includes('1 時間 35 分') || text.includes('1h 35m'), '経過時間も併記する')
  }

  // 言語ごとの語彙（EN に日本語が混ざらない / JA は日本語のラベル）
  assert.equal(en.includes('タスク'), false)
  assert.equal(en.includes('tests'), true)
  assert.equal(ja.includes('タスク完了'), true)
  assert.equal(ja.includes('赤入れ'), true)

  // X の加重 280 に収めるためフッター（5 行目）だけが落ちる（SPEC-SHARE280 §0 Q1=A/Q2=A）
  assert.equal(xWeight(ja), 275, 'JA は 275 加重（280 ちょうどまで使う）')
  assert.equal(xWeight(en), 259, 'EN は 259 加重')
  assert.equal(ja.split('\n').length, 4, 'JA は 4 行（フッターが落ちる）')
  assert.equal(en.split('\n').length, 4, 'EN は 4 行')
  assert.equal(ja.includes(translate('ja', 'receipt.share.footer')), false, '落ちるのはフッターだけ')
  assert.ok(xWeight(ja) <= X_WEIGHT_LIMIT && xWeight(en) <= X_WEIGHT_LIMIT)
})

test('buildShareText は欠損値でも行数を保つ（— を出す）', () => {
  const text = buildShareText({ kpi: {} }, { lang: 'en' })
  assert.equal(text.split('\n').length, 5)
  assert.match(text, /—/)
  assert.equal(buildShareText(null, { lang: 'ja' }).split('\n').length, 5)
  // 空 receipt は 5 行のまま 280 に収まる（段が 1 つも要らない）
  assert.equal(xWeight(buildShareText({ kpi: {} }, { lang: 'ja' })), 245)
  assert.equal(xWeight(buildShareText({ kpi: {} }, { lang: 'en' })), 233)
})

/** 数値を大きくした fixture（実データの上限側。SPEC-SHARE280 §1.3 の `big` と同じ実測になる）。 */
const bigReceipt = {
  ...receipt,
  label: 'V9 batch',
  kpi: {
    ...receipt.kpi,
    costUsd: 1084.4,
    cachePct: 99.9,
    savedUsd: 325.75,
    humanTaps: 1234567,
    redlines: 1234,
    typedChars: 12345678,
    zeroTypingScore: 98,
    batchesDone: 9,
    batchesTotal: 9,
    durationMin: 125,
    wallDurationMin: 190,
    apiCalls: 12345678,
    totalTokens: 124480000,
    tests: 4021234,
  },
}

/** 見出しだけを伸ばした fixture（120 字 / 400 字）。 */
const heading120 = { ...receipt, label: 'A'.repeat(120) }
const heading400 = { ...receipt, label: 'X'.repeat(400) }

/**
 * 全 12 通り（6 fixture × JA/EN）。`applied` は SPEC-SHARE280 §2.2 の 6 段の index。
 * - 0 = フッター落とし / 1 = 人の手数 / 2 = 節約見込 / 3 = 所要時間の併記を外す /
 *   4 = 見出しを … で詰める / 5 = 見出しごと落とす
 */
const SHARE_PATTERNS = [
  ['base', receipt, { ja: [0], en: [0] }],
  ['big', bigReceipt, { ja: [0, 1], en: [0, 1] }],
  ['heading120', heading120, { ja: [0, 1, 2], en: [0, 1, 2] }],
  ['heading400', heading400, { ja: [0, 1, 2, 3, 4], en: [0, 1, 2, 3, 4] }],
  ['empty', { kpi: {} }, { ja: [], en: [] }],
  ['null', null, { ja: [], en: [] }],
]

/** KPI が載っている行（blocks の index）。1 = KPI 行 / 2 = コスト行 / 3 = 人の手数。 */
const KPI_BLOCK = { duration: 1, tests: 1, apiCalls: 1, totalTokens: 1, cost: 2, cache: 2, saved: 2, zeroTyping: 3 }
/** 段 index → 落とす blocks[index]（set / truncate / cutAt は行を落とさない）。 */
const DROPPED_BLOCK = { 0: 4, 1: 3, 2: 2 }

test('buildShareText は 12 通りすべてで X 加重 280 以下・2〜5 行・数値を行ごとだけ落とす', () => {
  for (const [name, r, expectedApplied] of SHARE_PATTERNS) {
    for (const lang of ['ja', 'en']) {
      const { text, applied } = buildShareTextDetailed(r, { lang })
      const lines = text.split('\n')
      const where = `${name}/${lang}`

      // 1. 必ず 280 以下（Q1=A: 280 ちょうどまで使う）
      assert.ok(xWeight(text) <= X_WEIGHT_LIMIT, `${where}: ${xWeight(text)} <= ${X_WEIGHT_LIMIT}`)
      // 2. 段の適用順（収まった段で止まる）
      assert.deepEqual(applied, expectedApplied[lang], `${where}: applied`)
      // 3. 行の形（2〜5 行・空行なし・末尾に空行なし）
      assert.ok(lines.length >= 2 && lines.length <= 5, `${where}: ${lines.length} 行`)
      assert.equal(text.includes('\n\n'), false, `${where}: 空行を残さない`)
      assert.equal(text.endsWith('\n'), false, `${where}: 末尾に空行なし`)
      for (const line of lines) assert.ok(line.trim().length > 0, `${where}: 空の行を作らない`)
      // 4. バッチ進捗は必ず残る（KPI 行より前に落ちる段が無い）
      assert.ok(text.includes(receiptBatches(r) ?? '—'), `${where}: バッチ進捗`)
      // 5. 数値は「行ごと」だけが落ちる（同じ行に載っている KPI は必ず完全な形で残る）
      const dropped = new Set(applied.map((i) => DROPPED_BLOCK[i]).filter((b) => b !== undefined))
      for (const key of KPI_KEYS) {
        const value = kpiValue(key, r, lang)
        if (text.includes(value)) continue
        assert.ok(
          dropped.has(KPI_BLOCK[key]),
          `${where}: ${key} の値 ${value} が行を落とさずに消えた（数値は … で切らない）`,
        )
      }
      // 6. `…` が出るのは見出し（1 行目）の末尾だけ（数値に … を付けない）
      lines.forEach((line, i) => {
        if (!line.includes('…')) return
        assert.equal(i, 0, `${where}: ${i + 1} 行目に … が出た`)
        assert.ok(line.endsWith('…'), `${where}: 見出しの … は末尾`)
      })
      // 7. buildShareText() は同じ文字列を返す（呼び出し側 = MissionReceiptSheet.jsx は無変更）
      assert.equal(buildShareText(r, { lang }), text)
    }
  }
})

test('buildShareText は極端な見出しでも数値の行を壊さず、280 に収める', () => {
  // 400 字の見出し: 見出しを … で詰めて 280 ちょうどにし、KPI 行（2 行目）は無傷で残す
  const ja = buildShareTextDetailed(heading400, { lang: 'ja' })
  assert.equal(xWeight(ja.text), 280)
  const [head, kpiLine] = ja.text.split('\n')
  assert.ok(head.endsWith('…'), '見出しだけを詰める')
  for (const key of ['duration', 'tests', 'apiCalls', 'totalTokens']) {
    assert.ok(kpiLine.includes(kpiValue(key, heading400, 'ja')), `KPI 行の ${key} は無傷`)
  }
  assert.equal(kpiLine.includes('…'), false, '数値の行に … を付けない')

  // 予算を下げられる（テスト用）。base は 200 でも 6 段だけで収まる
  const tight = buildShareText(receipt, { lang: 'en', limit: 200 })
  assert.ok(xWeight(tight) <= 200, 'limit を渡すとその予算で収める')
  assert.equal(tight.includes('\n\n'), false)

  // 6 段で届かない極小予算でも、空行・末尾改行のような壊れ方はしない
  const hopeless = buildShareText(heading400, { lang: 'en', limit: 80 })
  assert.equal(hopeless.includes('\n\n'), false)
  assert.equal(hopeless.endsWith('\n'), false)
})

test('drawReceipt は 1200×630 の枠内だけに描き、KPI を全部載せる（dopamine / serotonin）', () => {
  for (const vibe of ['dopamine', 'serotonin']) {
    for (const lang of ['en', 'ja']) {
      const ctx = fakeCtx()
      const out = drawReceipt(ctx, receipt, { lang, vibe })
      assert.equal(out.width, RECEIPT_W)
      assert.equal(out.height, RECEIPT_H)
      assert.equal(RECEIPT_SCALE, 2)

      const texts = ctx.calls.filter((c) => c.op === 'fillText')
      assert.ok(texts.length >= 6 + KPI_KEYS.length, '見出し + 6 KPI + フッター等')
      for (const t of texts) assert.equal(t.text.includes('undefined'), false, `undefined を描かない: ${t.text}`)
      // KPI の値がすべて描かれている
      for (const k of out.kpis) assert.ok(texts.some((t) => t.text === k.value || t.text.includes(k.value)), `${k.key} の値`)

      // 座標は枠内（はみ出し・NaN が無い）
      for (const c of ctx.calls) {
        for (const key of ['x', 'y', 'x2', 'y2']) {
          if (c[key] === undefined) continue
          assert.ok(Number.isFinite(c[key]), `${c.op}.${key} が数値`)
          assert.ok(c[key] >= -1 && c[key] <= RECEIPT_W + 1, `${c.op}.${key} が枠内 (${c[key]})`)
        }
      }
      // 4×2 のタイル配置: KPI ラベルが 4 列 × 2 行に並ぶ（1200px 幅で欠けない）
      const labelTexts = ctx.calls.filter((c) => {
        if (c.op !== 'fillText') return false
        // 値ではなくラベル（辞書の KPI 名）の座標を見る
        return out.kpis.some((k) => k.label === c.text && c.text !== k.value)
      })
      assert.equal(labelTexts.length, 8, '8 個の KPI ラベルを描く')
      assert.equal(new Set(labelTexts.map((c) => Math.round(c.x))).size, 4, '4 列')
      assert.equal(new Set(labelTexts.map((c) => Math.round(c.y))).size, 2, '2 行')
      for (const c of labelTexts) assert.ok(c.y < RECEIPT_H - 60, 'フッターと重ならない')
      const rect = ctx.calls.find((c) => c.op === 'fillRect')
      assert.deepEqual([rect.x, rect.y, rect.w, rect.h], [0, 0, RECEIPT_W, RECEIPT_H], '背景は全面')

      // Vibe でタイトルが変わる（Dopamine=ホログラム調 / Serotonin=監査サマリ）
      const title = texts.find((t) => t.text === translate(lang, `receipt.canvas.title${vibe === 'dopamine' ? 'Dopamine' : 'Serotonin'}`))
      assert.ok(title, `${vibe} のタイトルを描く`)
    }
  }
})

test('drawReceipt はグラデーション非対応の ctx でも動く（フォールバック）', () => {
  const ctx = fakeCtx()
  delete ctx.createLinearGradient
  delete ctx.measureText
  const out = drawReceipt(ctx, { kpi: {} }, { lang: 'en', vibe: 'dopamine' })
  assert.equal(out.kpis.length, KPI_KEYS.length)
  assert.ok(ctx.calls.some((c) => c.op === 'fillText'))
})

test('drawReceipt は極端に長いラベルでも枠内に収める（…で切る）', () => {
  const ctx = fakeCtx()
  const long = { ...receipt, label: 'VERY-LONG-PIPELINE-LABEL-'.repeat(12) }
  drawReceipt(ctx, long, { lang: 'en', vibe: 'dopamine' })
  const texts = ctx.calls.filter((c) => c.op === 'fillText')
  for (const t of texts) assert.ok(t.text.length <= 200, '切り詰めが効いている')
})

test('receiptFilename はボード名と分単位の時刻で決まる', () => {
  assert.equal(receiptFilename(receipt), 'hermes-pilot-receipt-hermes-pilot-20261115-1234.png')
  assert.match(receiptFilename({ board: 'a b/c' }, Date.parse('2026-01-02T03:04:00+08:00')), /^hermes-pilot-receipt-abc-20260102-0304\.png$/)
  assert.equal(receiptBatches(receipt), '5/5')
  assert.equal(receiptBatches({ kpi: { batchesDone: 3 } }), '3')
  assert.equal(receiptBatches({ kpi: {} }), null)
})
