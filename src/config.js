require('dotenv').config();

const path = require('path');

const config = {
  // Token do bot (aceita BOT_TOKEN ou o antigo bot_id no .env)
  botToken: process.env.BOT_TOKEN || process.env.bot_id || '',

  search: {
    resultsPerPage: 6, // vídeos enviados por página de resultados
  },

  // Bots do Telegram só conseguem ENVIAR arquivos de até 50 MB (multipart)
  telegram: {
    maxUploadMB: 49, // margem de segurança abaixo dos 50 MB
  },

  // Pasta temporária para downloads antes do envio
  tmpDir: path.join(__dirname, '..', 'tmp'),
};

module.exports = config;
