const { createBot } = require('./src/bot');
const config = require('./src/config');

if (!config.botToken) {
  console.error('❌ Token do bot não configurado!');
  console.error('   Crie um bot com o @BotFather no Telegram e coloque o token no arquivo .env:');
  console.error('   BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11');
  process.exit(1);
}

const bot = createBot(config.botToken);

console.log('🚀 teleTube está rodando! Pressione Ctrl+C para parar.');

function shutdown(signal) {
  console.log(`\n${signal} recebido. Encerrando...`);
  bot.stopPolling().then(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

