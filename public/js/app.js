'use strict';

/* ============================================================
   teleTube — front-end
   Toda comunicação acontece apenas com o nosso servidor.
   ============================================================ */

const $ = (s) => document.querySelector(s);

const els = {
  searchForm: $('#searchForm'),
  searchInput: $('#searchInput'),
  searchBtn: $('#searchBtn'),
  hero: $('#hero'),
  chips: $('#chips'),
  results: $('#results'),
  resultsEmpty: $('#resultsEmpty'),
  tabs: $('#tabs'),
  tabIndicator: $('#tabIndicator'),
  libraryList: $('#libraryList'),
  libraryEmpty: $('#libraryEmpty'),
  libCount: $('#libCount'),
  libMeta: $('#libMeta'),
  brandHome: $('#brandHome'),
  backFromWatch: $('#backFromWatch'),
  player: $('#player'),
  watchTitle: $('#watchTitle'),
  watchAuthor: $('#watchAuthor'),
  watchStats: $('#watchStats'),
  watchQuality: $('#watchQuality'),
  watchDelete: $('#watchDelete'),
  dlOverlay: $('#dlOverlay'),
  dlThumb: $('#dlThumb'),
  dlTitle: $('#dlTitle'),
  dlSub: $('#dlSub'),
  dlBar: $('#dlBar'),
  dlPercent: $('#dlPercent'),
  dlBytes: $('#dlBytes'),
  dlSpeed: $('#dlSpeed'),
  dlCancel: $('#dlCancel'),
  toasts: $('#toasts'),
};

const state = {
  tab: 'search',
  returnTab: 'search',
  results: [],
  library: [],
  watchFile: null,
  currentJob: null,
  pollTimer: null,
};

/* ------------------- utilidades ------------------- */

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

function fmtBytes(n) {
  const num = Number(n);
  if (!num && num !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = num;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDuration(sec) {
  const s = Math.floor(Number(sec) || 0);
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return (
    d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }) +
    ' às ' +
    d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  );
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  els.toasts.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, 4200);
}

/* ------------------- abas / navegação ------------------- */

function moveIndicator() {
  const active = els.tabs.querySelector('.tab.active');
  if (!active) return;
  els.tabIndicator.style.left = `${active.offsetLeft}px`;
  els.tabIndicator.style.width = `${active.offsetWidth}px`;
}

function switchTab(tab, { force = false } = {}) {
  if (!force && state.tab === tab) return;
  const leavingWatch = state.tab === 'watch' && tab !== 'watch';
  if (tab === 'watch') state.returnTab = state.tab;
  state.tab = tab;

  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('active', v.id === `view-${tab}`);
  });
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  moveIndicator();

  if (leavingWatch) els.player.pause();
  if (tab === 'library') refreshLibrary();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ------------------- busca ------------------- */

function setSearching(on) {
  els.searchBtn.disabled = on;
  els.searchBtn.textContent = on ? 'Buscando…' : 'Buscar';
}

function buildSkeletons(n) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const row = document.createElement('div');
    row.className = 'row skeleton';
    row.style.animationDelay = `${i * 40}ms`;
    row.innerHTML = `
      <div class="skel-box skel"></div>
      <div class="skel-col">
        <div class="skel w80"></div>
        <div class="skel w50"></div>
        <div class="skel w35"></div>
      </div>`;
    frag.appendChild(row);
  }
  return frag;
}

function thumbPlaceholder(row) {
  const img = row.querySelector('.thumb img');
  if (!img) return;
  img.addEventListener('error', () => {
    const thumb = img.closest('.thumb');
    img.remove();
    if (thumb) thumb.classList.add('no-img');
  });
}

function resultRow(v, { delay = 0 } = {}) {
  const row = document.createElement('article');
  row.className = 'row';
  row.style.animationDelay = `${delay}ms`;
  row.dataset.videoId = v.videoId;

  const known = state.library.some((m) => m.videoId === v.videoId);
  const metaParts = [v.views, v.published].filter(Boolean).map(escapeHtml).join(' • ');

  row.innerHTML = `
    <div class="thumb">
      <img loading="lazy" src="/api/thumb/${v.videoId}" alt="">
      ${v.duration ? `<span class="duration">${escapeHtml(v.duration)}</span>` : ''}
    </div>
    <div class="row-info">
      <h3 class="row-title">${escapeHtml(v.title)}</h3>
      <div class="row-channel">
        <span class="avatar">${escapeHtml((v.author || '?').trim().charAt(0).toUpperCase())}</span>
        <span>${escapeHtml(v.author)}</span>
        ${known ? '<span class="badge ok">Na biblioteca</span>' : ''}
      </div>
      ${metaParts ? `<div class="row-meta">${metaParts}</div>` : ''}
      ${v.snippet ? `<p class="row-snippet">${escapeHtml(v.snippet)}</p>` : ''}
    </div>
    <div class="row-cta" title="Baixar e assistir">
      <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M12 3v10.59L7.71 9.29 6.3 10.71 12 16.41l5.7-5.7-1.41-1.42L12 13.59V3z"/><path d="M5 19h14v2H5z"/></svg>
      <span>Baixar</span>
    </div>`;

  thumbPlaceholder(row);
  row.addEventListener('click', () => startDownload(v));
  return row;
}

function renderResults(results) {
  els.results.innerHTML = '';
  const has = results.length > 0;
  els.resultsEmpty.classList.toggle('hidden', has);
  results.forEach((v, i) => els.results.appendChild(resultRow(v, { delay: i * 35 })));
}

async function onSearch(e) {
  e.preventDefault();
  const q = els.searchInput.value.trim();
  if (!q) return;

  els.hero.classList.add('hidden');
  els.results.innerHTML = '';
  els.resultsEmpty.classList.add('hidden');
  els.results.appendChild(buildSkeletons(8));
  setSearching(true);
  window.scrollTo({ top: 0, behavior: 'smooth' });

  try {
    const res = await fetch('/api/search?q=' + encodeURIComponent(q));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha na busca');
    state.results = data.results;
    renderResults(data.results);
    if (!data.results.length) {
      els.results.innerHTML = '';
      els.resultsEmpty.classList.remove('hidden');
    }
  } catch (err) {
    els.results.innerHTML = '';
    els.resultsEmpty.classList.remove('hidden');
    toast(err.message, 'error');
  } finally {
    setSearching(false);
  }
}

/* ------------------- download ------------------- */

function openModal(video) {
  els.dlThumb.src = `/api/thumb/${video.videoId}`;
  els.dlThumb.addEventListener('error', () => { els.dlThumb.style.opacity = '0'; }, { once: true });
  els.dlTitle.textContent = video.title;
  els.dlSub.textContent = video.author || '';
  els.dlBar.style.width = '0%';
  els.dlPercent.textContent = '0%';
  els.dlBytes.textContent = '';
  els.dlSpeed.textContent = '';
  els.dlOverlay.classList.remove('hidden');
  requestAnimationFrame(() => els.dlOverlay.classList.add('show'));
}

function closeModal() {
  els.dlOverlay.classList.remove('show');
  setTimeout(() => els.dlOverlay.classList.add('hidden'), 300);
}

function updateModal(job) {
  const p = job.progress || 0;
  els.dlBar.style.width = `${p}%`;
  els.dlPercent.textContent = `${Math.floor(p)}%`;
  els.dlBytes.textContent = job.total
    ? `${fmtBytes(job.received)} de ${fmtBytes(job.total)}`
    : fmtBytes(job.received);
  if (job.title) els.dlTitle.textContent = job.title;
  if (job.author) els.dlSub.textContent = job.author;
}

async function startDownload(video) {
  if (state.currentJob) {
    toast('Aguarde: já existe um download em andamento', 'warn');
    return;
  }

  const known = state.library.find((m) => m.videoId === video.videoId);
  if (known) {
    toast('Este vídeo já está na biblioteca', 'info');
    return openWatch(known.fileId);
  }

  openModal(video);
  try {
    const res = await fetch('/api/downloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: video.videoId }),
    });
    const job = await res.json();
    if (!res.ok) throw new Error(job.error || 'Falha ao iniciar o download');

    if (job.status === 'done' && job.alreadyDownloaded) {
      closeModal();
      toast('Este vídeo já estava baixado', 'info');
      refreshLibrary();
      return openWatch(job.fileId);
    }

    state.currentJob = job;
    pollJob(job.id);
  } catch (err) {
    closeModal();
    toast(err.message, 'error');
  }
}

function pollJob(jobId) {
  let last = { t: Date.now(), received: 0 };

  state.pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      if (res.status === 404) throw new Error('A tarefa de download foi perdida');
      const job = await res.json();
      updateModal(job);

      const now = Date.now();
      const dt = (now - last.t) / 1000;
      if (dt >= 1 && job.status === 'downloading') {
        const speed = (job.received - last.received) / dt;
        els.dlSpeed.textContent = speed > 0 ? `${fmtBytes(speed)}/s` : '';
        last = { t: now, received: job.received };
      }

      if (job.status === 'done') {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        state.currentJob = null;
        closeModal();
        toast('Download concluído! Abrindo o vídeo…', 'ok');
        refreshLibrary();
        if (state.tab === 'search') renderResults(state.results);
        openWatch(job.fileId);
      } else if (job.status === 'error') {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        state.currentJob = null;
        closeModal();
        toast(`Erro no download: ${job.error}`, 'error');
      } else if (job.status === 'canceled') {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        state.currentJob = null;
        closeModal();
        toast('Download cancelado', 'warn');
      }
    } catch (err) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      state.currentJob = null;
      closeModal();
      toast(err.message, 'error');
    }
  }, 500);
}

async function onCancelDownload() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  if (state.currentJob && state.currentJob.id) {
    try { await fetch(`/api/jobs/${state.currentJob.id}/cancel`, { method: 'POST' }); } catch { /* segue */ }
    state.currentJob = null;
  }
  closeModal();
  toast('Download cancelado', 'warn');
}

/* ------------------- assistir ------------------- */

async function openWatch(fileId) {
  try {
    let meta = state.library.find((m) => m.fileId === fileId);
    if (!meta) {
      const res = await fetch(`/api/library/${fileId}`);
      if (!res.ok) throw new Error('Vídeo não encontrado na biblioteca');
      meta = await res.json();
      state.library.unshift(meta);
      updateLibBadge();
    }

    state.watchFile = meta;
    els.player.src = `/media/${meta.fileId}.mp4`;
    els.watchTitle.textContent = meta.title;
    els.watchAuthor.textContent = meta.author || '—';
    els.watchStats.textContent = [
      fmtDuration(meta.duration),
      fmtBytes(meta.sizeBytes),
      `baixado em ${fmtDate(meta.downloadedAt)}`,
    ].filter(Boolean).join(' • ');
    els.watchQuality.textContent = (meta.quality || 'auto').toUpperCase();

    switchTab('watch', { force: true });
    els.player.play().catch(() => {});
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ------------------- biblioteca ------------------- */

async function refreshLibrary() {
  try {
    const res = await fetch('/api/library');
    if (!res.ok) throw new Error('Falha ao carregar a biblioteca');
    const data = await res.json();
    state.library = data.items || [];
    updateLibBadge();
    if (state.tab === 'library') renderLibrary();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function updateLibBadge() {
  const n = state.library.length;
  els.libCount.textContent = String(n);
  els.libCount.classList.toggle('hidden', n === 0);
  const total = state.library.reduce((a, m) => a + (Number(m.sizeBytes) || 0), 0);
  els.libMeta.textContent = n ? `${n} vídeo${n > 1 ? 's' : ''} • ${fmtBytes(total)} em disco` : '';
}

function libraryRow(meta, { delay = 0 } = {}) {
  const row = document.createElement('article');
  row.className = 'row lib';
  row.style.animationDelay = `${delay}ms`;
  row.dataset.fileId = meta.fileId;

  row.innerHTML = `
    <div class="thumb">
      <img loading="lazy" src="/api/thumb/${meta.videoId}" alt="">
      ${meta.duration ? `<span class="duration">${fmtDuration(meta.duration)}</span>` : ''}
    </div>
    <div class="row-info">
      <h3 class="row-title">${escapeHtml(meta.title)}</h3>
      <div class="row-channel">
        <span class="avatar">${escapeHtml((meta.author || '?').charAt(0).toUpperCase())}</span>
        <span>${escapeHtml(meta.author || '—')}</span>
      </div>
      <div class="row-meta">
        ${[fmtBytes(meta.sizeBytes), fmtDate(meta.downloadedAt), (meta.quality || 'auto').toUpperCase()]
          .filter(Boolean).map(escapeHtml).join(' • ')}
      </div>
    </div>
    <div class="row-actions">
      <button class="btn primary small act-play">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        Assistir
      </button>
      <button class="btn danger ghost small act-del">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        <span>Excluir</span>
      </button>
    </div>`;

  thumbPlaceholder(row);
  row.querySelector('.act-play').addEventListener('click', () => openWatch(meta.fileId));

  const del = row.querySelector('.act-del');
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    if (del.dataset.armed) {
      deleteFile(meta.fileId, { rowEl: row });
      return;
    }
    del.dataset.armed = '1';
    del.classList.add('armed');
    del.querySelector('span').textContent = 'Confirmar?';
    setTimeout(() => {
      if (!del.isConnected) return;
      delete del.dataset.armed;
      del.classList.remove('armed');
      del.querySelector('span').textContent = 'Excluir';
    }, 2600);
  });

  row.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    openWatch(meta.fileId);
  });
  return row;
}

function renderLibrary() {
  els.libraryList.innerHTML = '';
  const has = state.library.length > 0;
  els.libraryEmpty.classList.toggle('hidden', has);
  state.library.forEach((m, i) => els.libraryList.appendChild(libraryRow(m, { delay: i * 30 })));
}

async function deleteFile(fileId, { fromWatch = false, rowEl = null } = {}) {
  try {
    const res = await fetch(`/api/library/${fileId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Não foi possível excluir o vídeo');

    state.library = state.library.filter((m) => m.fileId !== fileId);
    updateLibBadge();
    toast('Vídeo excluído da biblioteca', 'ok');

    if (rowEl) {
      rowEl.classList.add('removing');
      setTimeout(renderLibrary, 320);
    } else {
      renderLibrary();
    }

    if (fromWatch) {
      els.player.pause();
      els.player.removeAttribute('src');
      els.player.load();
      state.watchFile = null;
      switchTab('library', { force: true });
    }

    if (state.tab === 'search') renderResults(state.results);
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ------------------- init ------------------- */

function init() {
  els.searchForm.addEventListener('submit', onSearch);

  els.tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn) switchTab(btn.dataset.tab);
  });

  els.brandHome.addEventListener('click', () => {
    switchTab('search', { force: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  els.chips.addEventListener('click', (e) => {
    const chip = e.target.closest('button[data-q]');
    if (!chip) return;
    els.searchInput.value = chip.dataset.q;
    els.searchForm.requestSubmit();
  });

  els.backFromWatch.addEventListener('click', () => {
    switchTab(state.returnTab || 'search', { force: true });
  });

  els.dlCancel.addEventListener('click', onCancelDownload);

  els.watchDelete.addEventListener('click', () => {
    if (state.watchFile) deleteFile(state.watchFile.fileId, { fromWatch: true });
  });

  window.addEventListener('resize', moveIndicator);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(moveIndicator);
  }

  refreshLibrary();
  requestAnimationFrame(moveIndicator);
}

init();
