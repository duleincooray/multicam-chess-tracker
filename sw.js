// Service worker: lets the installed app open without internet.
// Network first, so a new version on GitHub Pages is picked up as soon as you're online;
// the cached copy is only used when the network isn't there.
const CACHE = 'chesscam-v2';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/style.css',
  'js/app.js', 'js/vision.js', 'js/tracker.js', 'js/storage.js', 'js/folder.js', 'js/research.js',
  'js/boardinfo.js', 'js/openings.js', 'js/share.js', 'js/engine.js', 'js/analysis.js',
  'vendor/chess.js', 'vendor/gifenc.js', 'vendor/openings.json',
  ...['w', 'b'].flatMap((c) => ['K', 'Q', 'R', 'B', 'N', 'P'].map((t) => `vendor/pieces/${c}${t}.svg`)),
  'icons/icon-192.png', 'icons/favicon-32.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))),
  );
});
