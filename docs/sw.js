/* Service worker: deja la app abriendo instantánea.
   Al publicar cambios, subir VERSION para invalidar el caché. */
const VERSION = 'pedidos-v7';

/* Los assets van versionados desde index.html: es lo único que le gana a un
   service worker viejo que quedó sirviendo caché-primero, porque esa URL no
   existe en su caché y se ve obligado a ir a la red.
   Al publicar cambios hay que subir VERSION acá y el ?v= de index.html. */
const RECURSOS = [
  './',
  './index.html',
  './styles.css?v=7',
  './app.js?v=7',
  './config.js?v=7',
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

  /* Red primero, caché como red de contención.
     Al revés —caché primero— un cambio publicado tardaba dos aperturas en
     verse: la primera servía lo viejo y recién ahí refrescaba. Con la app ya
     instalada eso es muy confuso. La caída a caché mantiene el arranque
     offline. */
  e.respondWith(
    fetch(e.request)
      .then((respuesta) => {
        if (respuesta && respuesta.status === 200) {
          const copia = respuesta.clone();
          caches.open(VERSION).then((c) => c.put(
            e.request.mode === 'navigate' ? './index.html' : e.request, copia));
        }
        return respuesta;
      })
      .catch(() => caches.match(e.request.mode === 'navigate' ? './index.html' : e.request))
  );
});
