const CACHE_NAME = 'neo-viz-v1'

function isRuntimeCacheable(url) {
  return (
    url.pathname.startsWith('/models/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/_next/static/')
  )
}

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

// Live orbital/telemetry data (/api/*) is deliberately never cached here —
// serving a stale NASA feed offline would be misleading. Only the static
// app shell (JS chunks, 3D models, icons) and the last-loaded page get
// cached, so a repeat visit is instant and a fully offline visit still
// renders something instead of a browser error page.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put('/', clone))
          return response
        })
        .catch(() => caches.match('/').then((cached) => cached ?? Response.error())),
    )
    return
  }

  if (isRuntimeCacheable(url)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
          }
          return response
        })
      }),
    )
  }
})
