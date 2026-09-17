'use strict';

/**
 * Biblioteca local de vídeos baixados.
 * Cada vídeo gera dois arquivos em ./downloads:
 *   <fileId>.mp4  → o vídeo em si
 *   <fileId>.json → metadados (título, canal, tamanho, data, etc.)
 */

const fsp = require('fs/promises');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOWNLOADS_DIR = path.join(ROOT, 'downloads');
const THUMBS_DIR = path.join(ROOT, '.cache', 'thumbs');

const FILE_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

function isValidFileId(id) {
  return FILE_ID_PATTERN.test(id);
}

function isValidVideoId(id) {
  return VIDEO_ID_PATTERN.test(id);
}

async function ensureDirs() {
  await fsp.mkdir(DOWNLOADS_DIR, { recursive: true });
  await fsp.mkdir(THUMBS_DIR, { recursive: true });
}

const videoPath = (fileId) => path.join(DOWNLOADS_DIR, `${fileId}.mp4`);
const metaPath = (fileId) => path.join(DOWNLOADS_DIR, `${fileId}.json`);
const thumbCachePath = (videoId) => path.join(THUMBS_DIR, `${videoId}.jpg`);

async function saveMeta(meta) {
  await ensureDirs();
  await fsp.writeFile(metaPath(meta.fileId), JSON.stringify(meta, null, 2), 'utf8');
}

async function readMeta(fileId) {
  if (!isValidFileId(fileId)) return null;
  try {
    const raw = await fsp.readFile(metaPath(fileId), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Lista os vídeos presentes na biblioteca (apenas os que têm o .mp4 em disco). */
async function list() {
  await ensureDirs();
  const entries = await fsp.readdir(DOWNLOADS_DIR);
  const metas = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await fsp.readFile(path.join(DOWNLOADS_DIR, name), 'utf8');
      const meta = JSON.parse(raw);
      await fsp.access(videoPath(meta.fileId)); // descarta metadados órfãos
      metas.push(meta);
    } catch {
      // meta corrompida ou vídeo removido — ignora
    }
  }
  metas.sort((a, b) => Date.parse(b.downloadedAt) - Date.parse(a.downloadedAt));
  return metas;
}

async function findByVideoId(videoId) {
  const all = await list();
  return all.find((m) => m.videoId === videoId) || null;
}

async function remove(fileId) {
  const meta = await readMeta(fileId);
  if (!meta) return false;
  await Promise.all([
    fsp.unlink(videoPath(fileId)).catch(() => {}),
    fsp.unlink(metaPath(fileId)).catch(() => {}),
  ]);
  return true;
}

module.exports = {
  DOWNLOADS_DIR,
  THUMBS_DIR,
  ensureDirs,
  videoPath,
  metaPath,
  thumbCachePath,
  saveMeta,
  readMeta,
  list,
  findByVideoId,
  remove,
  isValidFileId,
  isValidVideoId,
};
