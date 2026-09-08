/** Formata segundos como m:ss ou h:mm:ss */
function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** Formata contagem de visualizações em pt-BR (ex.: 1,2 mi) */
function formatViews(views) {
  const n = Number(views) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace('.', ',')} bi`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace('.', ',')} mi`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace('.', ',')} mil`;
  return n.toLocaleString('pt-BR');
}

/** Formata bytes em KB/MB/GB legíveis */
function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${b} B`;
}

/** Corta o texto com reticências, sem estourar limites do Telegram */
function truncate(text, max = 60) {
  const t = String(text || '').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Escapa caracteres especiais para parse_mode HTML */
function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Remove caracteres inválidos para nomes de arquivo (Windows/Telegram) */
function sanitizeFilename(name) {
  const clean = String(name || 'arquivo')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return clean || 'arquivo';
}

module.exports = { formatDuration, formatViews, formatBytes, truncate, escapeHtml, sanitizeFilename };
