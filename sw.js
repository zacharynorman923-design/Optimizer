/* Optimizer service worker — offline app shell + return data.
   Bump VERSION on every release so clients discard the old cached shell. */
const VERSION = 'optimizer-v6';
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;

/* Paths are relative to the SW scope (this folder). */
const SHELL_ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/data.js',
  './js/stats.js',
  './js/optimize.js',
  './js/charts.js',
  './manifest.webmanifest',
  './icons/icon.svg',
];
const DATA = 'data/processed/optimizer_returns.json';
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => c.addAll([...SHELL_ASSETS, `./${DATA}`])).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* Return data is network-first, so a data refresh shows up on the next load;
   the cached copy keeps the app working offline. Everything else: cache-first. */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (FONT_HOSTS.includes(url.hostname)) { event.respondWith(cacheFirst(req, RUNTIME)); return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith(DATA)) { event.respondWith(networkFirst(req, SHELL)); return; }
  if (req.mode === 'navigate') {
    event.respondWith(cacheFirst(req, SHELL).catch(() => caches.match('./index.html')));
    return;
  }
  event.respondWith(cacheFirst(req, SHELL));
});

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  try { const c = await caches.open(cacheName); c.put(request, response.clone()); } catch (e) {}
  return response;
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request, { cache: 'no-cache' });
    if (response.ok) { const c = await caches.open(cacheName); c.put(request, response.clone()); }
    return response;
  } catch (e) {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw e;
  }
}
