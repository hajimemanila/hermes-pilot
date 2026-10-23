/* Hermes Mobile: 殻だけキャッシュする
   - 画面遷移（index.html）は network-first（デプロイ後の更新が必ず届く）
   - ハッシュ付きアセットは cache-first
   - API / WS はネットワークのみ（失敗時は 503 の JSON） */
const CACHE = 'hermes-mobile-v4'
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/icon-192-v2.png',
  '/icon-512-v2.png',
  '/icon-maskable-192-v2.png',
  '/icon-maskable-512-v2.png',
  '/icon.svg',
]

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
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error: { message: 'オフライン', code: 'OFFLINE' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    return
  }
  e.respondWith(
    (async () => {
      const isNav = e.request.mode === 'navigate' || url.pathname === '/'
      if (isNav) {
        try {
          const res = await fetch(e.request)
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put('/', copy))
          return res
        } catch {
          const hit = await caches.match('/')
          return hit ?? new Response('オフライン', { status: 503 })
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
