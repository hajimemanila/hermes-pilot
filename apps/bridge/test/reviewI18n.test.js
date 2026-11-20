/**
 * 生成物の言語切替ガード（SPEC-i18n-gen §3.6-1）。
 *
 * 生成文（シート HTML・`/view` ラッパー・注入ブリッジ・回答テキスト・worker タスク本文）は
 * 実行時言語 1 か所（`apps/bridge/src/lang.js` の `resolveLang()`）に従う。ここでは
 * **出力そのもの**を検査する（ソースの見た目ではなく、生成された文字列が対象）:
 *
 *  1. `en` の出力に CJK が 1 文字も無い — 直書きの日本語が 1 つ残れば落ちる。
 *     両表記を受けるための互換パターン（旧 `【赤ペン回答】` の受理）は `\u…` の
 *     ASCII エスケープで書く（出力は ASCII のまま、実行時は CJK に一致する）。
 *  2. `ja` の出力は既知の JA ラベルを含む — 片側だけのテストにしない。
 *  3. `HTML_TEXT` のキー集合が `en` / `ja` で一致（訳抜け検出）。
 *  4. 既定引数の逆戻り防止 — `lang` 省略時の出力は `'en'` と同一で、
 *     `review.js` のソースに `lang = 'ja'` が無い（`DEFAULT_LANG` は en）。
 *
 * fixture は ASCII のみ。データ（設問文・選択肢）の日本語と生成文の日本語を混ぜない。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as review from '../src/review.js'
import { buildTaskBody } from '../src/specs.js'

const here = import.meta.dirname
const BRIDGE_SRC = path.join(here, '..', 'src')
const REVIEW_SRC = fs.readFileSync(path.join(BRIDGE_SRC, 'review.js'), 'utf8')

/** CJK（かな・カナ・漢字・全角形・CJK 記号）。生成文に出てはいけない範囲。 */
const CJK = /[\u2e80-\u2fff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff01-\uff60]/

/** 最初の CJK 文字を、周辺 40 文字つきで返す（落ちたときの手がかり）。 */
function cjkSample(text) {
  const m = CJK.exec(text)
  if (!m) return null
  const from = Math.max(0, m.index - 40)
  return `${JSON.stringify(String(text).slice(from, m.index + 40))} (offset ${m.index})`
}

/** ASCII だけのシート（`sheet.json` の形）。 */
const FIXTURE = {
  title: 'Sheet title',
  topic: 'Topic text',
  label: 'demo-01',
  round: 2,
  questions: [
    {
      id: 'q1',
      text: 'Which option should we take?',
      options: [
        { id: 'A', label: 'Option A', detail: 'detail A', recommended: true },
        { id: 'B', label: 'Option B', detail: 'detail B' },
      ],
    },
  ],
}

const AK = { label: 'demo-01', round: 2, target: '/tmp/target-repo' }
const TASK_ID = 't_demo0001'

/** 引数 `lang` を受ける 5 つの生成物（fixture は ASCII のみ）。 */
const GENERATORS = [
  {
    name: 'renderSheetHtmlFromData',
    run: (lang) => review.renderSheetHtmlFromData(FIXTURE, AK, lang),
    jaLabels: ['推奨'],
  },
  {
    name: 'reviewViewHtml',
    run: (lang) => review.reviewViewHtml(TASK_ID, lang),
    jaLabels: ['レビューシート'],
  },
  {
    name: 'injectReviewBridge',
    run: (lang) => review.injectReviewBridge('<html><body></body></html>', TASK_ID, lang),
    jaLabels: ['回答を送信'],
  },
  {
    name: 'toReplyText',
    run: (lang) =>
      review.toReplyText(
        'demo-01',
        [
          { id: 'q1', choice: 'A', note: 'looks right' },
          { id: 'q2', choice: null },
        ],
        'overall note',
        [
          { id: 'q1', text: 'Which option should we take?' },
          { id: 'q2', text: 'Ship it?' },
        ],
        lang,
      ),
    jaLabels: ['【レビュー回答】'],
  },
  {
    name: 'buildTaskBody',
    run: (lang) =>
      buildTaskBody({
        specRelPath: 'docs/SPEC-demo.md',
        repoPath: '/tmp/target-repo',
        board: 'demo',
        batch: {
          id: 'B1',
          title: 'Batch one',
          objective: 'Do the thing.',
          section: 'Body text.\n\n- acceptance criteria',
          mode: 'zero-stop',
        },
        lang,
      }),
    jaLabels: ['## 目的'],
  },
]

test('en の生成物 5 種すべてに CJK が 1 文字も無い', () => {
  for (const gen of GENERATORS) {
    const out = gen.run('en')
    assert.equal(typeof out, 'string')
    assert.ok(out.length > 0, `${gen.name}('en') が空`)
    const sample = cjkSample(out)
    assert.equal(
      sample,
      null,
      `${gen.name}(…, 'en') に日本語が残っています（HTML_TEXT / language-rule を通してください）: ${sample}`,
    )
  }
})

test('ja の生成物 5 種は既知の JA ラベルを含む（片側だけのテストにしない）', () => {
  for (const gen of GENERATORS) {
    const out = gen.run('ja')
    for (const label of gen.jaLabels) {
      assert.ok(out.includes(label), `${gen.name}(…, 'ja') に ${JSON.stringify(label)} が無い`)
    }
  }
})

test('HTML_TEXT のキー集合が en / ja で一致（訳抜け検出）', () => {
  const keysOf = bucketKeysFromSource(REVIEW_SRC, bucketNameFromSource(REVIEW_SRC, 'en'), 'en')
  // まず export されている場合を優先する（表の実体を直接見る方が確実）。
  const table = review.HTML_TEXT
  let enKeys
  let jaKeys
  if (table && typeof table === 'object' && table.en && table.ja) {
    enKeys = Object.keys(table.en).sort()
    jaKeys = Object.keys(table.ja).sort()
  } else {
    enKeys = keysOf
    jaKeys = bucketKeysFromSource(REVIEW_SRC, bucketNameFromSource(REVIEW_SRC, 'ja'), 'ja')
  }
  assert.ok(Array.isArray(enKeys) && enKeys.length > 5, `HTML_TEXT.en のキーが読めない（${enKeys?.length ?? 0} 件）`)
  assert.deepEqual(
    jaKeys,
    enKeys,
    `HTML_TEXT のキー集合が違います（訳抜け）: en だけ ${enKeys.filter((k) => !jaKeys.includes(k)).join(', ') || 'なし'} / ja だけ ${
      jaKeys.filter((k) => !enKeys.includes(k)).join(', ') || 'なし'
    }`,
  )
})

/**
 * `HTML_TEXT` の言語バケット名（`HTML_TEXT = { en: {...}, ja: {...} }` の `en` / `ja`）。
 * 表が export されていない場合のソース解析にだけ使う。
 *
 * @param {string} src `review.js` のソース
 * @param {'en'|'ja'} preferred 期待する名前
 * @returns {string|null} 見つかった名前
 */
function bucketNameFromSource(src, preferred) {
  const start = src.indexOf('const HTML_TEXT')
  if (start < 0) return null
  const head = src.slice(start, start + 200)
  const names = [...head.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*\{/g)].map((m) => m[1])
  if (names.includes(preferred)) return preferred
  return names.find((n) => n !== 'HTML_TEXT') ?? null
}

/**
 * ソース中の `HTML_TEXT.<bucket>` の最上位キーを集める（表が export されていないとき）。
 *
 * @param {string} src `review.js` のソース
 * @param {string|null} bucket バケット名
 * @param {'en'|'ja'} label エラーメッセージ用の名前
 * @returns {string[]} キー（ソート済み）
 */
function bucketKeysFromSource(src, bucket, label) {
  assert.ok(bucket, `HTML_TEXT の ${label} バケットの名前が読めません（const HTML_TEXT = { … } を解析できず）`)
  const start = src.indexOf('const HTML_TEXT')
  assert.ok(start >= 0, 'review.js に `const HTML_TEXT` がありません（§3.2）')
  const hit = new RegExp(`\\b${bucket}\\s*:\\s*\\{`).exec(src.slice(start))
  assert.ok(hit, `HTML_TEXT.${bucket} がありません`)
  let i = start + hit.index + hit[0].length // `{` の直後
  let depth = 1
  const begin = i
  for (; i < src.length && depth > 0; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') depth -= 1
  }
  const body = src.slice(begin, i - 1)
  return [...body.matchAll(/(?:^|[,{])\s*([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1]).sort()
}

test('既定引数が ja に戻っていない（lang 省略時の出力は en と同一）', () => {
  for (const gen of GENERATORS.filter((g) => g.name !== 'buildTaskBody')) {
    assert.equal(
      gen.run(undefined),
      gen.run('en'),
      `${gen.name} の既定 lang が en ではありません（SPEC §3.1: 既定は DEFAULT_LANG = en）`,
    )
  }
  assert.equal(
    buildTaskBody({
      specRelPath: 'docs/SPEC-demo.md',
      repoPath: '/tmp/target-repo',
      board: 'demo',
      batch: { id: 'B1', title: 'Batch one', objective: 'Do the thing.', section: 'Body text.' },
    }),
    buildTaskBody({
      specRelPath: 'docs/SPEC-demo.md',
      repoPath: '/tmp/target-repo',
      board: 'demo',
      batch: { id: 'B1', title: 'Batch one', objective: 'Do the thing.', section: 'Body text.' },
      lang: 'en',
    }),
    'buildTaskBody の既定 lang が en ではありません（§3.5）',
  )
})

test("review.js に `lang = 'ja'` が無い（既定値の逆戻り防止）", () => {
  const bad = /lang\s*=\s*['"`]ja['"`]/.exec(REVIEW_SRC)
  assert.equal(bad, null, `review.js に既定 ja が残っています: ${bad?.[0] ?? ''}（§3.1 / §3.6）`)
  // 機械トークン・機械行は ASCII のまま（カンバンに残る 1 行の言語分岐は両方が存在する）。
  assert.ok(REVIEW_SRC.includes('注釈'), '注釈サマリの ja 分岐が消えています（§3.3）')
  assert.ok(REVIEW_SRC.includes('Annotation'), '注釈サマリの en 分岐がありません（§3.3）')
})
