const SHELL_CACHE = 'social-land-shell-v1'
const ASSET_CACHE = 'social-land-assets-v1'
const SHELL_URLS = ['/', '/manifest.webmanifest', '/pwa-icon.svg', '/pwa-icon-192.png', '/pwa-icon-512.png', '/pwa-icon-maskable-512.png']

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys
      .filter(key => key.startsWith('social-land-') && ![SHELL_CACHE, ASSET_CACHE].includes(key))
      .map(key => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/') || url.pathname.startsWith('/uploads/') || url.pathname.startsWith('/models/') || url.pathname.startsWith('/mediapipe/')) return

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request)
        if (response.ok) {
          const cache = await caches.open(SHELL_CACHE)
          await cache.put('/', response.clone())
        }
        return response
      } catch {
        return await caches.match('/') || Response.error()
      }
    })())
    return
  }

  if (!url.pathname.startsWith('/assets/') && !/\.(?:css|js|mjs|svg|png|jpe?g|webp|woff2?)$/i.test(url.pathname)) return

  event.respondWith((async () => {
    const cache = await caches.open(ASSET_CACHE)
    const cached = await cache.match(request)
    if (cached) return cached
    try {
      const response = await fetch(request)
      if (response.ok && response.type === 'basic') await cache.put(request, response.clone())
      return response
    } catch {
      return Response.error()
    }
  })())
})
