/**
 * パッケージ同梱範囲・プラグイン入口・バージョン表記の整合検査。
 *
 * 1. `package.json` の `"files"` から npm パッケージに入るファイル集合を構築し、
 *    同梱される JS/MJS のすべての相対 `import` / `export ... from` と `plugin.json` の
 *    entrypoint / skill が漏れなく同梱対象に入っていることを検証する（`scripts/lib/` 漏れ等の再発防止）。
 * 2. `package.json` の `version` と各マニフェスト・設定・UI 表記の一致を検証する。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from '@babel/parser'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')

function toPosix(p) {
  return p.split(path.sep).join('/')
}

function walkDirFiles(absDir, out = []) {
  if (!fs.existsSync(absDir)) return out
  for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue
    const abs = path.join(absDir, ent.name)
    if (ent.isDirectory()) walkDirFiles(abs, out)
    else if (ent.isFile()) out.push(toPosix(path.relative(ROOT, abs)))
  }
  return out
}

function globToRegex(pattern) {
  let re = ''
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i += 1
      }
    } else if (pattern[i] === '*') {
      re += '[^/]*'
    } else {
      re += pattern[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

function collectPackagedFiles(patterns) {
  const included = new Set(['package.json'])
  for (const raw of patterns) {
    const pat = String(raw).trim()
    if (!pat) continue
    if (pat.startsWith('!')) {
      const rx = globToRegex(pat.slice(1).replace(/\/+$/, ''))
      for (const rel of [...included]) {
        if (rx.test(rel)) included.delete(rel)
      }
      continue
    }
    if (pat.endsWith('/')) {
      for (const rel of walkDirFiles(path.join(ROOT, pat.slice(0, -1)))) included.add(rel)
      continue
    }
    if (pat.includes('*')) {
      const dir = pat.includes('/') ? pat.slice(0, pat.lastIndexOf('/')) : ''
      const rx = globToRegex(pat)
      const absDir = dir ? path.join(ROOT, dir) : ROOT
      if (fs.existsSync(absDir)) {
        for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
          if (!ent.isFile()) continue
          const rel = toPosix(dir ? `${dir}/${ent.name}` : ent.name)
          if (rx.test(rel)) included.add(rel)
        }
      }
      continue
    }
    if (fs.existsSync(path.join(ROOT, pat))) included.add(pat)
  }
  return included
}

function isRuleCovered(rel, patterns) {
  return patterns.some((raw) => {
    if (raw.startsWith('!')) return false
    if (raw.endsWith('/')) return rel.startsWith(raw)
    if (raw.includes('*')) return globToRegex(raw).test(rel)
    return rel === raw
  })
}

function collectRelativeImports(fileAbs) {
  const src = fs.readFileSync(fileAbs, 'utf8')
  const ast = parse(src, { sourceType: 'unambiguous', plugins: ['importAttributes'] })
  const specs = []
  const visit = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) {
      n.forEach(visit)
      return
    }
    if ((n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration') && typeof n.source?.value === 'string') {
      specs.push({ spec: n.source.value, line: n.loc?.start?.line ?? 0 })
    } else if (n.type === 'ExportNamedDeclaration' && typeof n.source?.value === 'string') {
      specs.push({ spec: n.source.value, line: n.loc?.start?.line ?? 0 })
    } else if (n.type === 'ImportExpression' && n.source?.type === 'StringLiteral') {
      specs.push({ spec: n.source.value, line: n.loc?.start?.line ?? 0 })
    }
    for (const [k, v] of Object.entries(n)) {
      if (!['loc', 'start', 'end', 'type', 'leadingComments', 'trailingComments', 'innerComments'].includes(k)) visit(v)
    }
  }
  visit(ast.program)
  return specs
}

function resolveRelativeTarget(fromAbs, spec) {
  const clean = spec.split('?')[0].split('#')[0]
  const base = path.resolve(path.dirname(fromAbs), clean)
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.json`, path.join(base, 'index.js')]
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return toPosix(path.relative(ROOT, c))
  }
  return null
}

test('package.json の files は同梱 JS の全相対 import と plugin.json 入口を漏れなく含む', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'))
  const patterns = Array.isArray(pkg.files) ? pkg.files : []
  const packaged = collectPackagedFiles(patterns)

  for (const binPath of Object.values(pkg.bin ?? {})) {
    const rel = String(binPath).replace(/^\.\//, '')
    assert.ok(packaged.has(rel), `package.json bin が同梱対象に無い: ${rel}`)
  }

  for (const [name, rel] of Object.entries(plugin.entrypoints ?? {})) {
    if (name === 'ui') {
      assert.ok(isRuleCovered(rel, patterns), `plugin.json entrypoints.ui (${rel}) が files ルール外`)
      continue
    }
    assert.ok(packaged.has(rel), `plugin.json entrypoints.${name} が同梱対象に無い: ${rel}`)
  }

  for (const skill of plugin.skills ?? []) {
    assert.ok(packaged.has(skill), `plugin.json skill が同梱対象に無い: ${skill}`)
  }

  const missingTargets = []
  for (const rel of packaged) {
    if (!/\.(js|mjs)$/.test(rel)) continue
    if (rel.startsWith('apps/web/dist/') || rel.startsWith('dashboard/dist/')) continue
    const abs = path.join(ROOT, rel)
    for (const { spec, line } of collectRelativeImports(abs)) {
      if (!spec.startsWith('.')) continue
      const target = resolveRelativeTarget(abs, spec)
      if (!target) {
        missingTargets.push(`${rel}:${line} -> ${spec} (file missing on disk)`)
      } else if (!packaged.has(target)) {
        missingTargets.push(`${rel}:${line} -> ${target} (excluded from package.json files)`)
      }
    }
  }
  assert.deepEqual(missingTargets, [])
})

test('全マニフェスト・設定・UI 定数のバージョンが package.json と一致する', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const expected = pkg.version
  assert.ok(expected, 'package.json version must be set')

  const pluginJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'))
  assert.equal(pluginJson.version, expected, 'plugin.json version mismatch')

  const pluginYaml = fs.readFileSync(path.join(ROOT, 'plugin.yaml'), 'utf8')
  const yamlMatch = /^version:\s*(\S+)/m.exec(pluginYaml)
  assert.equal(yamlMatch?.[1], expected, 'plugin.yaml version mismatch')

  for (const rel of ['apps/dashboard/manifest.json', 'dashboard/manifest.json']) {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'))
    assert.equal(m.version, expected, `${rel} version mismatch`)
  }

  const cfgMod = await import(pathToFileURL(path.join(ROOT, 'apps/bridge/src/config.js')).href)
  assert.equal(cfgMod.VERSION, expected, 'apps/bridge/src/config.js VERSION mismatch')

  for (const rel of ['apps/dashboard/plugin_api.py', 'dashboard/plugin_api.py']) {
    const py = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    const pyMatch = /^VERSION\s*=\s*["']([^"']+)["']/m.exec(py)
    assert.equal(pyMatch?.[1], expected, `${rel} VERSION mismatch`)
  }

  const settingsJsx = fs.readFileSync(path.join(ROOT, 'apps/web/src/features/SettingsPane.jsx'), 'utf8')
  const uiMatch = /t\('settings\.about',\s*\{\s*version:\s*'([^']+)'\s*\}\)/.exec(settingsJsx)
  assert.equal(uiMatch?.[1], expected, 'SettingsPane.jsx settings.about version mismatch')

  const demoPayloads = fs.readFileSync(path.join(ROOT, 'apps/web/src/demo/payloads.js'), 'utf8')
  const demoMatch = /bridge:\s*\{[^}]*\bversion:\s*'([^']+)'/.exec(demoPayloads)
  assert.equal(demoMatch?.[1], expected, 'apps/web/src/demo/payloads.js bridge.version mismatch')
})
