/* Wedding Planner Pro — Service Worker
   Caches the application shell so the app opens and works fully offline
   after the first visit. User data itself never touches this cache — it
   lives in IndexedDB (Dexie) and, optionally, in Supabase once a device is
   linked via Settings > Sync. */
const CACHE_NAME = 'wedding-planner-pro-v2';
const SHELL_FILES = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './dexie.min.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never cache/interfere with Supabase API calls — those must always hit
  // the network live so sync reflects real state.
  if(url.hostname.endsWith('supabase.co')){
    return;
  }

  if(event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      const network = fetch(event.request).then(response => {
        if(response && response.ok){
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
      // Stale-while-revalidate: serve cache instantly if present, refresh in background.
      return cached || network;
    })
  );
});
