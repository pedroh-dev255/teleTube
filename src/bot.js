const TelegramBot = require('node-telegram-bot-api');

const config = require('./config');
const youtube = require('./services/youtube');
const downloader = require('./services/downloader');
const {
  formatDuration,
  formatViews,
  formatBytes,
  truncate,
  escapeHtml,
} = require('./utils/format');

const RESULTS_PER_PAGE = config.search.resultsPerPage;

const HELP_TEXT = [
  '🎵 <b>teleTube</b> — pesquise e baixe vídeos do YouTube direto no Telegram!',
  '',
  '<b>Como usar:</b>',
  '1️⃣ Envie qualquer texto (ex.: <i>lofi hip hop</i>) para pesquisar no YouTube;',
  '2️⃣ Cada resultado aparece com a thumbnail e botões de 🎵 áudio e 🎬 vídeo;',
  '3️⃣ Toque em um botão e aguarde — o arquivo chega aqui no chat.',
  '',
  '<b>Comandos:</b>',
  '/search &lt;termo&gt; — pesquisar no YouTube',
  '/help — mostrar esta mensagem',
  '',
  '💡 Você também pode colar o <b>link</b> de um vídeo para baixá-lo direto.',
  `⚠️ Limite de <b>${config.telegram.maxUploadMB} MB</b> por arquivo (limitação da API do Telegram para bots).`,
].join('\n');

function createBot(token) {
  const bot = new TelegramBot(token, { polling: true });

  // Última busca por chat (usada na paginação "Mais resultados")
  const chatState = new Map();
  // Downloads em andamento: `${chatId}:${tipo}:${videoId}`
  const activeDownloads = new Set();

  bot.on('polling_error', (err) => console.error('[polling_error]', err.message));

  // ---------- Comandos ----------
  bot.onText(/^\/(start|help)/, (msg) => {
    bot.sendMessage(msg.chat.id, HELP_TEXT, { parse_mode: 'HTML' }).catch(() => {});
  });

  bot.onText(/^\/search(?:@\w+)?\s+(.+)/i, (msg, match) => {
    doSearch(msg.chat.id, match[1].trim(), 1).catch(() => {});
  });

  bot.onText(/^\/search$/i, (msg) => {
    bot
      .sendMessage(msg.chat.id, 'Use: <code>/search termo da busca</code>', { parse_mode: 'HTML' })
      .catch(() => {});
  });

  // Qualquer outro texto = link direto do YouTube ou pesquisa livre
  bot.on('text', (msg) => {
    const text = (msg.text || '').trim();
    if (!text || text.startsWith('/')) return;

    const videoId = youtube.extractVideoId(text);
    if (videoId) {
      handleDirectUrl(msg.chat.id, videoId).catch(() => {});
      return;
    }
    doSearch(msg.chat.id, text, 1).catch(() => {});
  });

  // ---------- Callbacks (botões inline) ----------
  bot.on('callback_query', (query) => {
    const data = query.data || '';
    const chatId = query.message && query.message.chat.id;
    if (!chatId) return bot.answerCallbackQuery(query.id).catch(() => {});

    const pageMatch = /^p:(\d+)$/.exec(data);
    const dlMatch = /^(a|v):([\w-]{11})$/.exec(data);

    if (pageMatch) {
      bot.answerCallbackQuery(query.id).catch(() => {});
      const state = chatState.get(chatId);
      if (!state) return bot.sendMessage(chatId, 'Envie um termo de busca primeiro! 🙂');
      return doSearch(chatId, state.query, Number(pageMatch[1]));
    }

    if (dlMatch) {
      bot.answerCallbackQuery(query.id).catch(() => {});
      const type = dlMatch[1] === 'a' ? 'audio' : 'video';
      return handleDownload(chatId, type, dlMatch[2]);
    }

    return bot.answerCallbackQuery(query.id).catch(() => {});
  });

  // ---------- Funções internas ----------
  /** Pesquisa e envia os resultados como fotos (thumbnails) com botões */
  async function doSearch(chatId, query, page) {
    const statusMsg = await bot.sendMessage(
      chatId,
      `🔎 Pesquisando “${truncate(query, 50)}” no YouTube...`
    );

    try {
      const videos = await youtube.searchVideos(query);

      if (!videos.length) {
        return safeEdit(
          chatId,
          statusMsg.message_id,
          `🤷 Nenhum vídeo encontrado para “${escapeHtml(truncate(query, 50))}”.`
        );
      }

      const slice = youtube.paginate(videos, page, RESULTS_PER_PAGE);
      if (!slice.length) {
        return safeEdit(
          chatId,
          statusMsg.message_id,
          '📄 Sem mais resultados. Envie outro termo para pesquisar!'
        );
      }

      chatState.set(chatId, { query, page });

      for (const video of slice) {
        try {
          await sendVideoCard(chatId, video);
        } catch (err) {
          // Thumbnail pode falhar se o Telegram não conseguir baixá-la; envia como texto
          console.error('[card]', err.message);
          await bot
            .sendMessage(chatId, cardCaption(video), {
              parse_mode: 'HTML',
              reply_markup: videoKeyboard(video),
            })
            .catch(() => {});
        }
      }

      const hasNext = page * RESULTS_PER_PAGE < videos.length;
      return safeEdit(
        chatId,
        statusMsg.message_id,
        `✅ <b>${slice.length}</b> resultado(s) para “${escapeHtml(truncate(query, 50))}”` +
          (hasNext ? ' — toque em “Mais resultados” para ver mais.' : ''),
        {
          reply_markup: {
            inline_keyboard: hasNext
              ? [[{ text: '➡️ Mais resultados', callback_data: `p:${page + 1}` }]]
              : [],
          },
        }
      );
    } catch (err) {
      console.error('[search]', err);
      return safeEdit(chatId, statusMsg.message_id, `⚠️ Falha na pesquisa: ${escapeHtml(err.message)}`);
    }
  }

  function cardCaption(video) {
    return [
      `🎬 <b>${escapeHtml(truncate(video.title, 120))}</b>`,
      `👤 ${escapeHtml(truncate(video.author, 60))}`,
      `⏱ ${formatDuration(video.seconds)}  •  👁 ${formatViews(video.views)}`,
    ].join('\n');
  }

  function videoKeyboard(video) {
    return {
      inline_keyboard: [
        [
          { text: '🎵 Áudio', callback_data: `a:${video.videoId}` },
          { text: '🎬 Vídeo', callback_data: `v:${video.videoId}` },
        ],
        [{ text: '🔗 Abrir no YouTube', url: video.url }],
      ],
    };
  }

  /** Envia o vídeo como foto (thumbnail) + legenda + botões de download */
  function sendVideoCard(chatId, video) {
    return bot.sendPhoto(chatId, video.thumbnail, {
      caption: cardCaption(video),
      parse_mode: 'HTML',
      reply_markup: videoKeyboard(video),
    });
  }

  /** Link colado diretamente: mostra o vídeo com botões de download */
  async function handleDirectUrl(chatId, videoId) {
    try {
      const video = await youtube.getVideoById(videoId);
      await sendVideoCard(chatId, video);
    } catch (err) {
      console.error('[direct-url]', err);
      await bot
        .sendMessage(chatId, '⚠️ Não consegui obter os dados desse vídeo. Ele existe e está público?')
        .catch(() => {});
    }
  }

  /** Fluxo completo: busca informações, baixa com progresso e envia o arquivo */
  async function handleDownload(chatId, type, videoId) {
    const key = `${chatId}:${type}:${videoId}`;
    if (activeDownloads.has(key)) {
      return bot.sendMessage(chatId, '⏳ Esse download já está em andamento!');
    }
    activeDownloads.add(key);

    const statusMsg = await bot.sendMessage(chatId, '📄 Buscando informações do vídeo...');
    let mediaPath = null;
    let thumbPath = null;

    try {
      const info = await downloader.getVideoInfo(videoId);
      const details = info.videoDetails;
      const title = details.title || 'Vídeo do YouTube';
      const duration = Math.floor(Number(details.lengthSeconds) || 0);

      const choice = type === 'audio' ? downloader.pickAudio(info) : downloader.pickVideo(info);
      if (!choice) {
        return safeEdit(
          chatId,
          statusMsg.message_id,
          `⚠️ Nenhuma versão de ${type === 'audio' ? 'áudio' : 'vídeo'} deste vídeo cabe no limite de ` +
            `<b>${config.telegram.maxUploadMB} MB</b> da API do Telegram.`
        );
      }

      // Progresso com edição de mensagem limitada a 1 atualização a cada 3s
      let lastEdit = 0;
      const onProgress = (done, total) => {
        const now = Date.now();
        if (total && now - lastEdit > 3000) {
          lastEdit = now;
          const pct = Math.min(100, Math.floor((done / total) * 100));
          safeEdit(
            chatId,
            statusMsg.message_id,
            `⏬ Baixando <b>${escapeHtml(truncate(title, 60))}</b>... ${pct}% ` +
              `(${formatBytes(done)} de ${formatBytes(total)})`
          );
        }
      };

      await safeEdit(
        chatId,
        statusMsg.message_id,
        `⏬ Baixando <b>${escapeHtml(truncate(title, 60))}</b>...`
      );

      const { filePath, size } = await downloader.downloadMedia(info, choice, onProgress);
      mediaPath = filePath;

      if (size > downloader.MAX_UPLOAD_BYTES) {
        throw new Error(
          `arquivo de ${formatBytes(size)} excede o limite do Telegram (${config.telegram.maxUploadMB} MB)`
        );
      }

      await safeEdit(chatId, statusMsg.message_id, `📤 Enviando (${formatBytes(size)})...`);
      await bot.sendChatAction(chatId, type === 'audio' ? 'upload_voice' : 'upload_video');

      if (type === 'audio') {
        thumbPath = await downloader.downloadThumbnail(videoId);
        try {
          await bot.sendAudio(chatId, mediaPath, {
            title: truncate(title, 64),
            performer: truncate(details.author && details.author.name, 64),
            duration,
            ...(thumbPath ? { thumb: thumbPath } : {}),
          });
        } catch (err) {
          // Alguns servidores rejeitam o parâmetro thumb; tenta novamente sem ele
          console.error('[send-audio com thumb]', err.message);
          await bot.sendAudio(chatId, mediaPath, {
            title: truncate(title, 64),
            performer: truncate(details.author && details.author.name, 64),
            duration,
          });
        }
      } else {
        await bot.sendVideo(chatId, mediaPath, {
          caption: `🎬 ${truncate(title, 200)}`,
          supports_streaming: true,
        });
      }

      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    } catch (err) {
      console.error('[download]', err);
      await safeEdit(
        chatId,
        statusMsg.message_id,
        `⚠️ Não consegui concluir o download: ${escapeHtml(err.message || 'erro desconhecido')}`
      );
    } finally {
      activeDownloads.delete(key);
      downloader.deleteFile(mediaPath);
      downloader.deleteFile(thumbPath);
    }
  }

  /** editMessageText que nunca quebra o fluxo (erros são apenas logados) */
  async function safeEdit(chatId, messageId, text, extra = {}) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML',
        ...extra,
      });
    } catch (err) {
      // "message is not modified" e afins são inofensivos
      console.error('[safeEdit]', err.message);
    }
  }

  return bot;
}

module.exports = { createBot };


