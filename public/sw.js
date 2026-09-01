// Bumped from v2: the previous cache stored /api/ responses, which froze live call
// status on whatever the first poll returned. Renaming the cache discards those entries.
const CACHE_NAME = 'telecall-shell-v3'
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg']

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)

  // The API is live data: call status is polled every second and account changes must be
  // seen immediately. Never cache it, and never answer it from the cache.
  if (url.pathname.startsWith('/api/')) return

  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return

  // Navigations: fresh when online, cached shell when not.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const copy = response.clone()
          caches.open(CACHE_NAME).then(cache => cache.put('/index.html', copy))
          return response
        })
        .catch(() => caches.match('/index.html')),
    )
    return
  }

  // Static assets are content-hashed, so a cache hit is always correct.
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
      if (!response.ok) return response
      const copy = response.clone()
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy))
      return response
    })),
  )
})
