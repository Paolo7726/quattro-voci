const CACHE_NAME = 'quattro-voci-v2';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Richieste verso altri siti (traduzione, Firestore, font Google, ecc.): il service worker non
  // le tocca affatto, vanno dritte alla rete. Metterle in cache rischierebbe dati vecchi o
  // sincronizzazioni strane, ed è comunque compito del servizio remoto gestirle, non nostro.
  if (new URL(req.url).origin !== self.location.origin) return;

  // Pagina HTML: prova sempre la rete per prima, cache solo come riserva offline.
  // Cosi ogni aggiornamento che pubblichi arriva subito, senza bisogno di disinstallare l'app.
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Tutto il resto (icone, manifest, font): cache immediata, aggiornamento in background.
  // Il clone va fatto SUBITO alla risposta della rete, non dentro il .then() successivo di
  // caches.open(): quell'attesa asincrona può arrivare quando il corpo è già stato consumato,
  // dando l'errore "Response body is already used" e lasciando la cache non aggiornata.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
