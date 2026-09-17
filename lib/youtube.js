'use strict';

/**
 * Busca de vídeos no YouTube — feita 100% no servidor.
 * O navegador do usuário nunca conversa com o YouTube:
 * todas as requisições partem deste módulo.
 */

const RESULTS_URL = 'https://www.youtube.com/results?hl=pt-BR&gl=BR&search_query=';

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

/** Extrai o objeto ytInitialData embutido no HTML da página de resultados. */
function extractInitialData(html) {
  const marker = 'ytInitialData';
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const start = html.indexOf('{', idx);
  if (start === -1) return null;
  const end = html.indexOf(';</script>', start);
  const raw = end === -1 ? html.slice(start) : html.slice(start, end);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Caminha pela árvore de dados coletando todos os videoRenderer encontrados. */
function collectVideoRenderers(value, out) {
  if (Array.isArray(value)) {
    for (const item of value) collectVideoRenderers(item, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (value.videoRenderer) out.push(value.videoRenderer);
  for (const key of Object.keys(value)) {
    if (key !== 'videoRenderer') collectVideoRenderers(value[key], out);
  }
}

function textOf(node) {
  if (!node) return '';
  if (node.simpleText) return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r) => r.text || '').join('');
  return '';
}

function mapRenderer(v) {
  const videoId = v && v.videoId;
  if (!videoId) return null;
  const snippets = v.detailedMetadataSnippets;
  const snippet = snippets && snippets.length ? textOf(snippets[0].snippetText) : '';
  const thumbnails = (v.thumbnail && v.thumbnail.thumbnails) || [];
  const thumb = thumbnails.length
    ? thumbnails[thumbnails.length - 1].url
    : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  return {
    videoId,
    title: textOf(v.title) || 'Sem título',
    author:
      textOf(v.ownerText) || textOf(v.longBylineText) || textOf(v.shortBylineText) || 'Desconhecido',
    views: textOf(v.viewCountText) || '',
    published: textOf(v.publishedTimeText) || '',
    duration: textOf(v.lengthText) || '',
    snippet: snippet.replace(/\s+/g, ' ').trim(),
    thumbnail: thumb,
  };
}

/** Busca vídeos no YouTube e retorna uma lista pronta para a UI. */
async function searchVideos(query) {
  const url = RESULTS_URL + encodeURIComponent(query);
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`O YouTube respondeu com HTTP ${res.status}`);
  }
  const html = await res.text();
  const data = extractInitialData(html);
  if (!data) {
    throw new Error('Não foi possível interpretar os resultados da busca');
  }

  const renderers = [];
  collectVideoRenderers(data, renderers);

  const seen = new Set();
  const results = [];
  for (const r of renderers) {
    const mapped = mapRenderer(r);
    if (mapped && !seen.has(mapped.videoId)) {
      seen.add(mapped.videoId);
      results.push(mapped);
    }
  }
  return results.slice(0, 40);
}

const THUMB_SIZES = ['hqdefault', 'mqdefault', 'default'];

/** Baixa a thumbnail de um vídeo (i.ytimg.com) para servir via proxy. */
async function fetchThumbnail(videoId) {
  let lastError = null;
  for (const size of THUMB_SIZES) {
    try {
      const res = await fetch(`https://i.ytimg.com/vi/${videoId}/${size}.jpg`, { headers: HEADERS });
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > 0) return buffer;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Thumbnail indisponível');
}

module.exports = { searchVideos, fetchThumbnail };
