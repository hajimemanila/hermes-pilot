#!/usr/bin/env node
/**
 * Autopilot Fast-Lane batch mock renderer & Pre-Flight Visual Gate (SPEC-AUTOPILOT-V2 AP2-1).
 *
 * Renders multiple static HTML mock variants in parallel tabs inside a single
 * headless Chrome CDP session (zero external npm dependencies; Node 22 WebSocket).
 * Runs Pre-Flight DOM checks (horizontal overflow, broken images, interactive overlap,
 * low contrast, optional snippet clipping) and writes PNGs + JSON diagnostics.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Cdp, findChrome, launchChrome, sleep, waitFor } from './lib/cdp.mjs'

export const DEFAULT_VIEWPORT = Object.freeze({
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
})

export const DEFAULT_CONCURRENCY = 4

/**
 * Parse `"WxH"` string or viewport object into normalized CDP Emulation metrics.
 * @param {string|{width: number, height: number, deviceScaleFactor?: number, mobile?: boolean}} [spec]
 * @returns {{width: number, height: number, deviceScaleFactor: number, mobile: boolean}}
 */
export function parseViewport(spec = DEFAULT_VIEWPORT) {
  let width
  let height
  let deviceScaleFactor = 2
  let mobile

  if (typeof spec === 'string') {
    const m = /^(\d+)x(\d+)$/i.exec(spec.trim())
    if (!m) throw new Error(`Invalid viewport "${spec}": expected WxH`)
    width = Number(m[1])
    height = Number(m[2])
  } else if (spec && typeof spec === 'object') {
    width = Number(spec.width)
    height = Number(spec.height)
    if (spec.deviceScaleFactor !== undefined) deviceScaleFactor = Number(spec.deviceScaleFactor) || 2
    if (typeof spec.mobile === 'boolean') mobile = spec.mobile
  } else {
    throw new Error(`Invalid viewport: ${String(spec)}`)
  }

  if (!Number.isInteger(width) || width < 100 || width > 4096) {
    throw new Error(`Invalid viewport width: ${width} (expected 100..4096)`)
  }
  if (!Number.isInteger(height) || height < 100 || height > 8192) {
    throw new Error(`Invalid viewport height: ${height} (expected 100..8192)`)
  }

  return {
    width,
    height,
    deviceScaleFactor,
    mobile: mobile ?? width <= 600,
  }
}

/**
 * Parse CLI flags for `render-mocks.mjs`.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const out = {
    manifestPath: '',
    dirPath: '',
    outDir: '',
    viewport: { ...DEFAULT_VIEWPORT },
    concurrency: DEFAULT_CONCURRENCY,
    json: false,
    allowSkip: false,
    help: false,
  }

  const take = (i, inline) => {
    if (inline !== undefined) return [inline, i]
    if (i + 1 >= argv.length) throw new Error(`Missing value for ${argv[i]}`)
    return [argv[i + 1], i + 1]
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const eq = arg.indexOf('=')
    const name = eq > 0 ? arg.slice(0, eq) : arg
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined

    if (name === '--manifest') {
      const [val, next] = take(i, inline)
      out.manifestPath = path.resolve(val)
      i = next
    } else if (name === '--dir') {
      const [val, next] = take(i, inline)
      out.dirPath = path.resolve(val)
      i = next
    } else if (name === '--out-dir') {
      const [val, next] = take(i, inline)
      out.outDir = path.resolve(val)
      i = next
    } else if (name === '--viewport') {
      const [val, next] = take(i, inline)
      out.viewport = parseViewport(val)
      i = next
    } else if (name === '--concurrency') {
      const [val, next] = take(i, inline)
      const n = Number.parseInt(val, 10)
      if (!Number.isFinite(n) || n < 1) throw new Error(`Invalid concurrency: ${val}`)
      out.concurrency = Math.min(8, Math.max(1, n))
      i = next
    } else if (name === '--json') {
      out.json = true
    } else if (name === '--allow-skip') {
      out.allowSkip = true
    } else if (name === '--help' || name === '-h') {
      out.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return out
}

/**
 * Load variant definitions from a JSON manifest file or a directory of `.html` mocks.
 * @param {{manifestPath?: string, dirPath?: string, outDir?: string, viewport?: object, concurrency?: number}} opts
 */
export function loadManifest({ manifestPath, dirPath, outDir, viewport, concurrency } = {}) {
  if (!manifestPath && !dirPath) {
    throw new Error('Either --manifest or --dir is required')
  }

  if (manifestPath) {
    const absManifest = path.resolve(manifestPath)
    const baseDir = path.dirname(absManifest)
    const raw = JSON.parse(fs.readFileSync(absManifest, 'utf8'))
    const rawList = Array.isArray(raw?.variants) ? raw.variants : []
    const defaultVp = parseViewport(viewport ?? raw?.viewport ?? DEFAULT_VIEWPORT)
    const defaultOutDir = outDir
      ? path.resolve(outDir)
      : raw?.outDir
        ? path.resolve(baseDir, String(raw.outDir))
        : path.join(baseDir, 'shots')

    const variants = rawList.map((entry, idx) => {
      const id = String(entry?.id || `variant-${idx + 1}`).trim()
      const htmlPath = path.resolve(baseDir, String(entry?.htmlPath || `${id}.html`))
      const resolvedOut = entry?.outPath
        ? path.resolve(baseDir, String(entry.outPath))
        : path.join(defaultOutDir, `${id}.png`)
      return {
        id,
        htmlPath,
        outPath: resolvedOut,
        viewport: parseViewport(entry?.viewport ?? defaultVp),
        snippetSelector: entry?.snippetSelector ? String(entry.snippetSelector).trim() : '',
      }
    })

    const resolvedConc = concurrency ?? (Number(raw?.concurrency) || DEFAULT_CONCURRENCY)
    return {
      variants,
      outDir: defaultOutDir,
      viewport: defaultVp,
      concurrency: Math.min(8, Math.max(1, resolvedConc)),
    }
  }

  const absDir = path.resolve(dirPath)
  const resolvedOutDir = outDir ? path.resolve(outDir) : path.join(absDir, 'shots')
  const defaultVp = parseViewport(viewport ?? DEFAULT_VIEWPORT)
  const htmlFiles = fs
    .readdirSync(absDir, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.html?$/i.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b))

  const variants = htmlFiles.map((file) => {
    const id = file.replace(/\.html?$/i, '')
    return {
      id,
      htmlPath: path.join(absDir, file),
      outPath: path.join(resolvedOutDir, `${id}.png`),
      viewport: { ...defaultVp },
      snippetSelector: '',
    }
  })

  return {
    variants,
    outDir: resolvedOutDir,
    viewport: defaultVp,
    concurrency: Math.min(8, Math.max(1, concurrency ?? DEFAULT_CONCURRENCY)),
  }
}

/**
 * Evaluate Pre-Flight DOM inspection metrics against visual gate rules.
 * @param {object} rawMetrics
 * @param {{snippetSelector?: string, failOnConsoleErrors?: boolean}} [opts]
 */
export function evaluatePreFlightMetrics(rawMetrics, opts = {}) {
  const scrollWidth = Number(rawMetrics?.scrollWidth ?? 0)
  const clientWidth = Number(rawMetrics?.clientWidth ?? 0)
  const expectedWidth = Number(opts.expectedWidth ?? 0)
  const brokenImages = Number(rawMetrics?.brokenImages ?? 0)
  const overlapCount = Number(rawMetrics?.overlapCount ?? 0)
  const lowContrastCount = Number(rawMetrics?.lowContrastCount ?? 0)
  const consoleErrors = Number(rawMetrics?.consoleErrors ?? 0)
  const snippetRect = rawMetrics?.snippetRect ?? null
  const snippetMissing = Boolean(rawMetrics?.snippetMissing)

  const effectiveLimit = expectedWidth > 0 ? Math.min(clientWidth || expectedWidth, expectedWidth) : clientWidth
  const failures = []
  if (scrollWidth > effectiveLimit + 1 || (expectedWidth > 0 && clientWidth > expectedWidth + 1)) {
    failures.push(
      `horizontal_overflow: scrollWidth=${scrollWidth}, clientWidth=${clientWidth}, expected<=${effectiveLimit}`,
    )
  }
  if (brokenImages > 0) {
    failures.push(`broken_images: ${brokenImages} image(s) failed to load`)
  }
  if (overlapCount > 0) {
    failures.push(`interactive_overlap: ${overlapCount} overlapping pair(s)`)
  }
  if (lowContrastCount > 0) {
    failures.push(`low_contrast: ${lowContrastCount} element(s) below 3.0 contrast`)
  }
  if (opts.snippetSelector && snippetMissing) {
    failures.push(`snippet_not_found: ${opts.snippetSelector}`)
  }
  if (opts.failOnConsoleErrors && consoleErrors > 0) {
    failures.push(`console_errors: ${consoleErrors}`)
  }

  return {
    status: failures.length === 0 ? 'pass' : 'fail',
    failures,
    metrics: {
      scrollWidth,
      clientWidth,
      brokenImages,
      overlapCount,
      lowContrastCount,
      ...(snippetRect ? { snippetRect } : {}),
    },
  }
}

/**
 * Self-contained DOM audit function evaluated inside the browser page via CDP.
 * Must NOT reference outer module scope.
 * @param {string} snippetSelector
 */
export function inspectMockInPage(snippetSelector) {
  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  const parseColor = (str) => {
    const m = /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(
      String(str || '').trim(),
    )
    if (!m) return null
    return {
      r: Number(m[1]),
      g: Number(m[2]),
      b: Number(m[3]),
      a: m[4] === undefined ? 1 : Number(m[4]),
    }
  }

  const luminance = ({ r, g, b }) => {
    const toLinear = (c) => {
      const s = c / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
  }

  const contrastRatio = (c1, c2) => {
    const l1 = luminance(c1)
    const l2 = luminance(c2)
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
  }

  const findEffectiveBg = (el) => {
    let cur = el
    while (cur && cur.nodeType === 1) {
      const bg = parseColor(getComputedStyle(cur).backgroundColor)
      if (bg && bg.a >= 0.9) return bg
      cur = cur.parentElement
    }
    return { r: 255, g: 255, b: 255, a: 1 }
  }

  const de = document.documentElement
  const scrollWidth = de.scrollWidth
  const clientWidth = de.clientWidth

  let brokenImages = 0
  for (const img of document.querySelectorAll('img')) {
    const cs = getComputedStyle(img)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    if (!img.complete || img.naturalWidth === 0) brokenImages += 1
  }

  const interactive = [
    ...document.querySelectorAll(
      'button, a[href], input:not([type=hidden]), select, textarea, [role="button"], [role="tab"]',
    ),
  ].filter(isVisible)

  let overlapCount = 0
  for (let i = 0; i < interactive.length; i += 1) {
    const a = interactive[i]
    const ra = a.getBoundingClientRect()
    for (let j = i + 1; j < interactive.length; j += 1) {
      const b = interactive[j]
      if (a.contains(b) || b.contains(a)) continue
      const rb = b.getBoundingClientRect()
      const ow = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
      const oh = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
      if (ow > 2 && oh > 2 && ow * oh > 4) overlapCount += 1
    }
  }

  let lowContrastCount = 0
  const textEls = document.querySelectorAll('h1, h2, h3, h4, p, button, a, label, span, li')
  for (const el of textEls) {
    if (!isVisible(el)) continue
    let directText = ''
    for (const node of el.childNodes) {
      if (node.nodeType === 3) directText += node.textContent || ''
    }
    if (!directText.trim()) continue
    const fg = parseColor(getComputedStyle(el).color)
    const bg = findEffectiveBg(el)
    if (fg && bg && fg.a >= 0.9 && bg.a >= 0.9 && contrastRatio(fg, bg) < 3.0) {
      lowContrastCount += 1
    }
  }

  let snippetRect = null
  let snippetMissing = false
  if (snippetSelector) {
    const target = document.querySelector(snippetSelector)
    if (target) {
      const r = target.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) {
        snippetRect = {
          x: Math.max(0, Math.floor(r.left)),
          y: Math.max(0, Math.floor(r.top)),
          width: Math.ceil(r.width),
          height: Math.ceil(r.height),
        }
      } else {
        snippetMissing = true
      }
    } else {
      snippetMissing = true
    }
  }

  return {
    scrollWidth,
    clientWidth,
    brokenImages,
    overlapCount,
    lowContrastCount,
    snippetRect,
    snippetMissing,
  }
}

/**
 * Render and inspect one HTML mock variant in an isolated CDP tab.
 * @param {Cdp} cdp
 * @param {ReturnType<typeof loadManifest>['variants'][number]} variant
 */
export async function renderSingleVariant(cdp, variant) {
  if (!fs.existsSync(variant.htmlPath)) {
    return {
      id: variant.id,
      status: 'fail',
      htmlPath: variant.htmlPath,
      screenshotPath: null,
      width: variant.viewport.width,
      height: variant.viewport.height,
      metrics: null,
      failures: ['missing_html: file not found'],
    }
  }

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  let consoleErrors = 0
  let detachListener = () => {}

  try {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    const onMessage = (event) => {
      let msg
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '')
      } catch (err) {
        void err
        return
      }
      if (msg.sessionId !== sessionId) return
      if (
        msg.method === 'Runtime.exceptionThrown' ||
        (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error')
      ) {
        consoleErrors += 1
      }
    }
    cdp.socket.addEventListener('message', onMessage)
    detachListener = () => cdp.socket.removeEventListener('message', onMessage)

    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width: variant.viewport.width,
        height: variant.viewport.height,
        deviceScaleFactor: variant.viewport.deviceScaleFactor,
        mobile: variant.viewport.mobile,
      },
      sessionId,
    )

    const targetUrl = pathToFileURL(variant.htmlPath).href
    await cdp.send('Page.navigate', { url: targetUrl }, sessionId)
    const loaded = await waitFor(
      async () =>
        Boolean(
          await cdp.eval(
            `location.href !== 'about:blank' && document.readyState === 'complete' && [...document.images].every((img) => img.complete)`,
            sessionId,
          ),
        ),
      8000,
      50,
    )
    if (!loaded) {
      throw new Error(`Timed out waiting for mock page load: ${variant.htmlPath}`)
    }
    await cdp.eval('document.fonts ? document.fonts.ready.then(() => true) : true', sessionId)
    await sleep(80)

    const raw = await cdp.eval(
      `(${inspectMockInPage.toString()})(${JSON.stringify(variant.snippetSelector || '')})`,
      sessionId,
    )
    const gate = evaluatePreFlightMetrics(
      { ...raw, consoleErrors },
      { snippetSelector: variant.snippetSelector, expectedWidth: variant.viewport.width },
    )
    const clip = raw?.snippetRect
    const shot = await cdp.send(
      'Page.captureScreenshot',
      clip
        ? {
            format: 'png',
            clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 },
          }
        : { format: 'png' },
      sessionId,
    )

    fs.mkdirSync(path.dirname(variant.outPath), { recursive: true })
    fs.writeFileSync(variant.outPath, Buffer.from(shot.data, 'base64'))

    return {
      id: variant.id,
      status: gate.status,
      htmlPath: variant.htmlPath,
      screenshotPath: variant.outPath,
      width: clip ? clip.width : variant.viewport.width,
      height: clip ? clip.height : variant.viewport.height,
      metrics: gate.metrics,
      failures: gate.failures,
    }
  } finally {
    detachListener()
    await cdp.send('Target.closeTarget', { targetId }).catch((err) => {
      void err
    })
  }
}

async function openCdpWebSocket(wsUrl) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const onOpen = () => {
      ws.removeEventListener('error', onError)
      resolve(ws)
    }
    const onError = (err) => {
      ws.removeEventListener('open', onOpen)
      reject(new Error(err?.message || 'Failed to connect DevTools WebSocket'))
    }
    ws.addEventListener('open', onOpen, { once: true })
    ws.addEventListener('error', onError, { once: true })
  })
}

/**
 * Batch-render and validate HTML mock variants inside one headless Chrome instance.
 * @param {{manifestPath?: string, dirPath?: string, outDir?: string, viewport?: object, concurrency?: number}} opts
 */
export async function renderMocks(opts = {}) {
  const startedAt = Date.now()
  const manifest = loadManifest(opts)
  const { variants } = manifest
  const concurrency = opts.concurrency ?? manifest.concurrency ?? DEFAULT_CONCURRENCY

  if (variants.length === 0) {
    return {
      ok: true,
      chromeUsed: false,
      total: 0,
      passed: 0,
      failed: 0,
      durationMs: Date.now() - startedAt,
      variants: [],
    }
  }

  const chrome = findChrome()
  if (!chrome) {
    return {
      ok: false,
      skipped: true,
      reason: 'chrome_not_found',
      total: variants.length,
      passed: 0,
      failed: 0,
      durationMs: Date.now() - startedAt,
      variants: [],
    }
  }

  const { wsUrl, cleanup } = await launchChrome(chrome)
  let socket
  try {
    socket = await openCdpWebSocket(wsUrl)
    const cdp = new Cdp(socket)
    const results = new Array(variants.length)
    let cursor = 0

    const workerCount = Math.min(concurrency, variants.length)
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        for (;;) {
          const idx = cursor
          cursor += 1
          if (idx >= variants.length) return
          results[idx] = await renderSingleVariant(cdp, variants[idx])
        }
      }),
    )

    const passed = results.filter((r) => r.status === 'pass').length
    const failed = results.length - passed
    return {
      ok: failed === 0,
      chromeUsed: true,
      total: results.length,
      passed,
      failed,
      durationMs: Date.now() - startedAt,
      variants: results,
    }
  } finally {
    try {
      socket?.close()
    } catch (err) {
      void err
    }
    cleanup()
  }
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(
      'usage: node scripts/render-mocks.mjs (--manifest <file> | --dir <dir>) [--out-dir <dir>] [--viewport WxH] [--concurrency 1..8] [--json] [--allow-skip]',
    )
    process.exit(0)
  }
  const result = await renderMocks({
    manifestPath: args.manifestPath,
    dirPath: args.dirPath,
    outDir: args.outDir,
    viewport: args.viewport,
    concurrency: args.concurrency,
  })
  console.log(JSON.stringify(result, null, 2))
  if (result.skipped) {
    process.exit(args.allowSkip ? 0 : 2)
  }
  process.exit(result.ok ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((err) => {
    console.error(err?.stack || err?.message || String(err))
    process.exit(1)
  })
}
