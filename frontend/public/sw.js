/*
 * SmartConnect Collab service worker (T.39) — installability and faster
 * repeat loads of STATIC files only.
 *
 * Cached (cache-first): the build's content-hashed files under /assets/ and
 * the app icons under /icons/. Their URLs change whenever their content does,
 * so a cached copy is never stale.
 *
 * NEVER cached, never intercepted: page navigations (index.html), the API
 * (/api — and the API is usually on another origin anyway), Socket.IO,
 * authentication, messages, tasks, signed attachment downloads (Cloudinary,
 * another origin), and anything not GET. Those requests go straight to the
 * network exactly as without a service worker. No offline writes, no
 * background sync, no push.
 */
const CACHE = 'smartconnect-static-v1';
const MAX_ENTRIES = 150;
const CACHEABLE = /^\/(assets|icons)\/[^?#]+$/;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('smartconnect-static-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const trim = async (cache) => {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await cache.delete(key);
};

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !CACHEABLE.test(url.pathname) || url.search) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        await cache.put(request, response.clone());
        void trim(cache);
      }
      return response;
    })
  );
});
