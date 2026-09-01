/* DESIGN
   ------
   * The app shell uses network-first so online visits receive the latest
   * deploy while an installed copy remains available offline.
   *
   * Versioned files under vendor use cache-first. Core reading assets and
   * interface fonts are precached; export fonts and OCR models stay lazy so
   * first install remains small.
   *
   * Cache names use content revisions checked by the test suite. Shell
   * deploys stay isolated while unchanged versioned assets remain cached.
   *
   * I do not call skipWaiting(). A reader can remain open for hours, and
   * replacing its service worker mid-session could mix two app versions.
*/


// --- CONSTANTS ---

const SHELL_CACHE_REVISION = '5b86544c3c3a';
const RUNTIME_CACHE_REVISION = '8b874267d44c';
const SHELL_CACHE = `veil-shell-${SHELL_CACHE_REVISION}`;
const RUNTIME_CACHE = `veil-runtime-${RUNTIME_CACHE_REVISION}`;
const ACTIVE_CACHES = new Set([SHELL_CACHE, RUNTIME_CACHE]);
const RUNTIME_ROOT_PATH = new URL('./vendor/', self.location.href).pathname;

const SHELL_PRECACHE_URLS = [
  './',
  './reader.html',
  './index.html',
  './app.js',
  './assets.js',
  './ocr.js',
  './export.js',
  './session.js',
  './core.js',
  './style.css',
  './landing.css',
  './landing.js',
  './sw-register.js',
  './manifest.json',
  './icon/favicon.svg',
  './icon/manifest-icon.png',
  './icon/manifest.png',
  './icon/apple-touch-icon.png',
];

const RUNTIME_PRECACHE_URLS = [
  './vendor/pdfjs/5.4.149/pdf.min.mjs',
  './vendor/pdfjs/5.4.149/pdf.worker.min.mjs',
  './vendor/fonts/ibm-plex-sans/23/ibm-plex-sans.css',
  './vendor/fonts/ibm-plex-sans/23/ibm-plex-sans-italic-cyrillic-ext.woff2',
  './vendor/fonts/ibm-plex-sans/23/ibm-plex-sans-italic-cyrillic.woff2',
  './vendor/fonts/ibm-plex-sans/23/ibm-plex-sans-italic-greek.woff2',
  './vendor/fonts/ibm-plex-sans/23/ibm-plex-sans-italic-vietnamese.woff2',
  './vendor/fonts/ibm-plex-sans/23/ibm-plex-sans-italic-latin-ext.woff2',
  './vendor/fonts/ibm-plex-sans/23/ibm-plex-sans-italic-latin.woff2',
  './vendor/fonts/ibm-plex-sans/23/ibm-plex-sans-normal-cyrillic-ext.woff2',
  './vendor/fonts/ibm-plex-sans/23/ibm-plex-sans-normal-cyrillic.woff2',
  './vendor/fonts/ibm-plex-sans/23/ibm-plex-sans-normal-greek.woff2',
  './vendor/fonts/ibm-plex-sans/23/ibm-plex-sans-normal-vietnamese.woff2',
  './vendor/fonts/ibm-plex-sans/23/ibm-plex-sans-normal-latin-ext.woff2',
  './vendor/fonts/ibm-plex-sans/23/ibm-plex-sans-normal-latin.woff2',
];


// --- LIFECYCLE ---

self.addEventListener('install', (event) => {
  event.waitUntil(Promise.all([
    caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_PRECACHE_URLS)),
    caches.open(RUNTIME_CACHE).then(cache => cache.addAll(RUNTIME_PRECACHE_URLS)),
  ]));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys
        .filter(key => key.startsWith('veil-') && !ACTIVE_CACHES.has(key))
        .map(key => caches.delete(key)),
    )),
  );
});


// --- FETCH ---

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith(RUNTIME_ROOT_PATH)) {
    event.respondWith(cacheFirst(event.request, RUNTIME_CACHE));
    return;
  }

  event.respondWith(networkFirst(event.request, SHELL_CACHE));
});


// --- CACHING STRATEGIES ---

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  let response;
  try {
    response = await fetch(request);
  } catch (_) {
    return new Response('Network error', { status: 503 });
  }

  if (response.ok) {
    try { await cache.put(request, response.clone()); } catch (_) {}
  }
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);

  let response;
  try {
    response = await fetch(request);
  } catch (_) {
    const cached = await cache.match(request);
    return cached || new Response('Offline', { status: 503 });
  }

  if (response.ok) {
    try { await cache.put(request, response.clone()); } catch (_) {}
  }
  return response;
}
