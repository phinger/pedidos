/* Service worker: deja la app abriendo instantánea.
   Al publicar cambios, subir VERSION para invalidar el caché. */
const VERSION = 'pedidos-v2';

const RECURSOS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(RECURSOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  /* La API y el login de Google nunca se cachean. */
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  /* Navegación: red primero para tomar versiones nuevas; si no hay señal, caché. */
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          const copia = r.clone();
          caches.open(VERSION).then((c) => c.put('./index.html', copia));
          return r;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  /* Estáticos: caché primero, y se refresca en segundo plano. */
  e.respondWith(
    caches.match(e.request).then((cacheado) => {
      const red = fetch(e.request)
        .then((r) => {
          if (r && r.status === 200) {
            const copia = r.clone();
            caches.open(VERSION).then((c) => c.put(e.request, copia));
          }
          return r;
        })
        .catch(() => cacheado);
      return cacheado || red;
    })
  );
});
