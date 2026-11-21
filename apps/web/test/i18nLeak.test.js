/**
 * エラー文言の日本語漏れ（静的ガード。SPEC-i18n-resp §2 B5・決定 Q4=A）。
 *
 * 目的: 画面に出る文字列のうち、**辞書を通らない経路**（`message:` / `error:` /
 * `new Error('…')`）に日本語が残っていないことを機械で保証する。ここが漏れると
 * EN 表示のままエラーだけ日本語になる（B2 で潰した穴が再び開く）。
 *
 * 走査対象:
 *  - `apps/bridge/src/*.js`（API 応答の `message` / `error` と、`sendFailure` が
 *    `detail` として素通しする `new Error('…')`）
 *  - `apps/web/src/**`（`message:` で Error を組み立てる箇所）
 *
 * 判定:
 *  1. コメントを除去してから（`test/helpers/stripComments.js` を使う。素朴な正規表現で
 *     落とすと `'https://…'` や正規表現リテラルで壊れて**存在しない違反**を出す・実測）、
 *     `message:` / `error:` / `new Error(` / `throw new Error(` の直後の文字列リテラルを取る
 *  2. その文字列に日本語（ひらがな・カタカナ・漢字）が入っていたら違反
 *  3. `throw Object.assign(new Error('…'), {statusCode})` も `new Error(` として拾う
 *
 * allowlist は**行番号ではなくパターン**で許可する（行がずれても壊れない）。
 * 許可してよいのは運用文・生成物・同梱データだけで、画面に出るエラー文言は不可:
 *  - `runKanban()` に渡す `--reason` / `--summary`（カンバンに残り人と worker が読む）
 *  - シート HTML・spec の生成文（画面辞書ではないが、**`SPEC-i18n-gen` 以降は
 *    `apps/bridge/src/lang.js` の実行時言語に追従する**。日本語が残っていないことは
 *    `reviewI18n.test.js` が出力そのものを検査して固定する。ここでの対象外は
 *    「画面の i18n 辞書を通らない」という意味だけ）
 *  - `term-snippets.js` / `snippets.js` の同梱データ（端末に打ち込む定型文）
 * 逆に、allowlist の項目が 1 件も当たらなくなったら失敗させる（allowlist の腐敗検出）。
 *
 * 末尾の 1 本は**状態判定の言語依存**の静的検査。カンバンの状態は機械マーカー
 * （`[review]` / `[akapen]`）だけで決め、生成側の散文（`注釈:` / `レビュー回答`）の
 * 前方一致では判定しない（SPEC-i18n-gen §3.6-3。散文は en / ja で切り替わるため）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stripComments } from './helpers/stripComments.js'

const here = import.meta.dirname
const REPO = path.join(here, '..', '..', '..')
const BRIDGE = path.join(REPO, 'apps', 'bridge', 'src')
const WEB_SRC = path.join(REPO, 'apps', 'web', 'src')

/** ひらがな・カタカナ・漢字（全角記号は含めない＝記号だけの文は許す）。 */
const JP = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/

/** エラー文言を作る式（この直後のリテラルだけを検査する）。 */
const TRIGGERS = [
  { name: 'message:', re: /\bmessage\s*:\s*/g },
  { name: 'error:', re: /\berror\s*:\s*/g },
  { name: 'new Error(', re: /\bnew\s+Error\s*\(\s*/g },
  { name: 'throw new Error(', re: /\bthrow\s+new\s+Error\s*\(\s*/g },
]

/**
 * allowlist（パターンで許可する。行番号に依存させない）。
 *
 * `file`: 対象ファイルの相対パス（`bridge/…` か `web/…`）
 * `match`: 検出したリテラル（かその一部）に当てる正規表現
 * `why`: 画面に出ないと判断した理由（監査で読む）
 *
 * **許可してよいのは「画面に出ないもの」だけ**（運用文＝`runKanban()` の `--reason` /
 * `--summary`、シート HTML の生成文、同梱データなど）。画面に出るエラー文言は必ず
 * コード化して `err.<CODE>` に移す。
 *
 * 2026-11-15 の実測では該当 0 件（B2 の置換で全箇所がコード化済み）なので空。
 * 将来どうしても許可が必要になったら、行番号ではなくパターンで 1 件ずつ足す
 * （使われなくなった項目はテストが失敗して教える）。
 */
const ALLOW = []

/**
 * ディレクトリ配下の JS/JSX を集める。
 * @param {string} dir 起点
 * @param {string[]} [acc] 蓄積
 * @returns {string[]} 絶対パス
 */
function walk(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(jsx?|mjs)$/.test(name)) acc.push(p)
  }
  return acc
}

/**
 * 指定位置から始まる文字列リテラルを読む（無ければ null）。
 *
 * テンプレートリテラルは `${…}` の中身も含めて 1 つの文字列として扱う
 * （埋め込み式に日本語があれば、それも画面に出る文言なので違反にする）。
 *
 * @param {string} src ソース
 * @param {number} start 開始位置（空白は呼び側で読み飛ばす）
 * @returns {{text: string, quote: string} | null} リテラル
 */
function readLiteral(src, start) {
  const quote = src[start]
  if (quote !== "'" && quote !== '"' && quote !== '`') return null
  let i = start + 1
  let text = ''
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') {
      text += src.slice(i, i + 2)
      i += 2
      continue
    }
    if (c === quote) return { text, quote }
    text += c
    i += 1
  }
  return null
}

/**
 * 1 ファイルから日本語のエラー文言を集める。
 * @param {string} file 絶対パス
 * @param {string} rel `bridge/x.js` 形式の相対名
 * @returns {Array<{rel: string, line: number, trigger: string, text: string}>} 検出
 */
export function findLeaks(file, rel) {
  const source = stripComments(fs.readFileSync(file, 'utf8'))
  /** @type {Map<number, {rel: string, line: number, trigger: string, text: string}>} */
  const byLiteral = new Map()
  for (const { name, re } of TRIGGERS) {
    re.lastIndex = 0
    for (const m of source.matchAll(re)) {
      let i = m.index + m[0].length
      while (i < source.length && /\s/.test(source[i])) i += 1
      const lit = readLiteral(source, i)
      if (!lit) continue
      if (!JP.test(lit.text)) continue
      const line = source.slice(0, m.index).split('\n').length
      const text = lit.text.replace(/\s+/g, ' ').slice(0, 120)
      // `throw new Error('…')` は `new Error(` にも当たる。同じリテラルは 1 回だけ
      // （長いトリガ名＝より具体的な方を残す）
      const prev = byLiteral.get(i)
      if (prev) {
        if (name.length > prev.trigger.length) byLiteral.set(i, { rel, line, trigger: name, text })
        continue
      }
      byLiteral.set(i, { rel, line, trigger: name, text })
    }
  }
  return [...byLiteral.values()]
}

/**
 * 走査対象のファイル一覧（i18n 辞書は対象外＝日本語で当然）。
 * @returns {Array<{file: string, rel: string}>} 対象
 */
function targets() {
  const list = []
  for (const file of fs.readdirSync(BRIDGE).filter((f) => f.endsWith('.js'))) {
    list.push({ file: path.join(BRIDGE, file), rel: `bridge/${file}` })
  }
  for (const file of walk(WEB_SRC)) {
    const rel = `web/${path.relative(WEB_SRC, file).split(path.sep).join('/')}`
    if (rel.startsWith('web/i18n/')) continue
    list.push({ file, rel })
  }
  return list
}

/**
 * 検出結果に allowlist を適用する（純関数・自己検証できるように切り出す）。
 * @param {Array<{rel: string, line: number, trigger: string, text: string}>} hits 検出
 * @param {Array<{file: string, match: RegExp, why: string}>} allow allowlist
 * @returns {{violations: string[], stale: string[]}} 違反と、当たらなかった allowlist 項目
 */
export function classify(hits, allow) {
  const entries = allow.map((a) => ({ ...a, used: 0 }))
  const violations = []
  for (const hit of hits) {
    const entry = entries.find((a) => a.file === hit.rel && a.match.test(hit.text))
    if (entry) {
      entry.used += 1
      continue
    }
    violations.push(`${hit.rel}:${hit.line} ${hit.trigger} '${hit.text}'`)
  }
  const stale = entries.filter((a) => a.used === 0).map((a) => `${a.file} ${a.match}`)
  return { violations, stale }
}

test('message: / error: / new Error() に日本語リテラルが残っていない', () => {
  const all = targets()
  assert.ok(all.length > 20, `走査対象が少なすぎる（${all.length} 件）`)
  const hits = []
  for (const { file, rel } of all) hits.push(...findLeaks(file, rel))
  const { violations, stale } = classify(hits, ALLOW)
  assert.deepEqual(
    violations,
    [],
    `画面に出るエラー文言に日本語が残っています（コード化して i18n の err.<CODE> に移してください）:\n${violations.join('\n')}`,
  )
  // allowlist の腐敗検出（置換して消えた項目を残さない）
  assert.deepEqual(stale, [], `allowlist が当たらなくなっています（対象が消えたら項目も消す）: ${stale.join(', ')}`)
})

test('allowlist は「画面に出ない」ものだけを、理由つきで許可している', () => {
  for (const entry of ALLOW) {
    assert.ok(entry.why && entry.why.trim().length > 8, `${entry.file} の理由が短すぎる（なぜ画面に出ないか書く）`)
    assert.ok(entry.file.startsWith('bridge/') || entry.file.startsWith('web/'), `${entry.file} は rel 形式で書く`)
  }
})

test('allowlist の適用と腐敗検出（機構の自己検証）', () => {
  const hits = [{ rel: 'bridge/review.js', line: 12, trigger: 'message:', text: 'カンバンの応答が空' }]
  const allowed = [{ file: 'bridge/review.js', match: /カンバン/, why: 'runKanban の運用文（画面に出ない）' }]
  assert.deepEqual(classify(hits, allowed), { violations: [], stale: [] }, 'パターン一致で許可される')
  assert.deepEqual(
    classify(hits, [{ file: 'bridge/review.js', match: /シート/, why: '別の生成文' }]).violations,
    ["bridge/review.js:12 message: 'カンバンの応答が空'"],
    'パターンが違えば許可しない',
  )
  assert.deepEqual(
    classify([], [{ file: 'bridge/review.js', match: /カンバン/, why: 'もう当たらない項目' }]).stale,
    ['bridge/review.js /カンバン/'],
    '当たらなくなった allowlist 項目は stale として報告する',
  )
})

test('検出器の自己検証: コメント内と英字だけの文言は違反にしない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18nleak-'))
  try {
    const file = path.join(dir, 'probe.js')
    fs.writeFileSync(
      file,
      [
        "// message: 'コメントなので対象外'",
        "/* error: 'ブロックコメントも対象外' */",
        "const a = { ok: false, message: 'Not found' }",
        "throw new Error('Cannot read repo')",
        "const u = 'https://example.com/ja' // URL の // で壊れない",
        "const b = { ok: false, message: 'タスクがありません' }",
        "throw Object.assign(new Error('保存できません'), { statusCode: 400 })",
      ].join('\n'),
    )
    const hits = findLeaks(file, 'probe.js').map((h) => `${h.trigger} '${h.text}'`)
    assert.deepEqual(
      hits,
      ["message: 'タスクがありません'", "new Error( '保存できません'"],
      '日本語のリテラルだけを 2 件検出する（`throw new Error` の二重計上もしない）',
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 状態判定に使ってはいけない**生成側の散文ラベル**（SPEC-i18n-gen §3.3 / §3.6-3）。
 *
 * 回答サマリ・unblock 理由・注釈サマリは en / ja で切り替わる。カンバンの状態は
 * `[review]` / `[akapen]` の機械マーカーだけで判定する（履歴が混在していても壊れない）。
 */
const STATUS_PROSE = ['注釈[:：]', 'レビュー回答', '赤ペン回答']

/** 状態判定に使う関数呼び出し（この直後のリテラル／正規表現が判定の材料になる）。 */
const DECISION_CALLS = ['startsWith', 'endsWith', 'includes', 'indexOf', 'lastIndexOf', 'test']

/**
 * 「散文ラベルの前方一致で状態を判定している」箇所を集める。
 *
 * 生成（`summary` / `--reason`）で文字列を作るのは自由。禁じるのは
 * **その文字列を読んで状態を決める**こと（`startsWith('注釈:')` など）。
 *
 * @param {string} src ソース（呼び側でコメント除去済み）
 * @param {string} rel `bridge/x.js` 形式の相対名
 * @returns {string[]} 検出（空なら合格）
 */
export function findProseDecisions(src, rel) {
  const out = []
  const calls = DECISION_CALLS.join('|')
  for (const label of STATUS_PROSE) {
    // (a) 呼び出しの引数が散文リテラル: `startsWith('注釈:')`
    const argRe = new RegExp(`(?:${calls})\\s*\\(\\s*(?:['"\`]\\^?【?${label}|\\/\\^?【?${label})`, 'g')
    // (b) 正規表現リテラルをレシーバにする形: `/^注釈:/.test(body)`
    const recvRe = new RegExp(`\\/\\^?【?${label}[^/\\n]*\\/\\s*\\.\\s*(?:test|exec|match)\\s*\\(`, 'g')
    for (const re of [argRe, recvRe]) {
      for (const m of src.matchAll(re)) {
        const line = src.slice(0, m.index).split('\n').length
        out.push(`${rel}:${line} ${m[0].replace(/\s+/g, ' ').trim()}`)
      }
    }
  }
  return [...new Set(out)]
}

test('状態判定に生成側の散文（注釈: / レビュー回答）の前方一致を使っていない', () => {
  const files = [
    ...fs.readdirSync(BRIDGE).filter((f) => f.endsWith('.js')).map((f) => [`bridge/${f}`, path.join(BRIDGE, f)]),
    ...walk(WEB_SRC).map((f) => [`web/${path.relative(WEB_SRC, f).split(path.sep).join('/')}`, f]),
  ]
  assert.ok(files.length > 20, `走査対象が少なすぎる（${files.length} 件）`)
  const hits = []
  for (const [rel, file] of files) hits.push(...findProseDecisions(stripComments(fs.readFileSync(file, 'utf8')), rel))
  assert.deepEqual(
    hits,
    [],
    `状態判定が散文の前方一致に依存しています（機械マーカー [review] / [akapen] で判定してください）:\n${hits.join('\n')}`,
  )
})

test('監視役は生成側の散文を一切見ない（状態は機械マーカーだけ）', () => {
  for (const name of ['review-watcher.js', 'pipeline-watcher.js']) {
    const src = stripComments(fs.readFileSync(path.join(BRIDGE, name), 'utf8'))
    const hit = /注釈[:：]|レビュー回答|赤ペン回答/.exec(src)
    assert.equal(
      hit,
      null,
      `${name} が生成側の散文を見ています（${hit?.[0] ?? ''}）。en / ja で切り替わる文字列は状態判定に使えません`,
    )
  }
})

test('自己検証: findProseDecisions は生成と判定を区別する', () => {
  const gen = stripComments(
    [
      "const summary = `注釈: ${n} ストローク`",
      "await runKanban(['unblock', id, '--reason', '注釈を受領'])",
    ].join('\n'),
  )
  assert.deepEqual(findProseDecisions(gen, 'probe.js'), [], '生成（summary / reason）は違反ではない')

  const judge = stripComments(
    [
      "if (line.startsWith('注釈:')) status = 'ready'",
      "if (text.includes('レビュー回答')) moved = true",
      "if (/^注釈:/.test(body)) return 'annotation'",
      "if (body.startsWith('【赤ペン回答】')) legacy = true",
    ].join('\n'),
  )
  assert.equal(findProseDecisions(judge, 'probe.js').length, 4, '前方一致の判定は 4 件すべて拾う')
})

test('メタ行の区切りは sep() 経由（`・` を直書きしない）', () => {
  // 英語 UI では `·`（U+00B7）を出す。直書きの `・`（U+30FB）は英語画面に日本語記号が残る。
  const roots = ['features', 'components', 'lib']
  const srcDir = path.resolve(import.meta.dirname, '../src')
  const bad = []
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      if (fs.statSync(p).isDirectory()) {
        walk(p)
        continue
      }
      if (!/\.(jsx?|mjs)$/.test(name)) continue
      if (path.basename(p) === 'format.js') continue // `sep()` の定義そのもの
      const src = stripComments(fs.readFileSync(p, 'utf8'))
      for (const m of src.matchAll(/(['"`])((?:(?!\1).)*・(?:(?!\1).)*)\1/g)) {
        bad.push(`${path.relative(srcDir, p)}: ${m[2].slice(0, 40)}`)
      }
    }
  }
  for (const r of roots) {
    const dir = path.join(srcDir, r)
    if (fs.existsSync(dir)) walk(dir)
  }
  assert.deepEqual(bad, [], `sep() を使うこと: ${bad.join(' / ')}`)
})

test('en.json の値に CJK・全角和文記号が残っていない（`settings.languageJa` を除く）', () => {
  // 英語 UI の辞書そのもの。`日本語` というラベルだけは英語画面に「日本語」と出す必要があるので例外。
  // 全角 `＋`（U+FF0B）も `\uff01-\uff60` に入るので、ASCII `+` への正規化をここで固定する。
  const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff01-\uff60]/u
  const dict = JSON.parse(fs.readFileSync(path.join(WEB_SRC, 'i18n', 'en.json'), 'utf8'))
  const entries = Object.entries(dict).filter(([k]) => k !== 'settings.languageJa')
  assert.ok(entries.length > 300, `辞書の読み込みが足りない（${entries.length} 件）`)

  const bad = entries
    .filter(([, v]) => typeof v === 'string' && CJK.test(v))
    .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`)
  assert.deepEqual(bad, [], `en.json に日本語が残っています: \n${bad.join('\n')}`)
})

test('LiveSheet はオフライン/API エラーでも辞書翻訳できる形で保持する', () => {
  // `code` を落とすと `localizeError()` が `err.BAD_REQUEST` に落ち、辞書翻訳（EN/JA）が効かない。
  // 失敗形状の保持と分岐をソースで固定する（SPEC-EN-ZERO-LEAK §3.5 / D74）。
  const live = stripComments(fs.readFileSync(path.join(WEB_SRC, 'features', 'LiveSheet.jsx'), 'utf8'))
  assert.match(live, /code:\s*e\?\.code/, 'catch で code を捨てている')
  assert.match(live, /params:\s*e\?\.params/, 'catch で params を捨てている')
  assert.match(live, /error:\s*e\?\.message/, 'catch で error を捨てている')
  assert.match(
    live,
    /data\.code \|\| data\.error \? localizeError\(data\) : data\.reason \|\| t\('live\.failed'\)/,
    '理由だけ返る経路（/api/live の HTTP 200 失敗）が辞書翻訳に落ちていない',
  )
})
