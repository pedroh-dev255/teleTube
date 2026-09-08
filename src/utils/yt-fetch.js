'use strict';

const https = require('https');
const { Readable } = require('stream');

/**
 * Fetch customizado para as requisições do youtubei.js.
 *
 * O googlevideo.com (servidor de mídia do YouTube) valida:
 *   1. O User-Agent compatível com o cliente que gerou a URL (`c=ANDROID_VR`,
 *      `c=IOS` etc.) — a lib envia os streams SEM User-Agent;
 *   2. O endereço IP que solicitou a URL (parâmetro `ip=`). Se o download
 *      sair por uma família de IP diferente da usada no getInfo
 *      (IPv6 vs IPv4), ele responde 403 Forbidden.
 *
 * Este wrapper:
 *   - Define o User-Agent correto conforme o parâmetro `c=` da URL;
 *   - Em caso de erro, repete o download forçando a família de IP vinculada
 *     na URL (e depois a outra), via https.request com `family` + `servername`.
 */

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let clientsCache = null;

async function getClients() {
  if (clientsCache) return clientsCache;

  try {
    const yt = await import('youtubei.js');
    clientsCache = (yt.Constants && yt.Constants.CLIENTS) || {};
  } catch (_) {
    clientsCache = {};
  }

  return clientsCache;
}

function isGooglevideo(url) {
  return url.includes('.googlevideo.com/');
}

function toPlainHeaders(input) {
  const headers = {};

  if (!input) return headers;

  if (typeof input.forEach === 'function') {
    input.forEach((value, key) => {
      headers[String(key).toLowerCase()] = value;
    });
  } else {
    for (const [key, value] of Object.entries(input)) {
      headers[key.toLowerCase()] = value;
    }
  }

  return headers;
}

/** GET com família de IP forçada (4 ou 6), seguindo redirecionamentos */
function httpsGet(url, headers, family, redirects = 3) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);

    const req = https.request(
      {
        hostname: target.hostname,
        port: 443,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        family,
        servername: target.hostname,
        headers: { ...headers, host: target.hostname },
      },
      (res) => {
        const status = res.statusCode || 0;

        if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
          res.resume();

          const next = new URL(res.headers.location, target).toString();

          resolve(httpsGet(next, headers, family, redirects - 1));
          return;
        }

        const responseHeaders = {};

        for (const [key, value] of Object.entries(res.headers)) {
          responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
        }

        resolve(new Response(Readable.toWeb(res), { status, headers: responseHeaders }));
      }
    );

    req.setTimeout(60000, () =>
      req.destroy(new Error('timeout na conexão com o servidor de mídia')),
    );

    req.on('error', reject);
    req.end();
  });
}

function createYtFetch() {
  return async function ytFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);

    if (!isGooglevideo(url)) {
      return fetch(input, init);
    }

    // 1) User-Agent compatível com o cliente que gerou a URL
    const parsed = new URL(url);
    const clientKey = (parsed.searchParams.get('c') || 'WEB').toUpperCase();
    const clients = await getClients();
    const client = clients[clientKey];

    const headers = toPlainHeaders(init.headers);
    headers['user-agent'] = (client && client.USER_AGENT) || DESKTOP_UA;

    const response = await fetch(url, { ...init, headers });

    if (response.ok) return response;

    // 2) 403/etc.: tenta forçar a família de IP vinculada na URL (e depois a outra)
    const ipParam = parsed.searchParams.get('ip') || '';
    const boundFamily = ipParam.includes(':') ? 6 : 4;
    const families = boundFamily === 6 ? [6, 4] : [4, 6];

    console.warn(
      `[youtube] Stream respondeu ${response.status}; tentando novamente com User-Agent de ${clientKey} via IPv${families[0]}...`,
    );

    for (const family of families) {
      try {
        const retry = await httpsGet(url, headers, family);

        if (retry.ok) {
          console.warn(`[youtube] Download OK forçando IPv${family}.`);
          return retry;
        }

        console.warn(`[youtube] Retry via IPv${family} devolveu ${retry.status}.`);
      } catch (err) {
        console.warn(`[youtube] Retry via IPv${family} falhou: ${err.message}`);
      }
    }

    // Nada funcionou: devolve a resposta original para o erro padrão da lib
    return response;
  };
}

module.exports = { createYtFetch };
