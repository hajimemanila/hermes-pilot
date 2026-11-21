/**
 * 静的整合監査（分割時の取り残し・未定義識別子・i18n 欠落をビルド前に検出する）。
 *
 * 過去に起きた 2 種の実行時クラッシュを恒久的に防ぐ:
 *  1. モジュール分割時に関数本体だけ移して import / destructuring を置き忘れる（例: `api-boards.js`, `SpecPicker.jsx`）
 *  2. コード側で `t('...')` を参照したキーを `en.json` / `ja.json` に足し忘れる（例: `live.failed`）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const WEB_SRC = path.join(ROOT, 'apps/web/src')

const en = JSON.parse(fs.readFileSync(path.join(WEB_SRC, 'i18n/en.json'), 'utf8'))
const ja = JSON.parse(fs.readFileSync(path.join(WEB_SRC, 'i18n/ja.json'), 'utf8'))

const GLOBALS = new Set([
  ...Object.getOwnPropertyNames(globalThis),
  'window',
  'document',
  'location',
  'navigator',
  'localStorage',
  'sessionStorage',
  'history',
  'screen',
  'matchMedia',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'ResizeObserver',
  'MutationObserver',
  'IntersectionObserver',
  'WebSocket',
  'Event',
  'CustomEvent',
  'EventTarget',
  'HTMLElement',
  'SVGElement',
  'Node',
  'Element',
  'KeyboardEvent',
  'MouseEvent',
  'PointerEvent',
  'FocusEvent',
  'Image',
  'Audio',
  'AudioContext',
  'webkitAudioContext',
  'FileReader',
  'Blob',
  'File',
  'FormData',
  'HTMLCanvasElement',
  'createImageBitmap',
  'URL',
  'URLSearchParams',
  'AbortController',
  'AbortSignal',
  'DOMException',
  'Headers',
  'Request',
  'Response',
  'fetch',
  'caches',
  'self',
  'clients',
  'performance',
  'crypto',
  'TextEncoder',
  'TextDecoder',
  'atob',
  'btoa',
  'structuredClone',
  'queueMicrotask',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'console',
  'process',
  'Buffer',
  'Intl',
  'Math',
  'JSON',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Symbol',
  'BigInt',
  'Date',
  'RegExp',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Promise',
  'Proxy',
  'Reflect',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'AggregateError',
  'Function',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURI',
  'decodeURI',
  'encodeURIComponent',
  'decodeURIComponent',
  'Uint8Array',
  'Int8Array',
  'Uint16Array',
  'Int16Array',
  'Uint32Array',
  'Int32Array',
  'Float32Array',
  'Float64Array',
  'ArrayBuffer',
  'DataView',
  'undefined',
  'NaN',
  'Infinity',
  'globalThis',
  'arguments',
  'alert',
  'confirm',
  'prompt',
  'CSS',
  'React',
])

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'dist-demo', 'dist.prev', 'dist.next'].includes(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkFiles(p, out)
    else if (/\.(js|jsx|mjs)$/.test(e.name)) out.push(p)
  }
  return out
}

function collectPattern(node, set) {
  if (!node) return
  if (node.type === 'Identifier') {
    set.add(node.name)
    return
  }
  if (node.type === 'AssignmentPattern') {
    collectPattern(node.left, set)
    return
  }
  if (node.type === 'RestElement') {
    collectPattern(node.argument, set)
    return
  }
  if (node.type === 'ArrayPattern') {
    for (const el of node.elements) collectPattern(el, set)
    return
  }
  if (node.type === 'ObjectPattern') {
    for (const p of node.properties) collectPattern(p.type === 'RestElement' ? p.argument : p.value, set)
  }
}

function hoistScope(stmts, set) {
  if (!Array.isArray(stmts)) return
  for (const s of stmts) {
    if (!s) continue
    if (s.type === 'FunctionDeclaration' && s.id) set.add(s.id.name)
    else if (s.type === 'ClassDeclaration' && s.id) set.add(s.id.name)
    else if (s.type === 'VariableDeclaration') {
      for (const d of s.declarations) collectPattern(d.id, set)
    } else if (s.type === 'ImportDeclaration') {
      for (const sp of s.specifiers) if (sp.local) set.add(sp.local.name)
    } else if (s.type === 'ExportNamedDeclaration' || s.type === 'ExportDefaultDeclaration') {
      if (s.declaration) hoistScope([s.declaration], set)
    }
  }
}

function findUnboundIdentifiers(file) {
  const src = fs.readFileSync(file, 'utf8')
  const ast = parse(src, { sourceType: 'module', plugins: ['jsx', 'importAttributes'] })
  const undefs = []
  const scopes = [new Set()]
  hoistScope(ast.program.body, scopes[0])

  const inScope = (name) => {
    if (GLOBALS.has(name)) return true
    for (let i = scopes.length - 1; i >= 0; i -= 1) if (scopes[i].has(name)) return true
    return false
  }

  function visitPatternDefaults(pat) {
    if (!pat) return
    if (pat.type === 'AssignmentPattern') {
      visit(pat.right, pat, 'right')
      visitPatternDefaults(pat.left)
    } else if (pat.type === 'ObjectPattern') {
      for (const p of pat.properties) {
        if (p.computed) visit(p.key, p, 'key')
        visitPatternDefaults(p.type === 'RestElement' ? p.argument : p.value)
      }
    } else if (pat.type === 'ArrayPattern') {
      for (const el of pat.elements) visitPatternDefaults(el)
    }
  }

  function visit(node, parent, key) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const x of node) visit(x, parent, key)
      return
    }
    if (!node.type) return
    if (node.type === 'MetaProperty' || node.type === 'ImportDeclaration') return
    if (node.type === 'ExportNamedDeclaration' && node.source) return
    if (node.type === 'ExportAllDeclaration') return

    if (node.type === 'Identifier') {
      if (parent) {
        if ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && key === 'property' && !parent.computed) return
        if ((parent.type === 'ObjectProperty' || parent.type === 'ObjectMethod' || parent.type === 'ClassMethod' || parent.type === 'ClassProperty') && key === 'key' && !parent.computed) return
        if (parent.type === 'VariableDeclarator' && key === 'id') return
        if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression') && key === 'id') return
        if (parent.type === 'ExportSpecifier' && key === 'exported') return
        if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return
        if (parent.type === 'UnaryExpression' && parent.operator === 'typeof') return
      }
      if (!inScope(node.name)) undefs.push(`${node.name}@L${node.loc?.start?.line}`)
      return
    }

    if (node.type === 'JSXIdentifier') {
      if (parent?.type === 'JSXOpeningElement' && key === 'name' && /^[A-Z]/.test(node.name)) {
        if (!inScope(node.name)) undefs.push(`JSX:${node.name}@L${node.loc?.start?.line}`)
      }
      return
    }
    if (node.type === 'JSXMemberExpression') {
      visit(node.object, node, 'object')
      return
    }

    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod'].includes(node.type)) {
      const sc = new Set()
      if (node.id) sc.add(node.id.name)
      for (const p of node.params || []) collectPattern(p, sc)
      if (node.body?.type === 'BlockStatement') hoistScope(node.body.body, sc)
      scopes.push(sc)
      for (const p of node.params || []) {
        if (p.type === 'AssignmentPattern') visit(p.right, p, 'right')
        else if (p.type === 'ObjectPattern' || p.type === 'ArrayPattern') visitPatternDefaults(p)
      }
      visit(node.body, node, 'body')
      scopes.pop()
      return
    }
    if (node.type === 'BlockStatement') {
      const sc = new Set()
      hoistScope(node.body, sc)
      scopes.push(sc)
      for (const st of node.body) visit(st, node, 'body')
      scopes.pop()
      return
    }
    if (['ForStatement', 'ForInStatement', 'ForOfStatement'].includes(node.type)) {
      const sc = new Set()
      const init = node.init || node.left
      if (init?.type === 'VariableDeclaration') for (const d of init.declarations) collectPattern(d.id, sc)
      scopes.push(sc)
      for (const [k, v] of Object.entries(node)) {
        if (!['loc', 'start', 'end', 'type', 'leadingComments', 'trailingComments', 'innerComments'].includes(k)) visit(v, node, k)
      }
      scopes.pop()
      return
    }
    if (node.type === 'CatchClause') {
      const sc = new Set()
      if (node.param) collectPattern(node.param, sc)
      scopes.push(sc)
      visit(node.body, node, 'body')
      scopes.pop()
      return
    }
    if (node.type === 'SwitchStatement') {
      visit(node.discriminant, node, 'discriminant')
      const sc = new Set()
      for (const c of node.cases) hoistScope(c.consequent, sc)
      scopes.push(sc)
      for (const c of node.cases) {
        visit(c.test, c, 'test')
        visit(c.consequent, c, 'consequent')
      }
      scopes.pop()
      return
    }
    if (node.type === 'ObjectPattern' || node.type === 'ArrayPattern') {
      visitPatternDefaults(node)
      return
    }
    if (node.type === 'AssignmentPattern') {
      visit(node.right, node, 'right')
      return
    }

    for (const [k, v] of Object.entries(node)) {
      if (!['loc', 'start', 'end', 'type', 'leadingComments', 'trailingComments', 'innerComments'].includes(k)) visit(v, node, k)
    }
  }

  visit(ast.program, null, null)
  return [...new Set(undefs)]
}

test('全ソースに未定義識別子（import 漏れ・分割残存）が無い', () => {
  const hits = []
  for (const rel of ['apps/bridge/src', 'apps/web/src', 'scripts', 'bin']) {
    for (const f of walkFiles(path.join(ROOT, rel))) {
      const undef = findUnboundIdentifiers(f)
      if (undef.length) hits.push(`${path.relative(ROOT, f)}: ${undef.join(', ')}`)
    }
  }
  assert.deepEqual(hits, [])
})

test('server.js の apiCtx は分割ハンドラが要求する ctx キーをすべて持つ', () => {
  const serverAst = parse(fs.readFileSync(path.join(ROOT, 'apps/bridge/src/server.js'), 'utf8'), { sourceType: 'module' })
  let provided = null
  for (const st of serverAst.program.body) {
    if (st.type !== 'VariableDeclaration') continue
    for (const d of st.declarations) {
      if (d.id?.name === 'apiCtx' && d.init?.type === 'ObjectExpression') {
        provided = new Set(d.init.properties.map((p) => p.key?.name || p.argument?.name).filter(Boolean))
      }
    }
  }
  assert.ok(provided, 'apiCtx が見つからない')

  for (const [rel, fnName] of [
    ['apps/bridge/src/server/api-boards.js', 'createBoardsApi'],
    ['apps/bridge/src/server/api-specs.js', 'createSpecsApi'],
  ]) {
    const ast = parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { sourceType: 'module' })
    let needed = []
    for (const st of ast.program.body) {
      const fn = st.type === 'ExportNamedDeclaration' ? st.declaration : st
      if (fn?.type === 'FunctionDeclaration' && fn.id?.name === fnName) {
        for (const inner of fn.body.body) {
          if (inner.type !== 'VariableDeclaration') continue
          for (const d of inner.declarations) {
            if (d.init?.name === 'ctx' && d.id?.type === 'ObjectPattern') {
              needed = d.id.properties.map((p) => p.key?.name).filter(Boolean)
            }
          }
        }
      }
    }
    assert.ok(needed.length > 0, `${rel} の ctx 分割が見つからない`)
    const missing = needed.filter((k) => !provided.has(k))
    assert.deepEqual(missing, [], `${rel} が要求するキーが apiCtx に無い: ${missing.join(', ')}`)
  }
})

test('UI で静的参照されるすべての t() / translate() キーが en.json と ja.json に存在する', () => {
  const missing = []
  for (const f of walkFiles(WEB_SRC)) {
    if (f.includes(`${path.sep}demo${path.sep}`)) continue
    const ast = parse(fs.readFileSync(f, 'utf8'), { sourceType: 'module', plugins: ['jsx', 'importAttributes'] })
    const visit = (n) => {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) {
        n.forEach(visit)
        return
      }
      if (n.type === 'CallExpression' && n.callee?.type === 'Identifier') {
        const name = n.callee.name
        const keyNode = name === 't' || name === 'tGlobal' ? n.arguments[0] : name === 'translate' ? n.arguments[1] : null
        if (keyNode?.type === 'StringLiteral') {
          const k = keyNode.value
          if (!(k in en) || !(k in ja)) {
            missing.push(`${path.relative(ROOT, f)}:${keyNode.loc?.start?.line} -> ${k}`)
          }
        }
      }
      for (const [k, v] of Object.entries(n)) {
        if (!['loc', 'start', 'end', 'type'].includes(k)) visit(v)
      }
    }
    visit(ast.program)
  }
  assert.deepEqual(missing, [])
})
