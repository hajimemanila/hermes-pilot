/* Hermes Pilot: 殻だけキャッシュする
   - 画面遷移（index.html）は network-first（デプロイ後の更新が必ず届く）
   - ハッシュ付きアセットは cache-first
   - API / WS はネットワークのみ（失敗時は 503 の JSON `{ok:false, code:'OFFLINE', error:'Offline'}`）。
     表示文はフロントが `t('err.OFFLINE')` で多言語化する（SPEC §1.2 G4） */
const CACHE = 'hermes-pilot-v4'
const SHELL = [
  '/',
  '/icon-192-v6.png',
  '/icon-512-v6.png',
  '/icon-maskable-512-v6.png',
  '/icon-v6.svg',
]

/** オフライン応答（JSON・フロントが code で訳す）。 */
function offlineJson() {
  return new Response(JSON.stringify({ ok: false, code: 'OFFLINE', error: 'Offline' }), {
    status: 503,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
    e.respondWith(fetch(e.request).catch(() => offlineJson()))
    return
  }
  e.respondWith(
    (async () => {
      const isNav = e.request.mode === 'navigate' || url.pathname === '/'
      if (isNav) {
        try {
          const res = await fetch(e.request)
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put('/', copy))
          }
          return res
        } catch {
          const hit = await caches.match('/')
          return hit ?? offlineJson()
        }
      }
      const hit = await caches.match(e.request)
      if (hit) return hit
      const res = await fetch(e.request)
      if (res.ok && url.pathname.startsWith('/assets/')) {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(e.request, copy))
      }
      return res
    })(),
  )
})
