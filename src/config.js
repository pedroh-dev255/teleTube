require('dotenv').config();

const path = require('path');

/** Converte "123, 456;789" em [123, 456, 789] */
function parseIdList(raw) {
  return String(raw || '')
    .split(/[\s,;]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

const config = {
  // Token do bot (aceita BOT_TOKEN ou o antigo bot_id no .env)
  botToken: process.env.BOT_TOKEN || process.env.bot_id || '',

  // Servidor local da Bot API (opcional). Ex.: http://localhost:8081
  // Quando definido, o limite de envio sobe de 50 MB para ~2 GB.
  telegramApiUrl: process.env.TELEGRAM_API_URL || '',

  // IDs do Telegram com permissão. O PRIMEIRO da lista é o dono/administrador.
  allowedUsersSeed: parseIdList(process.env.ALLOWED_USERS),
  allowedUsersFile: path.join(__dirname, '..', 'data', 'allowed-users.json'),

  ffmpeg: {
    // Caminho do executável no servidor (FFMPEG_PATH=ffmpeg se estiver no PATH)
    binPath: process.env.FFMPEG_PATH || 'ffmpeg',
  },

  download: {
    // Limite de segurança para o tamanho do download adaptativo (HD)
    maxVideoMB: Number(process.env.MAX_DOWNLOAD_MB) || 2048,
  },

  search: {
    resultsPerPage: 6, // vídeos enviados por página de resultados
  },

  telegram: {
    // API oficial: bots enviam até 50 MB. Com servidor local da Bot API: ~2 GB.
    maxUploadMB: process.env.TELEGRAM_API_URL ? 1900 : 49,
    // Tamanho alvo de cada parte quando um arquivo grande precisa ser dividido
    splitTargetMB: 45,
  },

  // Pasta temporária para downloads antes do envio
  tmpDir: path.join(__dirname, '..', 'tmp'),
};

// Primeiro ID semeado = dono (não pode ser removido via /deluser)
config.ownerId = config.allowedUsersSeed[0] || null;

module.exports = config;
