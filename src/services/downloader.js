const fs = require('fs');
const path = require('path');
const https = require('https');
const ytdl = require('@distube/ytdl-core');
const config = require('../config');
const { sanitizeFilename } = require('../utils/format');

const MAX_UPLOAD_BYTES = config.telegram.maxUploadMB * 1024 * 1024;

/** Tamanho estimado do formato (contentLength ou bitrate x duração) */
function estimateFormatSize(format, durationSeconds) {
  if (format.contentLength) return Number(format.contentLength);
  const bitrate = Number(format.bitrate) || Number(format.averageBitrate);
  if (bitrate && durationSeconds) return Math.round((bitrate / 8) * durationSeconds);
  return null;
}

/**
 * Escolhe o melhor formato de áudio que caiba no limite do Telegram.
 * Preferência: m4a (melhor compatibilidade no Telegram), maior bitrate possível.
 * Retorna { format, size } ou null quando nem o menor formato cabe.
 */
function pickAudio(info) {
  const formats = ytdl.filterFormats(info.formats, 'audioonly');
  if (!formats.length) return null;
  const duration = Number(info.videoDetails.lengthSeconds) || 0;

  const m4a = formats.filter((f) => f.container === 'm4a' || f.audioCodec === 'mp4a.40.2');
  const pool = (m4a.length ? m4a : formats)
    .map((f) => ({ format: f, size: estimateFormatSize(f, duration) }))
    .sort((a, b) => (b.format.audioBitrate || 0) - (a.format.audioBitrate || 0));

  const fits = pool.find((c) => c.size !== null && c.size <= MAX_UPLOAD_BYTES);
  if (fits) return fits;

  const smallest = pool[pool.length - 1]; // pool ordenado por bitrate desc
  if (smallest.size !== null && smallest.size > MAX_UPLOAD_BYTES) return null;
  return smallest; // tamanho desconhecido: tenta mesmo assim
}

/**
 * Escolhe o melhor formato de vídeo COM áudio (progressivo, sem ffmpeg) que caiba
 * no limite do Telegram. Preferência: container mp4, maior resolução possível.
 * Retorna { format, size } ou null quando nem o menor formato cabe.
 */
function pickVideo(info) {
  const combined = ytdl.filterFormats(info.formats, 'audioandvideo');
  if (!combined.length) return null;
  const duration = Number(info.videoDetails.lengthSeconds) || 0;

  const mp4 = combined.filter((f) => f.container === 'mp4');
  const pool = (mp4.length ? mp4 : combined)
    .map((f) => ({ format: f, size: estimateFormatSize(f, duration) }))
    .sort((a, b) => (b.format.bitrate || 0) - (a.format.bitrate || 0));

  const fits = pool.find((c) => c.size !== null && c.size <= MAX_UPLOAD_BYTES);
  if (fits) return fits;

  const smallest = [...pool].sort(
    (a, b) => (a.size ?? Infinity) - (b.size ?? Infinity)
  )[0];
  if (smallest.size !== null && smallest.size > MAX_UPLOAD_BYTES) return null;
  return smallest;
}

/** Obtém os metadados/formatos do vídeo via ytdl-core */
function getVideoInfo(videoId) {
  return ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
}

/**
 * Baixa a mídia escolhida para a pasta temporária.
 * onProgress(downloadedBytes, totalBytes) é chamado durante o download.
 * Um watchdog aborta se não houver progresso por 60s.
 */
async function downloadMedia(info, choice, onProgress = () => {}) {
  const details = info.videoDetails;
  const container = ['mp4', 'm4a', 'webm'].includes(choice.format.container)
    ? choice.format.container
    : 'bin';
  const baseName = sanitizeFilename(details.title);

  fs.mkdirSync(config.tmpDir, { recursive: true });
  const filePath = path.join(config.tmpDir, `${baseName} [${details.videoId}].${container}`);

  await new Promise((resolve, reject) => {
    const stream = ytdl.downloadFromInfo(info, { format: choice.format });
    const file = fs.createWriteStream(filePath);
    let settled = false;
    let watchdog = null;

    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        fail(new Error('Download interrompido: sem progresso por 60 segundos.'));
      }, 60000);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      stream.destroy();
      file.destroy();
      fs.unlink(filePath, () => {});
      reject(err);
    };

    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve(filePath);
    };

    armWatchdog();
    stream.on('data', armWatchdog);
    stream.on('progress', (chunk, downloaded, total) => {
      onProgress(downloaded, total || choice.size || 0);
    });
    stream.on('error', fail);
    file.on('error', fail);
    file.on('finish', done);

    stream.pipe(file);
  });

  return { filePath, size: fs.statSync(filePath).size };
}

/** Baixa a thumbnail JPEG do vídeo para anexar ao áudio (ou null se falhar) */
function downloadThumbnail(videoId) {
  const url = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  fs.mkdirSync(config.tmpDir, { recursive: true });
  const destPath = path.join(config.tmpDir, `${videoId}-${Date.now()}.jpg`);

  return new Promise((resolve) => {
    const file = fs.createWriteStream(destPath);
    const fail = () => {
      file.destroy();
      fs.unlink(destPath, () => resolve(null));
    };
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return fail();
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(destPath)));
    });
    req.on('error', fail);
    req.setTimeout(15000, () => {
      req.destroy(new Error('timeout'));
    });
  });
}

/** Remove arquivo temporário sem lançar erro */
function deleteFile(filePath) {
  if (filePath) fs.unlink(filePath, () => {});
}

module.exports = {
  MAX_UPLOAD_BYTES,
  getVideoInfo,
  pickAudio,
  pickVideo,
  downloadMedia,
  downloadThumbnail,
  deleteFile,
};
