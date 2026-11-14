/**
 * 軽量・安全 Markdown レンダラの検証（SPEC V3-3 / §3.3 ③）。
 *
 * 見るポイント:
 *  - 全構文（見出し / 太字 / インラインコード / リスト / 引用 / リンク / コードブロック）が崩れない
 *  - 危険スキーム（javascript: / data: / vbscript:）は `<a>` にならない
 *  - コードブロック・インラインコードの中の Markdown 記号は二重変換されない
 *  - HTML 文字列を組み立てない（`<script>` がタグにならずテキストのまま）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SAFE_SCHEMES,
  parseBlocks,
  parseInline,
  renderInline,
  renderMarkdown,
  sanitizeUrl,
} from '../src/lib/markdown.js'

/**
 * React 要素の木から、指定タグの props を集める。
 * @param {any} node React 要素
 * @param {string} tag タグ名
 * @param {Array<object>} [acc] 収集先
 * @returns {Array<object>} props の配列
 */
function findAll(node, tag, acc = []) {
  if (node == null || typeof node !== 'object') return acc
  if (Array.isArray(node)) {
    for (const n of node) findAll(n, tag, acc)
    return acc
  }
  if (node.type === tag) acc.push(node.props)
  findAll(node.props?.children, tag, acc)
  return acc
}

/**
 * 描画結果のテキストを連結する（タグは無視）。
 * @param {any} node React 要素
 * @returns {string} テキスト
 */
function textOf(node) {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node.props) return textOf(node.props.children)
  // findAll は props を返すので、props 形（children を直接持つ）も受ける
  return textOf(node.children)
}

test('sanitizeUrl は http/https/mailto だけ通す', () => {
  assert.deepEqual(SAFE_SCHEMES, ['http:', 'https:', 'mailto:'])
  assert.equal(sanitizeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1')
  assert.equal(sanitizeUrl('http://example.com'), 'http://example.com')
  assert.equal(sanitizeUrl('HTTPS://Example.com/x'), 'HTTPS://Example.com/x')
  assert.equal(sanitizeUrl('mailto:me@example.com'), 'mailto:me@example.com')
})

test('sanitizeUrl は危険スキームと相対/プロトコル相対を拒否する', () => {
  for (const bad of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'java\nscript:alert(1)',
    'java\tscript:alert(1)',
    ' javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '//evil.example.com/x',
    '/relative/path',
    '#anchor',
    '',
    null,
  ]) {
    assert.equal(sanitizeUrl(bad), null, `${JSON.stringify(bad)} は拒否されるべき`)
  }
})

test('parseInline は太字・インラインコード・リンクを順序どおりに解く', () => {
  const toks = parseInline('前 **太字** と `code` と [link](https://example.com) 後')
  assert.equal(toks[0].type, 'text')
  assert.equal(toks[0].value, '前 ')
  assert.equal(toks[1].type, 'strong')
  assert.deepEqual(toks[1].children, [{ type: 'text', value: '太字' }])
  assert.equal(toks[3].type, 'code')
  assert.equal(toks[3].value, 'code')
  assert.equal(toks[5].type, 'link')
  assert.equal(toks[5].href, 'https://example.com')
  assert.deepEqual(toks[5].children, [{ type: 'text', value: 'link' }])
})

test('インラインコード内の Markdown 記号は二重変換されない', () => {
  const toks = parseInline('`**not bold** [no](https://x)`')
  assert.equal(toks.length, 1)
  assert.equal(toks[0].type, 'code')
  assert.equal(toks[0].value, '**not bold** [no](https://x)')
})

test('太字の中のインラインコードは code として解ける', () => {
  const toks = parseInline('**run `npm test` now**')
  assert.equal(toks[0].type, 'strong')
  assert.equal(toks[0].children[0].type, 'text')
  assert.equal(toks[0].children[1].type, 'code')
  assert.equal(toks[0].children[1].value, 'npm test')
})

test('リンクはタイトル付きでも URL を取り出す', () => {
  const toks = parseInline('[d](https://example.com "タイトル")')
  assert.equal(toks[0].type, 'link')
  assert.equal(toks[0].href, 'https://example.com')
})

test('parseBlocks: 見出しは h1〜h3 に収まる', () => {
  const blocks = parseBlocks('# 一\n\n## 二\n\n### 三\n\n#### 四\n')
  assert.deepEqual(
    blocks.map((b) => [b.type, b.level]),
    [
      ['heading', 1],
      ['heading', 2],
      ['heading', 3],
      ['heading', 3],
    ],
  )
  assert.deepEqual(blocks[0].children, [{ type: 'text', value: '一' }])
})

test('parseBlocks: 段落は空行で切れ、行内改行は br になる', () => {
  const blocks = parseBlocks('1行目\n2行目\n\n別段落')
  assert.equal(blocks.length, 2)
  assert.deepEqual(
    blocks[0].children.map((c) => c.type),
    ['text', 'br', 'text'],
  )
  assert.equal(blocks[1].children[0].value, '別段落')
})

test('parseBlocks: 箇条書きと番号リストを分けて拾う', () => {
  const blocks = parseBlocks('- a\n- b\n\n1. one\n2. two')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, 'list')
  assert.equal(blocks[0].ordered, false)
  assert.deepEqual(blocks[0].items.map((i) => i.children[0].value), ['a', 'b'])
  assert.equal(blocks[1].ordered, true)
  assert.deepEqual(blocks[1].items.map((i) => i.children[0].value), ['one', 'two'])
})

test('parseBlocks: 引用は複数行をまとめ、中の要素も解く', () => {
  const blocks = parseBlocks('> 引用1\n> 引用2')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'quote')
  assert.equal(blocks[0].blocks.length, 1)
  assert.equal(blocks[0].blocks[0].type, 'paragraph')
  assert.deepEqual(
    blocks[0].blocks[0].children.filter((c) => c.type === 'text').map((c) => c.value),
    ['引用1', '引用2'],
  )
})

test('parseBlocks: フェンスコードは言語と本文をそのまま保持する', () => {
  const raw = 'まえ\n```js\nconst a = "**x**"\n- not a list\n```\nあと'
  const blocks = parseBlocks(raw)
  assert.equal(blocks.length, 3)
  assert.equal(blocks[1].type, 'code')
  assert.equal(blocks[1].lang, 'js')
  assert.equal(blocks[1].value, 'const a = "**x**"\n- not a list')
})

test('parseBlocks: 閉じ忘れのフェンスも本文として返す（途中経過の描画）', () => {
  const blocks = parseBlocks('```sh\nnpm run verify')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'code')
  assert.equal(blocks[0].lang, 'sh')
  assert.equal(blocks[0].value, 'npm run verify')
})

test('renderMarkdown: 見出し・リスト・引用・コードブロックの DOM が出る', () => {
  const raw = [
    '# 見出し1',
    '',
    '**太字** と `code`',
    '',
    '- item',
    '',
    '> quote',
    '',
    '```js',
    'console.log(1)',
    '```',
  ].join('\n')
  const el = renderMarkdown(raw)
  assert.equal(el.props.className, 'md-body')
  assert.equal(findAll(el, 'h1').length, 1)
  assert.equal(findAll(el, 'ul').length, 1)
  assert.equal(findAll(el, 'blockquote').length, 1)
  assert.equal(findAll(el, 'strong').length, 1)
  assert.equal(findAll(el, 'code').some((p) => p.className === 'md-code'), true)
  assert.equal(findAll(el, 'div').filter((p) => p.className === 'code-block').length, 1)
})

test('renderMarkdown: 安全なリンクは target/rel 付きの <a> になる', () => {
  const el = renderMarkdown('[公式](https://example.com)')
  const anchors = findAll(el, 'a')
  assert.equal(anchors.length, 1)
  assert.equal(anchors[0].href, 'https://example.com')
  assert.equal(anchors[0].target, '_blank')
  assert.equal(anchors[0].rel, 'noopener noreferrer')
  assert.equal(anchors[0].className, 'md-link')
})

test('renderMarkdown: javascript: / data: は <a> にならず平文で残る', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'vbscript:msgbox(1)']) {
    const el = renderMarkdown(`[危険](${href})`)
    assert.equal(findAll(el, 'a').length, 0, `${href} が <a> になっている`)
    const text = textOf(el)
    assert.match(text, /危険/)
    // 何が書かれていたかを隠さない（生 URL を平文で見せる）
    assert.ok(text.includes(href), `${href} が平文に残っていない: ${text}`)
  }
})

test('renderMarkdown: コードブロック内の Markdown 記号は変換されない', () => {
  const el = renderMarkdown('```md\n# not heading\n**not bold**\n- not list\n```')
  assert.equal(findAll(el, 'h1').length, 0)
  assert.equal(findAll(el, 'strong').length, 0)
  assert.equal(findAll(el, 'ul').length, 0)
  const pre = findAll(el, 'pre')[0]
  assert.equal(textOf(pre), '# not heading\n**not bold**\n- not list')
})

test('renderMarkdown: HTML は文字列として組み立てられない（<script> がタグにならない）', () => {
  const el = renderMarkdown('<script>alert(1)</script><img src=x onerror=alert(1)>')
  assert.equal(findAll(el, 'script').length, 0)
  assert.equal(findAll(el, 'img').length, 0)
  assert.match(textOf(el), /<script>alert\(1\)<\/script>/)
})

test('renderMarkdown: コードのコピーボタンが渡した値を返す', () => {
  let copied = null
  const el = renderMarkdown('```py\nprint(1)\n```', { onCopyCode: (v) => (copied = v), copyLabel: 'Copy' })
  const buttons = findAll(el, 'button')
  assert.equal(buttons.length, 1)
  assert.equal(buttons[0].className, 'code-copy')
  assert.equal(textOf(buttons[0]), 'Copy')
  let stopped = false
  buttons[0].onClick({ stopPropagation: () => (stopped = true) })
  assert.equal(stopped, true)
  assert.equal(copied, 'print(1)')
})

test('renderMarkdown: コピー処理が無ければボタンを出さない', () => {
  const el = renderMarkdown('```\nx\n```')
  assert.equal(findAll(el, 'button').length, 0)
})

test('renderInline はインラインコードを md-code にする', () => {
  const nodes = renderInline(parseInline('a `b` c'))
  assert.equal(nodes[1].props.className, 'md-code')
  assert.equal(textOf(nodes[1]), 'b')
})
