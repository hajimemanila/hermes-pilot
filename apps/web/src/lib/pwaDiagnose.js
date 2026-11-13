/**
 * PWA 診断: Chrome がインストール可否を判定する条件を、端末の上でそのまま再現する。
 *
 * `This site cannot be installed` の原因を推測せずに特定するためのもの。
 * 各項目を ✓ / ✗ で出し、✗ が残った項目が Chrome の落としている条件。
 * 文面は i18n の `diag.*`（英語が既定・SPEC §6）。
 */

import { t } from '../i18n/lang.js'

const OK = (v) => (v ? '✓' : '✗')

async function headStatus(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' })
    return { status: r.status, type: r.headers.get('content-type') ?? '', res: r }
  } catch (e) {
    return { status: 0, type: `error: ${e.message}`, res: null }
  }
}

async function imageSize(url) {
  try {
    // 実際にデコードできるか＋実ピクセル数を測る（Chrome は宣言サイズではなく実体を見る）
    const r = await fetch(url, { cache: 'no-store' })
    if (!r.ok) return { ok: false, why: `HTTP ${r.status}`, w: 0, h: 0 }
    const blob = await r.blob()
    try {
      const bmp = await createImageBitmap(blob)
      return { ok: true, w: bmp.width, h: bmp.height, bytes: blob.size, mime: blob.type }
    } catch {
      // SVG など createImageBitmap が扱わない形式は Image で測る
      const url2 = URL.createObjectURL(blob)
      try {
        const img = await new Promise((res, rej) => {
          const i = new Image()
          i.onload = () => res(i)
          i.onerror = () => rej(new Error('decode'))
          i.src = url2
        })
        return { ok: true, w: img.naturalWidth, h: img.naturalHeight, bytes: blob.size, mime: blob.type }
      } catch {
        return { ok: false, why: t('diag.decodeError'), w: 0, h: 0 }
      } finally {
        URL.revokeObjectURL(url2)
      }
    }
  } catch (e) {
    return { ok: false, why: e.message, w: 0, h: 0 }
  }
}

export async function diagnosePwa() {
  const rows = []
  const add = (label, ok, detail) => rows.push({ label, ok, detail })

  // 1) manifest の発見と取得
  const link = document.querySelector('link[rel="manifest"]')
  add(t('diag.manifestLink'), Boolean(link), link ? link.getAttribute('href') : t('diag.linkMissing'))
  if (!link) return rows

  const mUrl = new URL(link.getAttribute('href'), location.href).href
  const mr = await headStatus(mUrl)
  add(t('diag.manifestFetch'), mr.status === 200, `HTTP ${mr.status} / ${mr.type}`)
  if (!mr.res || !mr.res.ok) return rows

  let m
  try {
    m = JSON.parse(await mr.res.text())
  } catch (e) {
    add(t('diag.manifestJson'), false, e.message)
    return rows
  }
  add(t('diag.manifestJson'), true, t('diag.entries', { count: Object.keys(m).length }))

  // 2) name / short_name
  add('name', Boolean(m.name), m.name ?? t('diag.none'))
  add('short_name', Boolean(m.short_name), m.short_name ?? t('diag.none'))

  // 3) start_url / scope / id
  const startUrl = new URL(m.start_url ?? '.', mUrl).href
  const scope = new URL(m.scope ?? './', mUrl).href
  const idRaw = m.id
  const idUrl = idRaw == null ? null : new URL(idRaw, mUrl).href
  add('start_url', true, startUrl)
  add('scope', true, scope)
  add('id', true, idUrl ?? t('diag.idUnset'))
  add(t('diag.startInScope'), startUrl.startsWith(scope), `${startUrl} ⊂ ${scope}`)
  add(t('diag.idSameOrigin'), !idUrl || new URL(idUrl).origin === location.origin, idUrl ?? '-')

  // 4) display
  const disp = m.display ?? 'browser'
  const dispOk = ['standalone', 'fullscreen', 'minimal-ui'].includes(disp)
  add('display', dispOk, disp)

  // 5) icons（宣言と実体の両方を見る）
  const icons = m.icons ?? []
  add(t('diag.iconCount'), icons.length > 0, t('diag.iconCountValue', { count: icons.length }))
  let has192 = false
  let has512 = false
  let hasMaskable = false
  for (const ic of icons) {
    const u = new URL(ic.src, mUrl).href
    const sz = await imageSize(u)
    const declared = ic.sizes ?? ''
    const purpose = ic.purpose ?? 'any'
    const px = Math.max(sz.w, sz.h)
    if (sz.ok && px >= 192 && purpose.split(' ').includes('any')) has192 = true
    if (sz.ok && px >= 512 && purpose.split(' ').includes('any')) has512 = true
    if (sz.ok && purpose.split(' ').includes('maskable')) hasMaskable = true
    const sizeOk = !declared || declared === 'any' || declared.split(' ').includes(`${sz.w}x${sz.h}`)
    add(
      `icon ${ic.src.split('/').pop()}`,
      sz.ok && sizeOk,
      sz.ok
        ? t('diag.iconLine', { w: sz.w, h: sz.h, bytes: sz.bytes, purpose, declared })
        : `${sz.why}`,
    )
  }
  add(t('diag.any192'), has192, has192 ? t('diag.present') : t('diag.missingInstall'))
  add(t('diag.any512'), has512, has512 ? t('diag.present') : t('diag.missingInstall'))
  add(t('diag.maskable'), hasMaskable, hasMaskable ? t('diag.present') : t('diag.maskableMissing'))

  // 6) Service Worker が start_url を制御しているか
  const ctrl = navigator.serviceWorker?.controller
  add(t('diag.swControl'), Boolean(ctrl), ctrl ? ctrl.scriptURL : t('diag.swNone'))
  try {
    const regs = await navigator.serviceWorker.getRegistrations()
    const covering = regs.find((r) => startUrl.startsWith(r.scope))
    add(t('diag.swCovering'), Boolean(covering), covering ? covering.scope : t('diag.none'))
  } catch (e) {
    add(t('diag.swCovering'), false, e.message)
  }

  // 7) 表示モード
  const modes = ['standalone', 'minimal-ui', 'fullscreen', 'browser']
  add(
    t('diag.viewMode'),
    true,
    modes.filter((x) => matchMedia(`(display-mode: ${x})`).matches).join(', ') || t('diag.unknown'),
  )
  add('referrer', true, document.referrer || t('diag.empty'))
  add('UA', true, navigator.userAgent.slice(0, 80))

  return rows
}
