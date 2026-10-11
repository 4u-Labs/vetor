const CACHE_NAME = 'vectorai-v3.4.1';
const ASSETS = [
  './',
  './index.html',
  './processing_utils.js?v=3.4.1',
  './worker_engine.js?v=3.4.1',
  './vector_worker.js',
  './vtracer_web.js',
  './geometric_snapper.js',
  './vector_engine.js',
  './vtracer_web.js?v=3.4.1',
  './geometric_snapper.js?v=3.4.1',
  './bg_remover.js?v=3.4.1',
  './industrial_exporter.js?v=3.4.1',
  './vector_engine.js?v=3.4.1',
  './ai_upscaler.js?v=3.4.1',
  './vtracer_wasm_bg.wasm',
  './realesr-general-x4v3.onnx',
  './favicon.png?v=3.0.0',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png?v=3.0.0',
  './manifest.json?v=3.0.0'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((k) => {
          if (k.startsWith('vectorai-') && k !== CACHE_NAME) return caches.delete(k);
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Network first: ensures user always gets the latest version when online
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.status === 200 && e.request.method === 'GET') {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, resClone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
