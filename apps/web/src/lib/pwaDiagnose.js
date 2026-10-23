/**
 * PWA 診断: Chrome がインストール可否を判定する条件を、端末の上でそのまま再現する。
 *
 * `This site cannot be installed` の原因を推測せずに特定するためのもの。
 * 各項目を ✓ / ✗ で出し、✗ が残った項目が Chrome の落としている条件。
 */

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
        return { ok: false, why: 'デコード不能', w: 0, h: 0 }
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
  add('manifest の link', Boolean(link), link ? link.getAttribute('href') : 'link タグが無い')
  if (!link) return rows

  const mUrl = new URL(link.getAttribute('href'), location.href).href
  const mr = await headStatus(mUrl)
  add('manifest 取得', mr.status === 200, `HTTP ${mr.status} / ${mr.type}`)
  if (!mr.res || !mr.res.ok) return rows

  let m
  try {
    m = JSON.parse(await mr.res.text())
  } catch (e) {
    add('manifest の JSON', false, e.message)
    return rows
  }
  add('manifest の JSON', true, `${Object.keys(m).length} 項目`)

  // 2) name / short_name
  add('name', Boolean(m.name), m.name ?? 'なし')
  add('short_name', Boolean(m.short_name), m.short_name ?? 'なし')

  // 3) start_url / scope / id
  const startUrl = new URL(m.start_url ?? '.', mUrl).href
  const scope = new URL(m.scope ?? './', mUrl).href
  const idRaw = m.id
  const idUrl = idRaw == null ? null : new URL(idRaw, mUrl).href
  add('start_url', true, startUrl)
  add('scope', true, scope)
  add('id', true, idUrl ?? '（未指定＝start_url と同じ）')
  add('start_url が scope 内', startUrl.startsWith(scope), `${startUrl} ⊂ ${scope}`)
  add('id が同一オリジン', !idUrl || new URL(idUrl).origin === location.origin, idUrl ?? '-')

  // 4) display
  const disp = m.display ?? 'browser'
  const dispOk = ['standalone', 'fullscreen', 'minimal-ui'].includes(disp)
  add('display', dispOk, disp)

  // 5) icons（宣言と実体の両方を見る）
  const icons = m.icons ?? []
  add('icons 件数', icons.length > 0, `${icons.length} 件`)
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
      sz.ok ? `${sz.w}x${sz.h} ${sz.bytes}B ${purpose}（宣言 ${declared}）` : `${sz.why}`,
    )
  }
  add('192px 以上の any アイコン', has192, has192 ? 'あり' : 'なし → インストール不可')
  add('512px 以上の any アイコン', has512, has512 ? 'あり' : 'なし → インストール不可')
  add('maskable アイコン', hasMaskable, hasMaskable ? 'あり' : 'なし（白枠の原因になる）')

  // 6) Service Worker が start_url を制御しているか
  const ctrl = navigator.serviceWorker?.controller
  add('Service Worker 制御', Boolean(ctrl), ctrl ? ctrl.scriptURL : '未制御')
  try {
    const regs = await navigator.serviceWorker.getRegistrations()
    const covering = regs.find((r) => startUrl.startsWith(r.scope))
    add('scope をカバーする SW', Boolean(covering), covering ? covering.scope : 'なし')
  } catch (e) {
    add('scope をカバーする SW', false, e.message)
  }

  // 7) 表示モード
  const modes = ['standalone', 'minimal-ui', 'fullscreen', 'browser']
  add(
    '今の表示モード',
    true,
    modes.filter((x) => matchMedia(`(display-mode: ${x})`).matches).join(', ') || '(不明)',
  )
  add('referrer', true, document.referrer || '(なし)')
  add('UA', true, navigator.userAgent.slice(0, 80))

  return rows
}
