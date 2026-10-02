// ============================================================================
// Worker Cloudflare per Quattro Voci — nasconde la chiave Azure Translator.
//
// COME PUBBLICARLO:
//   1. Vai su https://dash.cloudflare.com → Workers e Pages → Crea → Worker.
//   2. Dagli un nome (es. "quattro-voci-translate") e crealo.
//   3. Apri "Modifica codice", cancella il contenuto di esempio e incolla questo file.
//   4. Salva e pubblica ("Deploy").
//   5. Vai in Impostazioni del Worker → Variabili → aggiungi:
//        AZURE_KEY     (tipo "Secret", il valore è la chiave della tua risorsa Translator)
//        AZURE_REGION  (tipo normale, es. "westeurope" — la regione scelta creando la risorsa)
//   6. Copia l'indirizzo del Worker (tipo https://quattro-voci-translate.tuo-account.workers.dev)
//      e incollalo in index.html al posto di AZURE_WORKER_URL.
// ============================================================================

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);
    const text = url.searchParams.get('text');
    const from = url.searchParams.get('from') || '';
    const to = url.searchParams.get('to');
    // Se presente, richiede anche la traslitterazione in caratteri latini del testo tradotto.
    // Valori attesi: "Arab" (arabo), "Hans" (cinese semplificato), "Jpan" (giapponese), "Cyrl" (russo).
    const translitScript = url.searchParams.get('translit');

    const jsonHeaders = { ...cors, 'Content-Type': 'application/json' };

    if (!text || !to) {
      return new Response(JSON.stringify({ error: 'missing text or to parameter' }), { status: 400, headers: jsonHeaders });
    }
    if (!env.AZURE_KEY || !env.AZURE_REGION) {
      return new Response(JSON.stringify({ error: 'Worker non configurato: mancano AZURE_KEY o AZURE_REGION nelle variabili' }), { status: 500, headers: jsonHeaders });
    }

    try {
      const translateUrl = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${encodeURIComponent(to)}${from ? `&from=${encodeURIComponent(from)}` : ''}`;
      const azureRes = await fetch(translateUrl, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': env.AZURE_KEY,
          'Ocp-Apim-Subscription-Region': env.AZURE_REGION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([{ Text: text }]),
      });
      const azureData = await azureRes.json();
      if (!azureRes.ok) {
        return new Response(JSON.stringify({ error: 'azure translate error', detail: azureData }), { status: 502, headers: jsonHeaders });
      }

      const translated = azureData?.[0]?.translations?.[0]?.text || '';
      const detectedFrom = azureData?.[0]?.detectedLanguage?.language || from || null;

      let translitText = null;
      if (translitScript && translated) {
        try {
          const translitUrl = `https://api.cognitive.microsofttranslator.com/transliterate?api-version=3.0&language=${encodeURIComponent(to)}&fromScript=${encodeURIComponent(translitScript)}&toScript=Latn`;
          const translitRes = await fetch(translitUrl, {
            method: 'POST',
            headers: {
              'Ocp-Apim-Subscription-Key': env.AZURE_KEY,
              'Ocp-Apim-Subscription-Region': env.AZURE_REGION,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify([{ Text: translated }]),
          });
          const translitData = await translitRes.json();
          if (translitRes.ok) translitText = translitData?.[0]?.text || null;
        } catch (e) {
          // La traslitterazione è un bonus: se fallisce, la traduzione resta comunque valida.
        }
      }

      return new Response(
        JSON.stringify({ text: translated, translit: translitText, detectedFrom }),
        { headers: jsonHeaders }
      );
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: jsonHeaders });
    }
  },
};
