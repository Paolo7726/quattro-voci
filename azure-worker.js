// ============================================================================
// Worker Cloudflare per Quattro Voci — nasconde le chiavi Azure (Translator e Speech).
// Nome del Worker: quattro-voci-translate  (è l'indirizzo scritto in index.html).
//
// VARIABILI DEL WORKER (Impostazioni → Variabili e segreti):
//   AZURE_KEY      Secret  — chiave della risorsa Azure "Translator" (piano F0)
//   AZURE_REGION   Testo   — regione della risorsa Translator (es. "westeurope")
//   SPEECH_KEY     Secret  — chiave della risorsa Azure "Speech" (piano F0) — NON quella del Translator
//   SPEECH_REGION  Testo   — regione della risorsa Speech (es. "westeurope")
//   APPCHECK_MODE  Testo   — facoltativa. "enforce" (predefinito se manca) = accetta solo richieste
//                            con un gettone App Check valido dell'app; "off" = controllo spento
//                            (da usare SOLO in emergenza, se App Check smettesse di funzionare).
// FACOLTATIVO: memoria condivisa dell'audio (KV) — Associazioni → Spazio dei nomi KV,
//   nome variabile TTS_CACHE. Così ogni frase si genera da Azure UNA volta sola per tutti.
//   Senza funziona lo stesso (l'app conserva comunque l'audio sul telefono di ciascuno).
//
// PROTEZIONI (dalla più forte alla più leggera):
//   1. App Check: l'app manda in ogni richiesta un "gettone" firmato da Google che dimostra che
//      la richiesta arriva davvero da Quattro Voci (reCAPTCHA Enterprise). Chi chiama il Worker
//      da un terminale o da un altro sito non ce l'ha e riceve 401.
//   2. Origin: dal browser sono accettate solo le richieste che arrivano da paolo7726.github.io.
//   3. Limite di richieste per indirizzo IP (al minuto), tenuto in memoria dal Worker.
//   4. Lunghezza massima dei testi (traduzione 500 caratteri, voce 300).
// Il piano Azure F0 non addebita mai nulla: superata la soglia gratuita risponde con un errore e
// l'app usa le riserve (MyMemory per le traduzioni, voce del telefono per l'audio).
// ============================================================================

const ALLOWED_ORIGIN = 'https://paolo7726.github.io';
const MAX_TEXT_LENGTH = 500;
const TTS_MAX_LENGTH = 300;

// App Check del progetto Firebase "quattro-voci" (numero di progetto 621886572166).
const FIREBASE_PROJECT_NUMBER = '621886572166';
const APPCHECK_ISSUER = `https://firebaseappcheck.googleapis.com/${FIREBASE_PROJECT_NUMBER}`;
const APPCHECK_AUDIENCE = `projects/${FIREBASE_PROJECT_NUMBER}`;
const APPCHECK_JWKS_URL = 'https://firebaseappcheck.googleapis.com/v1/jwks';

// Limiti al minuto per singolo indirizzo IP. Un utente vero non ci arriva mai.
const RATE_LIMITS = { translate: 40, tts: 80 };

const TTS_VOICES = {
  it: 'it-IT-ElsaNeural',
  en: 'en-US-JennyNeural',
  fr: 'fr-FR-DeniseNeural',
  es: 'es-ES-ElviraNeural',
  de: 'de-DE-KatjaNeural',
  pt: 'pt-BR-FranciscaNeural',
  ar: 'ar-SA-ZariyahNeural',
  zh: 'zh-CN-XiaoxiaoNeural',
  ja: 'ja-JP-NanamiNeural',
  ru: 'ru-RU-SvetlanaNeural',
  tr: 'tr-TR-EmelNeural',
};

// ---------------------------------------------------------------------------
// Limite di richieste (in memoria: vale per la singola istanza del Worker, che Cloudflare
// tiene viva per un po'. Non è perfetto ma ferma chi martella il Worker in rapida successione.)
// ---------------------------------------------------------------------------
const rateBuckets = new Map();
function rateLimited(kind, ip) {
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  const key = kind + '|' + ip;
  let b = rateBuckets.get(key);
  if (!b || b.minute !== minute) { b = { minute, count: 0 }; rateBuckets.set(key, b); }
  b.count++;
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) if (v.minute !== minute) rateBuckets.delete(k);
  }
  return b.count > (RATE_LIMITS[kind] || 40);
}

// ---------------------------------------------------------------------------
// Verifica del gettone App Check (JWT RS256 firmato da Google)
// ---------------------------------------------------------------------------
let jwksCache = { keys: null, until: 0 };
async function getJwks(force) {
  if (!force && jwksCache.keys && Date.now() < jwksCache.until) return jwksCache.keys;
  const res = await fetch(APPCHECK_JWKS_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!res.ok) throw new Error('jwks fetch ' + res.status);
  const data = await res.json();
  jwksCache = { keys: data.keys || [], until: Date.now() + 3600 * 1000 };
  return jwksCache.keys;
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToJson(s) { return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))); }

const tokenOkCache = new Map(); // gettone già verificato → scadenza (ms)
async function verifyAppCheck(token) {
  if (!token || token.length > 4096) return false;
  const cachedExp = tokenOkCache.get(token);
  if (cachedExp && cachedExp > Date.now()) return true;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  let header, payload;
  try { header = b64urlToJson(parts[0]); payload = b64urlToJson(parts[1]); } catch (e) { return false; }
  if (header.alg !== 'RS256' || header.typ !== 'JWT' || !header.kid) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.iss !== APPCHECK_ISSUER) return false;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(APPCHECK_AUDIENCE)) return false;
  if (typeof payload.exp !== 'number' || payload.exp < nowSec) return false;
  if (!payload.sub) return false;

  let keys = await getJwks(false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await getJwks(true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) return false;
  const key = await crypto.subtle.importKey(
    'jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1])
  );
  if (ok) {
    tokenOkCache.set(token, payload.exp * 1000);
    if (tokenOkCache.size > 2000) {
      const now = Date.now();
      for (const [t, exp] of tokenOkCache) if (exp < now) tokenOkCache.delete(t);
    }
  }
  return ok;
}

// ---------------------------------------------------------------------------
function xmlEscape(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Audio MP3 della frase. Ordine: memoria KV (se c'è) → Azure Speech.
async function handleTts(url, env, ctx, cors) {
  const jsonHeaders = { ...cors, 'Content-Type': 'application/json' };
  const lang = url.searchParams.get('lang') || '';
  const text = (url.searchParams.get('text') || '').trim();
  const voice = TTS_VOICES[lang];
  if (!voice || !text) {
    return new Response(JSON.stringify({ error: 'missing or unsupported lang/text' }), { status: 400, headers: jsonHeaders });
  }
  if (text.length > TTS_MAX_LENGTH) {
    return new Response(JSON.stringify({ error: `text too long (max ${TTS_MAX_LENGTH} characters)` }), { status: 413, headers: jsonHeaders });
  }
  const audioHeaders = { ...cors, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=31536000, immutable' };
  const hash = await sha256Hex(text);
  const key = voice + ':' + hash;
  if (env.TTS_CACHE) {
    try {
      const hit = await env.TTS_CACHE.get(key, 'arrayBuffer');
      if (hit) return new Response(hit, { headers: { ...audioHeaders, 'X-QV-Cache': 'HIT' } });
    } catch (e) { /* memoria non disponibile */ }
  }

  if (!env.SPEECH_KEY || !env.SPEECH_REGION) {
    return new Response(JSON.stringify({ error: 'tts not configured' }), { status: 503, headers: jsonHeaders });
  }

  const xmlLang = voice.split('-').slice(0, 2).join('-');
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${xmlLang}">` +
    `<voice name="${voice}"><prosody rate="-8%">${xmlEscape(text)}</prosody></voice></speak>`;
  const azureRes = await fetch(`https://${env.SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': env.SPEECH_KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'quattro-voci',
    },
    body: ssml,
  });
  if (!azureRes.ok) {
    const status = azureRes.status === 429 ? 429 : 502;
    return new Response(JSON.stringify({ error: 'azure tts error', status: azureRes.status }), { status, headers: jsonHeaders });
  }
  const audio = await azureRes.arrayBuffer();
  if (env.TTS_CACHE && audio.byteLength > 0) {
    // Piano gratuito KV: 1.000 scritture al giorno; oltre, l'audio arriva comunque, solo non viene memorizzato.
    ctx.waitUntil(env.TTS_CACHE.put(key, audio.slice(0)).catch(() => {}));
  }
  return new Response(audio, { headers: { ...audioHeaders, 'X-QV-Cache': 'MISS' } });
}

async function handleTranslate(url, env, jsonHeaders) {
  const text = url.searchParams.get('text');
  const from = url.searchParams.get('from') || '';
  const to = url.searchParams.get('to');
  // Traslitterazione facoltativa: "Arab", "Jpan", "Cyrl".
  const translitScript = url.searchParams.get('translit');

  if (!text || !to) {
    return new Response(JSON.stringify({ error: 'missing text or to parameter' }), { status: 400, headers: jsonHeaders });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return new Response(JSON.stringify({ error: `text too long (max ${MAX_TEXT_LENGTH} characters)` }), { status: 413, headers: jsonHeaders });
  }
  if (!/^[A-Za-z-]{2,10}$/.test(to) || (from && !/^[A-Za-z-]{2,10}$/.test(from))) {
    return new Response(JSON.stringify({ error: 'invalid language code' }), { status: 400, headers: jsonHeaders });
  }
  if (!env.AZURE_KEY || !env.AZURE_REGION) {
    return new Response(JSON.stringify({ error: 'Worker non configurato: mancano AZURE_KEY o AZURE_REGION nelle variabili' }), { status: 500, headers: jsonHeaders });
  }

  const azHeaders = {
    'Ocp-Apim-Subscription-Key': env.AZURE_KEY,
    'Ocp-Apim-Subscription-Region': env.AZURE_REGION,
    'Content-Type': 'application/json',
  };
  const translateUrl = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${encodeURIComponent(to)}${from ? `&from=${encodeURIComponent(from)}` : ''}`;
  const azureRes = await fetch(translateUrl, { method: 'POST', headers: azHeaders, body: JSON.stringify([{ Text: text }]) });
  const azureData = await azureRes.json().catch(() => null);
  if (!azureRes.ok) {
    const status = azureRes.status === 429 ? 429 : 502;
    return new Response(JSON.stringify({ error: 'azure translate error', status: azureRes.status }), { status, headers: jsonHeaders });
  }

  const translated = azureData?.[0]?.translations?.[0]?.text || '';
  const detectedFrom = azureData?.[0]?.detectedLanguage?.language || from || null;

  let translitText = null;
  if (translitScript && /^[A-Za-z]{4}$/.test(translitScript) && translated) {
    try {
      const translitUrl = `https://api.cognitive.microsofttranslator.com/transliterate?api-version=3.0&language=${encodeURIComponent(to)}&fromScript=${encodeURIComponent(translitScript)}&toScript=Latn`;
      const translitRes = await fetch(translitUrl, { method: 'POST', headers: azHeaders, body: JSON.stringify([{ Text: translated }]) });
      const translitData = await translitRes.json();
      if (translitRes.ok) translitText = translitData?.[0]?.text || null;
    } catch (e) { /* la traslitterazione è un bonus */ }
  }

  return new Response(JSON.stringify({ text: translated, translit: translitText, detectedFrom }), { headers: jsonHeaders });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Firebase-AppCheck',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const jsonHeaders = { ...cors, 'Content-Type': 'application/json' };
    const deny = (status, error) => new Response(JSON.stringify({ error }), { status, headers: jsonHeaders });

    if (request.method !== 'GET') return deny(405, 'method not allowed');
    if (origin && origin !== ALLOWED_ORIGIN) return deny(403, 'origin not allowed');

    const url = new URL(request.url);
    const isTts = url.pathname === '/tts';
    if (!isTts && url.pathname !== '/') return deny(404, 'not found');

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (rateLimited(isTts ? 'tts' : 'translate', ip)) return deny(429, 'too many requests');

    const mode = (env.APPCHECK_MODE || 'enforce').toLowerCase();
    if (mode !== 'off') {
      let ok = false;
      try { ok = await verifyAppCheck(request.headers.get('X-Firebase-AppCheck')); } catch (e) { ok = false; }
      if (!ok) return deny(401, 'app check required');
    }

    try {
      return isTts ? await handleTts(url, env, ctx, cors) : await handleTranslate(url, env, jsonHeaders);
    } catch (e) {
      return deny(500, 'internal error');
    }
  },
};
