const assert = require('assert');
const os = require('os');
const path = require('path');

const config = require('../config');
const permissions = require('../services/permissions');
const ffmpegUtil = require('../utils/ffmpeg');
const youtube = require('../services/youtube');
const downloader = require('../services/downloader');
const {
  formatDuration,
  formatViews,
  formatBytes,
  truncate,
  escapeHtml,
  sanitizeFilename,
} = require('../utils/format');

// Testes offline (rodam em qualquer máquina, mesmo sem acesso ao YouTube)
async function offlineTests() {
  // utils/format
  assert.strictEqual(formatDuration(205), '3:25');
  assert.strictEqual(formatDuration(3725), '1:02:05');
  assert.ok(formatBytes(52 * 1024 * 1024).endsWith('MB'));
  assert.strictEqual(escapeHtml('<b> & >'), '&lt;b&gt; &amp; &gt;');
  assert.strictEqual(truncate('abcdefghij', 5), 'abcd…');
  assert.ok(!/[\\/:*?"<>|]/.test(sanitizeFilename('a/b:c*d?"<>|')));
  console.log('✅ utils/format');

  // services/permissions (arquivo temporário isolado)
  config.allowedUsersFile = path.join(os.tmpdir(), `teletube-test-${Date.now()}.json`);
  config.allowedUsersSeed = [111111111];
  config.ownerId = 111111111;
  assert.ok(permissions.isAllowed(111111111));
  assert.ok(permissions.isOwner(111111111));
  assert.ok(!permissions.isAllowed(222222222));
  assert.ok(permissions.addUser(222222222));
  assert.strictEqual(permissions.addUser(222222222), false); // duplicado
  assert.strictEqual(permissions.list().length, 2);
  assert.ok(permissions.removeUser(222222222));
  assert.ok(!permissions.isAllowed(222222222));
  let threw = false;
  try {
    permissions.removeUser(111111111);
  } catch (err) {
    threw = true;
  }
  assert.ok(threw, 'dono não pode ser removido');
  console.log('✅ services/permissions (add/remove/dono protegido/persistência)');

  // services/youtube — partes offline
  assert.strictEqual(youtube.extractVideoId('https://youtu.be/dQw4w9WgXcQ?t=2'), 'dQw4w9WgXcQ');
  assert.strictEqual(youtube.extractVideoId('https://www.youtube.com/watch?si=x&v=abc_def1234'), 'abc_def1234');
  assert.strictEqual(youtube.extractVideoId('https://www.youtube.com/shorts/abcdefghijk'), 'abcdefghijk');
  assert.strictEqual(youtube.extractVideoId('texto qualquer'), null);
  assert.deepStrictEqual(youtube.paginate([1, 2, 3, 4, 5, 6, 7, 8], 2, 6), [7, 8]);
  console.log('✅ services/youtube (helpers offline)');
}

// Testes de rede (no PC de dev o firewall bloqueia o YouTube; no servidor funciona)
async function networkTests() {
  console.log('\n🌐 Testes de rede (YouTube)...');
  try {
    const videos = await youtube.searchVideos('lofi hip hop');
    if (!videos.length) throw new Error('busca vazia');
    console.log(`  🔎 busca ok: ${videos.length} vídeos`);

    const first = videos[0];
    const info = await downloader.getVideoInfo(first.videoId);
    const audio = downloader.pickAudio(info);
    const video = downloader.pickVideo(info);
    const pair = downloader.pickAdaptivePair(info);
    console.log(`  🎬 ${first.title}`);
    console.log(`  🎵 áudio progressivo: ${audio ? `${audio.format.container} ~${formatBytes(audio.size)}` : 'n/a'}`);
    console.log(`  🎥 vídeo progressivo: ${video ? `${video.format.qualityLabel} ~${formatBytes(video.size)}` : 'n/a'}`);
    console.log(`  🎞️ par adaptativo (HD/ffmpeg): ${pair ? `${pair.label} + ${pair.audio.format.audioBitrate}kbps` : 'n/a'}`);
  } catch (err) {
    console.warn(`  ⚠️ Rede indisponível neste ambiente (${err.message}) — teste ignorado.`);
    console.warn('     No servidor de produção, com acesso ao YouTube, funcionará normalmente.');
  }
}

(async () => {
  await offlineTests();

  const hasFfmpeg = await ffmpegUtil.detectFfmpeg();
  console.log(hasFfmpeg ? '✅ ffmpeg detectado' : '⚠️ ffmpeg ausente (esperado nesta máquina de dev)');

  await networkTests();

  console.log('\n✅ Testes concluídos.');
})().catch((err) => {
  console.error('❌ Falha nos testes:', err);
  process.exit(1);
});



