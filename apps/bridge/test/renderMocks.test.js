/**
 * AP2-1 tests for `scripts/render-mocks.mjs` (manifest loading, Pre-Flight Visual Gate,
 * CLI usage output, and real parallel headless Chrome batch rendering).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_VIEWPORT,
  evaluatePreFlightMetrics,
  loadManifest,
  parseArgs,
  parseViewport,
  renderMocks,
} from '../../../scripts/render-mocks.mjs'
import { findChrome } from '../../../scripts/lib/cdp.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SCRIPT = path.join(ROOT, 'scripts', 'render-mocks.mjs')
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

test('parseViewport validates WxH strings and objects', () => {
  assert.deepEqual(parseViewport('390x844'), DEFAULT_VIEWPORT)
  assert.deepEqual(parseViewport({ width: 744, height: 1024 }), {
    width: 744,
    height: 1024,
    deviceScaleFactor: 2,
    mobile: false,
  })
  assert.throws(() => parseViewport('bad'), /Invalid viewport/)
  assert.throws(() => parseViewport('50x844'), /width/)
  assert.throws(() => parseViewport('390x9000'), /height/)
})

test('parseArgs parses flags, inline values, and concurrency bounds', () => {
  const parsed = parseArgs([
    '--manifest=tmp/m.json',
    '--out-dir',
    'tmp/shots',
    '--viewport',
    '390x844',
    '--concurrency',
    '12',
    '--json',
    '--allow-skip',
  ])
  assert.equal(parsed.manifestPath, path.resolve('tmp/m.json'))
  assert.equal(parsed.outDir, path.resolve('tmp/shots'))
  assert.equal(parsed.viewport.width, 390)
  assert.equal(parsed.concurrency, 8)
  assert.equal(parsed.json, true)
  assert.equal(parsed.allowSkip, true)
})

test('loadManifest loads both directory HTML files and explicit manifest files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'render-mocks-unit-'))
  try {
    fs.writeFileSync(path.join(tmp, 'b.html'), '<html></html>')
    fs.writeFileSync(path.join(tmp, 'a.html'), '<html></html>')

    const fromDir = loadManifest({ dirPath: tmp })
    assert.deepEqual(
      fromDir.variants.map((v) => v.id),
      ['a', 'b'],
    )
    assert.equal(fromDir.variants[0].outPath, path.join(tmp, 'shots', 'a.png'))

    const manifestFile = path.join(tmp, 'manifest.json')
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({
        outDir: 'custom-shots',
        variants: [{ id: 'card-a', htmlPath: 'a.html', snippetSelector: '#bar' }],
      }),
    )
    const fromManifest = loadManifest({ manifestPath: manifestFile })
    assert.equal(fromManifest.variants.length, 1)
    assert.equal(fromManifest.variants[0].id, 'card-a')
    assert.equal(fromManifest.variants[0].outPath, path.join(tmp, 'custom-shots', 'card-a.png'))
    assert.equal(fromManifest.variants[0].snippetSelector, '#bar')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('evaluatePreFlightMetrics enforces overflow, images, overlap, contrast, and snippet rules', () => {
  const pass = evaluatePreFlightMetrics({
    scrollWidth: 390,
    clientWidth: 390,
    brokenImages: 0,
    overlapCount: 0,
    lowContrastCount: 0,
  })
  assert.equal(pass.status, 'pass')
  assert.deepEqual(pass.failures, [])

  const fail = evaluatePreFlightMetrics(
    {
      scrollWidth: 460,
      clientWidth: 390,
      brokenImages: 2,
      overlapCount: 1,
      lowContrastCount: 3,
      snippetMissing: true,
      consoleErrors: 1,
    },
    { snippetSelector: '#tabbar', failOnConsoleErrors: true },
  )
  assert.equal(fail.status, 'fail')
  assert.equal(fail.failures.length, 6)
  assert.match(fail.failures[0], /^horizontal_overflow:/)
  assert.match(fail.failures[1], /^broken_images:/)
  assert.match(fail.failures[2], /^interactive_overlap:/)
  assert.match(fail.failures[3], /^low_contrast:/)
  assert.match(fail.failures[4], /^snippet_not_found:/)
  assert.match(fail.failures[5], /^console_errors:/)
})

test('CLI --help exits 0 and prints usage', () => {
  const out = execFileSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' })
  assert.match(out, /usage: node scripts\/render-mocks\.mjs/)
})

test('renderMocks renders parallel variants in 1 Chrome launch with Pre-Flight Visual Gate', async (t) => {
  if (!findChrome()) {
    t.skip('Chrome binary not available in this environment')
    return
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'render-mocks-e2e-'))
  try {
    const vp = '<meta name="viewport" content="width=device-width, initial-scale=1">'
    const inlineSvg = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#2563eb"/></svg>')
    fs.writeFileSync(
      path.join(tmp, 'good.html'),
      `<!DOCTYPE html><html><head>${vp}</head><body style="margin:0;padding:16px;background:#ffffff;color:#111827;font-family:sans-serif">
        <h1 style="font-size:20px;margin:0 0 12px">Good Mock</h1>
        <img src="${inlineSvg}" width="80" height="40" alt="ok" />
        <button style="display:block;margin-top:16px;padding:12px 16px;background:#111827;color:#ffffff;border:0">Choose A</button>
      </body></html>`,
    )
    fs.writeFileSync(
      path.join(tmp, 'overflow.html'),
      `<!DOCTYPE html><html><head>${vp}</head><body style="margin:0;background:#ffffff;color:#111827">
        <div style="width:600px;height:40px;background:#ef4444;color:#ffffff">Too wide</div>
      </body></html>`,
    )
    fs.writeFileSync(
      path.join(tmp, 'broken.html'),
      `<!DOCTYPE html><html><head>${vp}</head><body style="margin:0;background:#ffffff;color:#111827">
        <img src="file:///nonexistent-hermes-mock-test.png" width="80" height="80" alt="broken" />
      </body></html>`,
    )
    fs.writeFileSync(
      path.join(tmp, 'snippet.html'),
      `<!DOCTYPE html><html><head>${vp}</head><body style="margin:0;background:#ffffff;color:#111827">
        <div style="height:200px">Spacer</div>
        <div id="tabbar" style="width:390px;height:60px;display:flex;align-items:center;justify-content:space-around;background:#111827;color:#ffffff">
          <button style="background:#2563eb;color:#ffffff;border:0;padding:8px 12px">Home</button>
          <button style="background:#2563eb;color:#ffffff;border:0;padding:8px 12px">Tasks</button>
        </div>
      </body></html>`,
    )

    const manifestPath = path.join(tmp, 'manifest.json')
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        variants: [
          { id: 'good', htmlPath: 'good.html' },
          { id: 'overflow', htmlPath: 'overflow.html' },
          { id: 'broken', htmlPath: 'broken.html' },
          { id: 'snippet', htmlPath: 'snippet.html', snippetSelector: '#tabbar' },
        ],
      }),
    )

    let res
    try {
      res = await renderMocks({ manifestPath })
    } catch (err) {
      if (/Chrome が起動直後に終了した|EPERM|EACCES/.test(err?.message || '')) {
        t.skip(`Headless Chrome launch blocked in current sandbox: ${err.message}`)
        return
      }
      throw err
    }
    if (res.skipped) {
      t.skip(`renderMocks skipped: ${res.reason}`)
      return
    }

    const summary = JSON.stringify(res.variants.map((v) => ({ id: v.id, status: v.status, failures: v.failures, metrics: v.metrics })))
    assert.equal(res.chromeUsed, true, summary)
    assert.equal(res.total, 4, summary)
    assert.equal(res.passed, 2, summary)
    assert.equal(res.failed, 2, summary)
    assert.equal(res.ok, false, summary)

    const byId = new Map(res.variants.map((v) => [v.id, v]))
    assert.equal(byId.get('good').status, 'pass')
    assert.ok(fs.readFileSync(byId.get('good').screenshotPath).subarray(0, 8).equals(PNG_SIG))

    assert.equal(byId.get('overflow').status, 'fail')
    assert.ok(byId.get('overflow').failures.some((f) => f.startsWith('horizontal_overflow:')))

    assert.equal(byId.get('broken').status, 'fail')
    assert.ok(byId.get('broken').failures.some((f) => f.startsWith('broken_images:')))

    assert.equal(byId.get('snippet').status, 'pass')
    assert.ok(fs.existsSync(byId.get('snippet').screenshotPath))
    assert.ok(byId.get('snippet').metrics.snippetRect.height <= 80)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
