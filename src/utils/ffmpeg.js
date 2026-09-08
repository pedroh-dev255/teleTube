const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');

// undefined = ainda não verificado; true/false = resultado em cache
let cachedAvailable;

/** Verifica se o ffmpeg está disponível no sistema (com cache) */
function detectFfmpeg(force = false) {
  if (cachedAvailable !== undefined && !force) return Promise.resolve(cachedAvailable);
  return new Promise((resolve) => {
    execFile(
      config.ffmpeg.binPath,
      ['-version'],
      { timeout: 10000, windowsHide: true },
      (err) => {
        cachedAvailable = !err;
        resolve(cachedAvailable);
      }
    );
  });
}

/** true apenas se detectFfmpeg() já rodou e encontrou o ffmpeg */
function isFfmpegAvailable() {
  return cachedAvailable === true;
}

/** Duração em segundos (parse do stderr do ffmpeg; o comando sai com erro esperado) */
function getDurationSeconds(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      config.ffmpeg.binPath,
      ['-hide_banner', '-i', filePath],
      { timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = String(stderr || stdout || '');
        const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(output);
        if (!match) {
          return reject(new Error('Não foi possível obter a duração da mídia via ffmpeg.'));
        }
        const [, h, m, s] = match;
        resolve(Number(h) * 3600 + Number(m) * 60 + Number(s));
      }
    );
  });
}

/**
 * Mescla vídeo + áudio com stream copy (rápido, sem recodificar) em um MP4
 * otimizado para streaming no Telegram (-movflags +faststart).
 */
function mergeAv(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-nostats',
      '-loglevel', 'error',
      '-i', videoPath,
      '-i', audioPath,
      '-c', 'copy',
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-movflags', '+faststart',
      outputPath,
    ];
    execFile(
      config.ffmpeg.binPath,
      args,
      { timeout: 30 * 60 * 1000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`Falha ao mesclar vídeo e áudio: ${String(stderr || err.message).trim()}`));
        }
        resolve(outputPath);
      }
    );
  });
}

/**
 * Divide um arquivo em partes de ~targetBytes usando stream copy
 * (cortes em keyframes). Retorna a lista ordenada de arquivos gerados.
 */
async function splitFile(filePath, targetBytes) {
  const duration = await getDurationSeconds(filePath);
  const size = fs.statSync(filePath).size;
  const parts = Math.max(1, Math.ceil(size / targetBytes));
  const segmentTime = Math.max(5, Math.floor(duration / parts));

  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const pattern = path.join(dir, `${base}.part%03d.mp4`);

  await new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-nostats',
      '-loglevel', 'error',
      '-i', filePath,
      '-c', 'copy',
      '-map', '0',
      '-f', 'segment',
      '-segment_time', String(segmentTime),
      '-reset_timestamps', '1',
      pattern,
    ];
    execFile(
      config.ffmpeg.binPath,
      args,
      { timeout: 30 * 60 * 1000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`Falha ao dividir o vídeo: ${String(stderr || err.message).trim()}`));
        }
        resolve();
      }
    );
  });

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${base}.part`) && f.endsWith('.mp4'))
    .sort()
    .map((f) => path.join(dir, f));

  if (!files.length) throw new Error('O ffmpeg não gerou nenhuma parte ao dividir o vídeo.');
  return files;
}

module.exports = { detectFfmpeg, isFfmpegAvailable, getDurationSeconds, mergeAv, splitFile };
