'use strict';

/**
 * Motor de downloads: baixa o vídeo no servidor com @distube/ytdl-core
 * e expõe "jobs" com progresso consultável pela UI.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const { pipeline } = require('stream/promises');
const ytdl = require('@distube/ytdl-core');
const library = require('./library');

const jobs = new Map();
const JOB_TTL_MS = 10 * 60 * 1000; // jobs finalizados ficam em memória por 10 min

/** Escolhe o melhor formato progressivo (vídeo+áudio no mesmo arquivo, p/ tocar direto no browser). */
function pickFormat(info) {
  const videoAudio = info.formats.filter((f) => f.hasVideo && f.hasAudio);
  const mp4 = videoAudio.filter((f) => (f.container || '').includes('mp4'));
  const pool = mp4.length ? mp4 : videoAudio;
  pool.sort(
    (a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0)
  );
  if (pool.length) return pool[0];
  return ytdl.chooseFormat(info.formats, { quality: 'highest', filter: 'videoandaudio' });
}

function publicJob(job) {
  return {
    id: job.id,
    videoId: job.videoId,
    status: job.status,
    progress: Math.round(job.progress * 10) / 10,
    received: job.received,
    total: job.total,
    title: job.title,
    author: job.author,
    fileId: job.fileId,
    error: job.error,
    alreadyDownloaded: job.alreadyDownloaded || false,
  };
}

function cleanupOldJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

/** Cria (ou reaproveita) um job de download para o vídeo informado. */
async function createDownloadJob(videoId) {
  if (!library.isValidVideoId(videoId)) {
    throw new Error('ID de vídeo inválido');
  }
  cleanupOldJobs();

  // já existe job ativo/concluído para esse vídeo
  for (const job of jobs.values()) {
    if (job.videoId === videoId && (job.status === 'downloading' || job.status === 'done')) {
      return publicJob(job);
    }
  }

  // o vídeo já está na biblioteca
  const existing = await library.findByVideoId(videoId);
  if (existing) {
    return {
      id: null,
      videoId,
      status: 'done',
      progress: 100,
      received: existing.sizeBytes,
      total: existing.sizeBytes,
      title: existing.title,
      author: existing.author,
      fileId: existing.fileId,
      error: null,
      alreadyDownloaded: true,
    };
  }

  const job = {
    id: crypto.randomUUID(),
    videoId,
    fileId: crypto.randomUUID(),
    status: 'downloading',
    progress: 0,
    received: 0,
    total: 0,
    title: '',
    author: '',
    error: null,
    alreadyDownloaded: false,
    canceled: false,
    cancelFn: null,
    finishedAt: null,
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  runJob(job).catch(() => {}); // erros já são tratados dentro de runJob
  return publicJob(job);
}

async function runJob(job) {
  const filePath = library.videoPath(job.fileId);
  try {
    const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${job.videoId}`);
    const details = info.videoDetails;
    job.title = details.title || 'Vídeo do YouTube';
    job.author = (details.author && details.author.name) || '';
    job.duration = Number(details.lengthSeconds) || 0;
    job.views = details.viewCount || '';
    job.published = details.publishDate || '';

    const format = pickFormat(info);
    job.total = Number(format.contentLength) || 0;

    const stream = ytdl.downloadFromInfo(info, {
      format,
      highWaterMark: 4 * 1024 * 1024,
    });
    job.cancelFn = () => {
      job.canceled = true;
      try {
        stream.destroy(new Error('canceled'));
      } catch {
        /* stream já destruída */
      }
    };

    stream.on('progress', (_, done, total) => {
      job.received = done;
      if (total) job.total = total;
      if (job.total > 0) job.progress = Math.min(100, (done / job.total) * 100);
    });

    const out = fs.createWriteStream(filePath);
    await pipeline(stream, out);

    if (job.canceled) throw new Error('Download cancelado pelo usuário');

    const stat = await fsp.stat(filePath);
    if (!stat.size) throw new Error('O arquivo baixado ficou vazio');

    await library.saveMeta({
      fileId: job.fileId,
      videoId: job.videoId,
      title: job.title,
      author: job.author,
      duration: job.duration,
      views: job.views,
      published: job.published,
      sizeBytes: stat.size,
      downloadedAt: new Date().toISOString(),
      quality: format.height ? `${format.height}p` : 'auto',
      container: format.container || 'mp4',
    });

    job.status = 'done';
    job.progress = 100;
  } catch (err) {
    job.error = job.canceled ? 'Download cancelado' : err.message || 'Erro no download';
    job.status = job.canceled ? 'canceled' : 'error';
    await fsp.unlink(filePath).catch(() => {}); // remove arquivo parcial
  } finally {
    job.finishedAt = Date.now();
    job.cancelFn = null;
  }
}

function getJob(jobId) {
  const job = jobs.get(jobId);
  return job ? publicJob(job) : null;
}

function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (job && job.status === 'downloading' && job.cancelFn) {
    job.cancelFn();
    return true;
  }
  return false;
}

module.exports = { createDownloadJob, getJob, cancelJob };
