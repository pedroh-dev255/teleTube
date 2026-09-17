'use strict';

/**
 * Motor de downloads: baixa o vídeo no servidor com youtube-dl-exec (yt-dlp)
 * e expõe "jobs" com progresso consultável pela UI.
 *
 * Por que yt-dlp? O @distube/ytdl-core foi arquivado (ago/2025) e quebrou com
 * as mudanças do player do YouTube ("Failed to find any playable formats").
 * O yt-dlp é mantido ativamente e resolve decipher/n-transform por conta própria.
 */

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const ytdlp = require('youtube-dl-exec');
const library = require('./library');

const jobs = new Map();
const JOB_TTL_MS = 10 * 60 * 1000; // jobs finalizados ficam em memória por 10 min

/* Prefixo das linhas de progresso emitidas via --progress-template.
   Formato: TELEPROG|<arquivo>|<bytes recebidos>|<total>|<total estimado> */
const PROGRESS_PREFIX = 'TELEPROG';

/**
 * ffmpeg é opcional: presente, permite baixar vídeo e áudio separados (melhor
 * qualidade, ex. 720p) e mesclar em MP4; ausente, cai para um formato
 * progressivo (vídeo+áudio no mesmo arquivo). O resultado é checado uma única
 * vez por processo — instalar ffmpeg depois exige reiniciar o servidor.
 */
let hasFfmpegCache = null;
function hasFfmpeg() {
  if (hasFfmpegCache !== null) return Promise.resolve(hasFfmpegCache);
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    proc.on('error', () => {
      hasFfmpegCache = false;
      resolve(false);
    });
    proc.on('exit', (code) => {
      hasFfmpegCache = code === 0;
      resolve(hasFfmpegCache);
    });
  });
}

/** Seletor de formato: H.264/AAC até 720p (máxima compatibilidade com o player). */
async function downloadFlags(fileId) {
  const ffmpeg = await hasFfmpeg();
  const format = ffmpeg
    ? // vídeo mp4/h264 + áudio m4a, depois progressivos mp4, depois o melhor restante
      'bv*[ext=mp4][vcodec^=avc1][height<=720]+ba[ext=m4a]' +
      '/b[ext=mp4][vcodec^=avc1][acodec^=mp4a][height<=720]' +
      '/bv*[height<=720]+ba/b[height<=720]' +
      '/wv*+ba/w'
    : // sem ffmpeg: apenas formatos progressivos (vídeo+áudio no mesmo arquivo)
      'b[ext=mp4][vcodec^=avc1][acodec^=mp4a][height<=720]/b[ext=mp4][height<=720]/b';

  const flags = {
    output: path.join(library.DOWNLOADS_DIR, `${fileId}.%(ext)s`),
    format,
    noPlaylist: true,
    noWarnings: true,
    newline: true,
    progressTemplate: `download:${PROGRESS_PREFIX}|%(progress.filename)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s`,
  };
  if (ffmpeg) flags.mergeOutputFormat = 'mp4';
  return flags;
}

function isoDate(yyyymmdd) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(yyyymmdd || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

/** Soma o progresso de todos os arquivos em trânsito (vídeo e áudio baixam em paralelo). */
function applyProgress(line, tracker, job) {
  const [, filename, downloaded, total, estimate] = line.split('|');
  if (!filename) return;
  const entry = tracker.get(filename) || { done: 0, total: 0 };
  const done = Number(downloaded);
  if (Number.isFinite(done)) entry.done = done;
  const totalNum = Number(total);
  const estNum = Number(estimate);
  const totalValue =
    Number.isFinite(totalNum) && totalNum > 0
      ? totalNum
      : Number.isFinite(estNum) && estNum > 0
        ? estNum
        : 0;
  if (totalValue > 0) entry.total = totalValue;
  tracker.set(filename, entry);

  let received = 0;
  let sum = 0;
  for (const t of tracker.values()) {
    received += t.done;
    sum += t.total;
  }
  job.received = received;
  if (sum > 0) {
    job.total = sum;
    job.progress = Math.min(100, (received / sum) * 100);
  }
}

/** Extrai a qualidade (ex. "720p") a partir dos format_ids baixados + info JSON. */
function qualityOf(info, formatIds) {
  const heights = String(formatIds || '')
    .split('+')
    .map((id) => (info.formats || []).find((f) => String(f.format_id) === id))
    .map((f) => f && f.height)
    .filter(Boolean);
  return heights.length ? `${Math.max(...heights)}p` : 'auto';
}

/** Torna erros do yt-dlp legíveis para o usuário final. */
function friendlyError(err) {
  const text = [err.stderr, err.stdout, err.message].filter(Boolean).join('\n');
  const m = /ERROR:\s*([^\n]+)/.exec(text);
  if (!m) return err.message || 'Erro no download';
  return m[1]
    .replace(/\[youtube\]\s*[\w-]+:\s*/, '')
    .replace(/\[download\]\s*/, '')
    .trim();
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

/** Localiza o arquivo final do download (<fileId>.mp4 ou renomeia o container gerado). */
async function findDownloadedFile(fileId) {
  const finalPath = library.videoPath(fileId);
  try {
    await fsp.access(finalPath);
    return finalPath;
  } catch {
    /* procura alternativa (ex.: outro container quando não há ffmpeg) */
  }
  const entries = await fsp.readdir(library.DOWNLOADS_DIR).catch(() => []);
  const alt = entries.find(
    (name) => name.startsWith(`${fileId}.`) && !name.endsWith('.part')
  );
  if (!alt) return null;
  if (alt !== path.basename(finalPath)) {
    await fsp.rename(path.join(library.DOWNLOADS_DIR, alt), finalPath);
  }
  return finalPath;
}

/** Remove qualquer resto de download parcial (<fileId>.part, streams temporários etc.). */
async function cleanupPartial(fileId) {
  const entries = await fsp.readdir(library.DOWNLOADS_DIR).catch(() => []);
  await Promise.all(
    entries
      .filter((name) => name.startsWith(`${fileId}.`))
      .map((name) =>
        fsp.unlink(path.join(library.DOWNLOADS_DIR, name)).catch(() => {})
      )
  );
}

async function runJob(job) {
  try {
    const flags = await downloadFlags(job.fileId);
    const url = `https://www.youtube.com/watch?v=${job.videoId}`;

    // 1) metadados — também valida o vídeo antes de iniciar a transferência
    const info = await ytdlp(url, {
      dumpSingleJson: true,
      noPlaylist: true,
      noWarnings: true,
    });
    if (info.is_live) throw new Error('Transmissões ao vivo não são suportadas');

    job.title = info.title || 'Vídeo do YouTube';
    job.author = info.channel || info.uploader || '';
    job.duration = Number(info.duration) || 0;
    job.views = Number(info.view_count) || 0;
    job.published = isoDate(info.upload_date);

    // 2) download com progresso por bytes (vídeo e áudio somados)
    const tracker = new Map();
    let formatIds = '';
    const proc = ytdlp.exec(url, flags, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n|\r/)) {
        if (line.startsWith(`${PROGRESS_PREFIX}|`)) {
          applyProgress(line, tracker, job);
          continue;
        }
        const m = /Downloading \d+ format\(s\): ([0-9+]+)/.exec(line);
        if (m) formatIds = m[1];
      }
    });

    job.cancelFn = () => {
      job.canceled = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        /* processo já encerrado */
      }
    };

    await proc; // rejeita em erro ou cancelamento
    if (job.canceled) throw new Error('Download cancelado pelo usuário');

    // 3) valida o resultado e grava os metadados
    const finalPath = await findDownloadedFile(job.fileId);
    if (!finalPath) throw new Error('O arquivo baixado não foi encontrado');

    const stat = await fsp.stat(finalPath);
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
      quality: qualityOf(info, formatIds),
      container: 'mp4',
    });

    job.status = 'done';
    job.progress = 100;
  } catch (err) {
    job.error = job.canceled
      ? 'Download cancelado'
      : friendlyError(err) || 'Erro no download';
    job.status = job.canceled ? 'canceled' : 'error';
    await cleanupPartial(job.fileId); // remove arquivo parcial
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
