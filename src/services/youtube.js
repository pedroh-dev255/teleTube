const yts = require('yt-search');
const config = require('../config');

// watch?v=ID | youtu.be/ID | /shorts/ID | /embed/ID | /live/ID
const YT_URL_REGEX = /(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/;

/** Padroniza o objeto de vídeo vindo do yt-search */
function normalizeVideo(video) {
  if (!video || !video.videoId) return null;
  return {
    videoId: video.videoId,
    title: video.title || 'Sem título',
    author: (video.author && video.author.name) || 'Desconhecido',
    seconds: Number(video.seconds) || 0,
    views: Number(video.views) || 0,
    thumbnail: video.thumbnail || `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`,
    url: video.url || `https://www.youtube.com/watch?v=${video.videoId}`,
  };
}

/** Busca vídeos no YouTube (não precisa de API key). Filtra lives e canais/playlists. */
async function searchVideos(query) {
  const res = await yts({ query, pages: 1 });
  return (res.videos || [])
    .filter((v) => v.type === 'video' && Number(v.seconds) > 0)
    .map(normalizeVideo);
}

/** Retorna os dados de um vídeo específico pelo ID (11 caracteres) */
async function getVideoById(videoId) {
  if (!/^[\w-]{11}$/.test(videoId)) throw new Error(`videoId inválido: ${videoId}`);
  const video = await yts({ videoId });
  const normalized = normalizeVideo(video);
  if (!normalized) throw new Error('Vídeo não encontrado.');
  return normalized;
}

/** Extrai o ID de um vídeo a partir de uma URL do YouTube (ou null) */
function extractVideoId(text) {
  const match = YT_URL_REGEX.exec(String(text || '').trim());
  return match ? match[1] : null;
}

/** Recorta uma página da lista de resultados */
function paginate(videos, page, perPage = config.search.resultsPerPage) {
  const start = (page - 1) * perPage;
  return videos.slice(start, start + perPage);
}

module.exports = { searchVideos, getVideoById, extractVideoId, paginate, normalizeVideo, YT_URL_REGEX };
