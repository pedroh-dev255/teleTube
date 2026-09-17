'use strict';

/**
 * teleTube — servidor
 * Todas as requisições ao YouTube partem daqui; o navegador só fala com este servidor.
 */

const path = require('path');
const fsp = require('fs/promises');
const express = require('express');

const { searchVideos, fetchThumbnail } = require('./lib/youtube');
const { createDownloadJob, getJob, cancelJob } = require('./lib/downloader');
const library = require('./lib/library');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- busca ---------------- */

app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'Informe um termo para buscar' });
  try {
    const results = await searchVideos(query);
    res.json({ query, results });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Falha na busca' });
  }
});

/* --------- thumbnails em proxy --------- */

app.get('/api/thumb/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!library.isValidVideoId(videoId)) return res.status(400).end();
  try {
    const cached = library.thumbCachePath(videoId);
    try {
      await fsp.access(cached);
      // dotfiles: 'allow' — o cache fica em .cache/, que o send bloqueia por padrão;
      // com callback, erros não vazam para o finalhandler (sem stack no terminal)
      return res.sendFile(
        cached,
        { dotfiles: 'allow' },
        (err) => {
          if (err && !res.headersSent) res.status(err.statusCode || 500).end();
        }
      );
    } catch {
      /* sem cache — busca no YouTube */
    }
    const buffer = await fetchThumbnail(videoId);
    fsp.writeFile(cached, buffer).catch(() => {});
    res.type('image/jpeg').send(buffer);
  } catch {
    res.status(404).end();
  }
});

/* ------------- downloads --------------- */

app.post('/api/downloads', async (req, res) => {
  const videoId = (req.body && req.body.videoId) || '';
  try {
    const job = await createDownloadJob(videoId);
    res.json(job);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Não foi possível iniciar o download' });
  }
});

app.get('/api/jobs/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Tarefa não encontrada' });
  res.json(job);
});

app.post('/api/jobs/:jobId/cancel', (req, res) => {
  res.json({ canceled: cancelJob(req.params.jobId) });
});

/* ------------- biblioteca -------------- */

app.get('/api/library', async (req, res) => {
  res.json({ items: await library.list() });
});

app.get('/api/library/:fileId', async (req, res) => {
  const meta = await library.readMeta(req.params.fileId);
  if (!meta) return res.status(404).json({ error: 'Vídeo não encontrado' });
  res.json(meta);
});

app.delete('/api/library/:fileId', async (req, res) => {
  const ok = await library.remove(req.params.fileId);
  if (!ok) return res.status(404).json({ error: 'Vídeo não encontrado' });
  res.json({ ok: true });
});

/* --------- streaming do vídeo --------- */

app.get('/media/:fileId', (req, res) => {
  // o player pede /media/<fileId>.mp4 — aceitamos com ou sem a extensão
  const fileId = path.basename(req.params.fileId, path.extname(req.params.fileId));
  if (!library.isValidFileId(fileId)) return res.status(400).end();
  // sendFile (send) suporta Range — permite seek no player
  res.sendFile(library.videoPath(fileId), (err) => {
    if (err && !res.headersSent) res.status(err.statusCode || 500).end();
  });
});

/* ---------------- start ---------------- */

library
  .ensureDirs()
  .catch(() => {})
  .finally(() => {
    app.listen(PORT, () => {
      console.log('');
      console.log('  📺 teleTube no ar → http://localhost:%s', PORT);
      console.log('     Pasta de downloads: %s', library.DOWNLOADS_DIR);
      console.log('');
    });
  });
