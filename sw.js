/* Lotus Bus — service worker for the installable (Add to Home Screen) app.
   Network first so the demo always shows the latest deploy; the cache is only a fallback
   for a flaky connection. The sync API and map tiles are never cached (they must be live). */

const CACHE = 'lotus-bus-v4';
const SHELL = [
  '/', '/student/', '/driver/', '/admin/',
  '/shared/core.js', '/shared/map.js', '/shared/mb.css', '/shared/lum-crest.svg', '/shared/lum-logo.svg',
  '/shared/vendor/leaflet.css', '/shared/vendor/leaflet.js', '/shared/vendor/protomaps-leaflet.js',
  '/student/student.js', '/student/student.css',
  '/driver/driver.js', '/driver/driver.css',
  '/admin/admin.js',
  '/shared/icons/icon-180.png', '/shared/icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  // live data and PMTiles byte-range requests go straight to the network
  if (sameOrigin && (url.pathname.startsWith('/api/') || url.pathname.endsWith('.pmtiles') || req.headers.has('range'))) return;
  if (!sameOrigin && !url.hostname.endsWith('googleapis.com') && !url.hostname.endsWith('gstatic.com')) return;

  e.respondWith(
    fetch(req, sameOrigin ? { cache: 'no-cache' } : undefined).then((res) => {
      if (res.ok || res.type === 'opaque') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
