/**
 * 軽量・安全な Markdown レンダラ（外部依存なし・SPEC V3-3 / §3.3 ③）。
 *
 * 方針:
 *  - 外部パーサを足さない（バンドルサイズを増やさない）
 *  - HTML 文字列を組み立てない（`dangerouslySetInnerHTML` を使わない）ため、本文中の
 *    `<script>` 等は必ずテキストとして描画される = XSS が原理的に起きない
 *  - 危険スキーム（`javascript:` / `data:` / `vbscript:` 等）のリンクは `<a>` にせず平文へ落とす
 *
 * 3 層構成（テストは 1・2 層を直接叩く）:
 *  1. `sanitizeUrl(url)` — 許可スキーム（http / https / mailto）だけ通す
 *  2. `parseBlocks(raw)` / `parseInline(text)` — 純粋なトークナイザ
 *  3. `renderMarkdown(raw, { onCopyCode, copyLabel })` — React 要素へ変換
 *     （`React.createElement` で組み立てるので、この .js は JSX 無しで node --test から読める）
 */

import React from 'react'

/** リンクとして許可するスキーム。 */
export const SAFE_SCHEMES = ['http:', 'https:', 'mailto:']

/** 制御文字・空白・双方向制御（`java\nscript:` のような回避を潰す）。 */
const INVISIBLE = /[\u0000-\u0020\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/g

/**
 * リンク先を検証する。危険・不明スキームは `null`（呼び出し側が平文へ落とす）。
 * @param {unknown} raw 属性に書かれる前の URL
 * @returns {string|null} 安全な URL（不可視文字を除去した形）または null
 */
export function sanitizeUrl(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  // ブラウザは href から改行・タブ・先頭空白を落とすので、判定前にこちらでも落とす
  const probe = s.replace(INVISIBLE, '')
  if (!probe) return null
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(probe)
  // 相対パス・アンカー・プロトコル相対（`//host`）は許可しない:
  // アシスタント本文にその用途は無く、`//` は外部ホストへ飛ぶ書き方になる
  if (!m) return null
  const scheme = `${m[1].toLowerCase()}:`
  if (!SAFE_SCHEMES.includes(scheme)) return null
  return probe
}

const BACKTICK = '`'
// フェンス（``` もしくは ~~~）。バッククォートは定数から組む:
// 正規表現リテラルに生の ` を書くと、コメント除去ベースの日本語検出器が文字列と誤認して
// 以降のソースを丸ごと文字列扱いにしてしまう（apps/web/test/noHardcodedJapanese.test.js）。
const FENCE_RE = new RegExp(`^\\s{0,3}(${BACKTICK}{3,}|~{3,})\\s*([A-Za-z0-9_+#.-]*)\\s*$`)
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/
const BULLET_RE = /^\s{0,3}[-*+]\s+(.*)$/
const ORDERED_RE = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/
// リンク `[label](url "title")`。これも文字列から組む（`"` を正規表現リテラルに直書きすると
// 上と同じ理由で検出器が文字列モードのまま迷子になる）。
const LINK_RE = new RegExp('^\\[([^\\][\\n]*)\\]\\(([^)\\s]+)(?:\\s+"[^"]*")?\\)')

/**
 * インライン要素をトークン化する。
 * 優先順: インラインコード（中の `*` や `[` を展開しない） → 太字 → リンク。
 * @param {unknown} text 1 行ぶんのテキスト
 * @returns {Array<object>} インライン token の配列
 */
export function parseInline(text) {
  const s = String(text ?? '')
  /** @type {Array<object>} */
  const out = []
  let buf = ''
  const flush = () => {
    if (!buf) return
    const last = out[out.length - 1]
    if (last && last.type === 'text') last.value += buf
    else out.push({ type: 'text', value: buf })
    buf = ''
  }
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === BACKTICK) {
      const end = s.indexOf(BACKTICK, i + 1)
      if (end > i + 1) {
        flush()
        out.push({ type: 'code', value: s.slice(i + 1, end) })
        i = end + 1
        continue
      }
    } else if (ch === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2)
      if (end > i + 2) {
        flush()
        out.push({ type: 'strong', children: parseInline(s.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    } else if (ch === '[') {
      const m = LINK_RE.exec(s.slice(i))
      if (m) {
        flush()
        const href = sanitizeUrl(m[2])
        out.push({
          type: 'link',
          href,
          // 危険スキームや不正 URL は `<a>` にせず、ラベル＋生の URL を平文で見せる
          bare: href ? null : m[2],
          children: parseInline(m[1]),
        })
        i += m[0].length
        continue
      }
    }
    buf += ch
    i += 1
  }
  flush()
  return out
}

/**
 * ブロック要素をトークン化する（見出し / 引用 / リスト / フェンスコード / 段落）。
 * @param {unknown} raw 本文
 * @returns {Array<object>} ブロック token の配列
 */
export function parseBlocks(raw) {
  const lines = String(raw ?? '').replace(/\r\n?/g, '\n').split('\n')
  /** @type {Array<object>} */
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i += 1
      continue
    }

    const fence = FENCE_RE.exec(line)
    if (fence) {
      const marker = fence[1]
      const body = []
      i += 1
      while (i < lines.length) {
        if (lines[i].trim().startsWith(marker)) {
          i += 1
          break
        }
        body.push(lines[i])
        i += 1
      }
      blocks.push({ type: 'code', lang: fence[2] || 'code', value: body.join('\n') })
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      // # の数は 3 段まで（h4 以降は h3 に寄せる: 気泡内で細かくしすぎない）
      blocks.push({
        type: 'heading',
        level: Math.min(heading[1].length, 3),
        children: parseInline(heading[2].replace(/\s+#+\s*$/, '')),
      })
      i += 1
      continue
    }

    if (QUOTE_RE.test(line)) {
      const body = []
      while (i < lines.length) {
        const q = QUOTE_RE.exec(lines[i])
        if (!q) break
        body.push(q[1])
        i += 1
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(body.join('\n')) })
      continue
    }

    if (BULLET_RE.test(line) || ORDERED_RE.test(line)) {
      const ordered = !BULLET_RE.test(line)
      const re = ordered ? ORDERED_RE : BULLET_RE
      const items = []
      while (i < lines.length) {
        const m = re.exec(lines[i])
        if (!m) break
        items.push({ children: parseInline(ordered ? m[2] : m[1]) })
        i += 1
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    const para = []
    while (i < lines.length) {
      const l = lines[i]
      if (
        !l.trim() ||
        FENCE_RE.test(l) ||
        HEADING_RE.test(l) ||
        QUOTE_RE.test(l) ||
        BULLET_RE.test(l) ||
        ORDERED_RE.test(l)
      ) {
        break
      }
      para.push(l)
      i += 1
    }
    /** @type {Array<object>} */
    const children = []
    para.forEach((l, idx) => {
      if (idx) children.push({ type: 'br' })
      children.push(...parseInline(l.trim()))
    })
    blocks.push({ type: 'paragraph', children })
  }
  return blocks
}

/**
 * インライン token を React 要素へ変換する。
 * @param {Array<object>} tokens インライン token
 * @param {string} keyPrefix React key の接頭辞
 * @returns {Array<React.ReactNode>} 要素配列
 */
export function renderInline(tokens, keyPrefix = 'i') {
  return (tokens ?? []).map((tok, idx) => {
    const key = `${keyPrefix}-${idx}`
    if (tok.type === 'code') return React.createElement('code', { key, className: 'md-code' }, tok.value)
    if (tok.type === 'strong') return React.createElement('strong', { key }, renderInline(tok.children, key))
    if (tok.type === 'br') return React.createElement('br', { key })
    if (tok.type === 'link') {
      const inner = renderInline(tok.children, key)
      if (!tok.href) {
        // 危険スキーム: リンクにせず、ラベルと生 URL を平文で残す（何が書かれていたか隠さない）
        return React.createElement('span', { key, className: 'md-link-bare' }, ...inner, tok.bare ? ` (${tok.bare})` : '')
      }
      return React.createElement(
        'a',
        { key, className: 'md-link', href: tok.href, target: '_blank', rel: 'noopener noreferrer' },
        ...inner,
      )
    }
    return tok.value
  })
}

/**
 * ブロック token を React 要素へ変換する。
 * @param {object} block ブロック token
 * @param {number} idx 位置（React key 用）
 * @param {{onCopyCode?: ((code:string)=>void)|null, copyLabel?: string}} opts コピー処理
 * @returns {React.ReactNode} 要素
 */
function renderBlock(block, idx, opts) {
  const key = `b-${idx}`
  const { onCopyCode, copyLabel } = opts
  if (block.type === 'code') {
    const head = React.createElement(
      'div',
      { className: 'code-head' },
      React.createElement('span', null, block.lang),
      onCopyCode
        ? React.createElement(
            'button',
            {
              type: 'button',
              className: 'code-copy',
              onClick: (e) => {
                e.stopPropagation()
                onCopyCode(block.value)
              },
            },
            copyLabel,
          )
        : null,
    )
    return React.createElement(
      'div',
      { key, className: 'code-block' },
      head,
      React.createElement('pre', null, React.createElement('code', null, block.value)),
    )
  }
  if (block.type === 'heading') {
    const tag = `h${block.level}`
    return React.createElement(tag, { key, className: `md-h${block.level}` }, renderInline(block.children, key))
  }
  if (block.type === 'quote') {
    return React.createElement(
      'blockquote',
      { key, className: 'md-quote' },
      block.blocks.map((b, i) => renderBlock(b, i, opts)),
    )
  }
  if (block.type === 'list') {
    const tag = block.ordered ? 'ol' : 'ul'
    return React.createElement(
      tag,
      { key, className: 'md-list' },
      block.items.map((it, i) => React.createElement('li', { key: `${key}-${i}` }, renderInline(it.children, `${key}-${i}`))),
    )
  }
  return React.createElement('p', { key, className: 'md-p' }, renderInline(block.children, key))
}

/**
 * Markdown を React 要素として描画する（アシスタント気泡用）。
 * @param {unknown} raw 本文
 * @param {{onCopyCode?: ((code:string)=>void)|null, copyLabel?: string}} [opts] コードブロックのコピー処理
 * @returns {React.ReactElement} `<div class="md-body">`
 */
export function renderMarkdown(raw, opts = {}) {
  const blocks = parseBlocks(raw)
  const o = { onCopyCode: opts.onCopyCode ?? null, copyLabel: opts.copyLabel ?? 'Copy' }
  return React.createElement(
    'div',
    { className: 'md-body' },
    blocks.map((b, i) => renderBlock(b, i, o)),
  )
}
