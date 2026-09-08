const youtube = require('../services/youtube');
const downloader = require('../services/downloader');
const { formatDuration, formatBytes } = require('../utils/format');

// Smoke test dos serviços (não precisa de token do Telegram):
//   node src/tests/index.js [termo de busca]
async function main() {
  const query = process.argv[2] || 'lofi hip hop';

  console.log(`🔎 Buscando "${query}" no YouTube...`);
  const videos = await youtube.searchVideos(query);
  if (!videos.length) throw new Error('Nenhum vídeo encontrado na busca.');

  console.log(`\n📋 ${videos.length} vídeo(s) encontrado(s). Primeiros 5:`);
  videos.slice(0, 5).forEach((v, i) => {
    console.log(`  ${i + 1}. ${v.title}`);
    console.log(`     👤 ${v.author} | ⏱ ${formatDuration(v.seconds)} | 👁 ${v.views} | 🆔 ${v.videoId}`);
  });

  const first = videos[0];
  console.log(`\n📄 Obtendo informações/formatos de: ${first.title}`);
  const info = await downloader.getVideoInfo(first.videoId);

  const audio = downloader.pickAudio(info);
  const video = downloader.pickVideo(info);

  console.log(
    `  🎵 áudio: ${
      audio
        ? `${audio.format.container} @ ${audio.format.audioBitrate || '?'}kbps ~${formatBytes(audio.size)}`
        : 'indisponível'
    }`
  );
  console.log(
    `  🎬 vídeo: ${
      video
        ? `${video.format.container} ${video.format.qualityLabel || ''} ~${formatBytes(video.size)}`
        : 'indisponível'
    }`
  );

  console.log('\n✅ Teste concluído com sucesso!');
}

main().catch((err) => {
  console.error('❌ Falha no teste:', err.message);
  process.exit(1);
});


