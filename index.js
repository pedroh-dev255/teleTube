const { createBot } = require('./src/bot');
const config = require('./src/config');
const permissions = require('./src/services/permissions');
const ffmpeg = require('./src/utils/ffmpeg');

// Silencia os avisos verbosos do parser do YouTube (nodes novos da UI não
// afetam os downloads). Precisa rodar antes do primeiro uso do youtubei.js.
require('./src/utils/youtube-quiet').configure().catch(() => {});

if (!config.botToken) {
  console.error('❌ Token do bot não configurado!');
  console.error('   Crie um bot com o @BotFather no Telegram e coloque o token no arquivo .env:');
  console.error('   BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11');
  process.exit(1);
}

if (!permissions.list().length) {
  console.error('❌ Nenhum usuário com permissão configurado! No .env defina:');
  console.error('   ALLOWED_USERS=658294274');
  process.exit(1);
}

(async () => {
  const hasFfmpeg = await ffmpeg.detectFfmpeg();

  console.log('──────────────────────────────────────────────────────');
  if (hasFfmpeg) {
    console.log(`✅ ffmpeg encontrado (${config.ffmpeg.binPath}):`);
    console.log('   • vídeos em HD (mesclagem de vídeo + áudio)');
    console.log(`   • arquivos maiores que ${config.telegram.maxUploadMB} MB são divididos em partes`);
  } else {
    console.log(`⚠️  ffmpeg NÃO encontrado: apenas formatos progressivos de até ${config.telegram.maxUploadMB} MB.`);
    console.log('   (No servidor de produção isso será resolvido automaticamente.)');
  }
  if (config.telegramApiUrl) {
    console.log(`📡 Servidor local da Bot API: ${config.telegramApiUrl} (até ~${config.telegram.maxUploadMB} MB por arquivo).`);
  }
  console.log(`👥 Usuários autorizados: ${permissions.list().length} (dono: ${config.ownerId})`);
  console.log('──────────────────────────────────────────────────────');

  const bot = createBot(config.botToken, { ffmpegAvailable: hasFfmpeg });
  console.log('🚀 teleTube está rodando! Pressione Ctrl+C para parar.');

  function shutdown(signal) {
    console.log(`\n${signal} recebido. Encerrando...`);
    bot.stopPolling().then(() => process.exit(0));
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
})();

