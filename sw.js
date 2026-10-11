const CACHE_NAME = 'quattro-voci-v4';
// Cache separata e PERMANENTE per i dati del promemoria (ultima pratica, lingua, attivo/no).
// La pagina ci scrive, il service worker la legge quando il browser lo sveglia in background.
// Non va mai cancellata dalla pulizia delle cache vecchie qui sotto.
const META_CACHE = 'qv-meta';
const META_URL = './__qv-meta.json';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png'
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
      Promise.all(keys.filter((k) => k !== CACHE_NAME && k !== META_CACHE).map((k) => caches.delete(k)))
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
  // Solo le risposte riuscite (200) finiscono in cache: un 404 non deve diventare "la" versione.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

/* ---------- PROMEMORIA REALE IN BACKGROUND ----------
   Con l'app installata (anche dal Play Store), Chrome sveglia il service worker circa una volta
   al giorno tramite Periodic Background Sync — anche con l'app chiusa, senza server e senza costi.
   Qui si controlla se oggi l'utente si è già esercitato: se no, parte la notifica.
   La frequenza esatta la decide il browser in base a quanto viene usata l'app. */
function swTodayStr() { return new Date().toISOString().slice(0, 10); }

async function readMeta() {
  try {
    const cache = await caches.open(META_CACHE);
    const res = await cache.match(META_URL);
    return res ? await res.json() : null;
  } catch (e) { return null; }
}
async function writeMeta(meta) {
  try {
    const cache = await caches.open(META_CACHE);
    await cache.put(META_URL, new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
  } catch (e) { /* niente */ }
}

async function maybeRemind() {
  const meta = await readMeta();
  if (!meta || !meta.enabled) return;
  const today = swTodayStr();
  if (meta.lastPractice === today) return;   // già esercitato oggi
  if (meta.lastShown === today) return;      // promemoria già mostrato oggi
  const hour = new Date().getHours();
  if (hour < 9 || hour >= 22) return;        // niente notifiche di notte
  // Se l'app è aperta in primo piano, il promemoria lo gestisce già la pagina.
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (wins.some((w) => w.visibilityState === 'visible')) return;
  const label = meta.langLabel || 'la tua lingua';
  const streak = meta.streak || 0;
  const body = streak > 1
    ? `Hai una serie di ${streak} giorni con ${label}: bastano 5 minuti per non perderla!`
    : `Non ti sei ancora esercitato oggi con ${label}. Anche solo 5 minuti fanno la differenza!`;
  await self.registration.showNotification('Quattro Voci', {
    body,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: 'qv-daily-reminder',
    renotify: false,
  });
  meta.lastShown = today;
  await writeMeta(meta);
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'qv-daily-reminder') {
    event.waitUntil(maybeRemind());
  }
});

// Tocco sulla notifica: riporta in primo piano l'app se è già aperta, altrimenti la apre.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if ('focus' in w) return w.focus();
    }
    return self.clients.openWindow('./index.html');
  })());
});
