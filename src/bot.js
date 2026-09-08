const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');

const config = require('./config');
const youtube = require('./services/youtube');
const downloader = require('./services/downloader');
const permissions = require('./services/permissions');
const {
  formatDuration,
  formatViews,
  formatBytes,
  truncate,
  escapeHtml,
} = require('./utils/format');

const RESULTS_PER_PAGE = config.search.resultsPerPage;

const sizeNote = config.telegramApiUrl
  ? `📡 Servidor local da Bot API ativo — arquivos de até ~${config.telegram.maxUploadMB} MB em parte única.`
  : `⚠️ Arquivos acima de <b>${config.telegram.maxUploadMB} MB</b> são divididos em partes. Abaixo de cada vídeo há um botão <b>🗑️ Excluir</b> para removê-lo depois.`;

const HELP_TEXT = [
  '🎵 <b>teleTube</b> — pesquise e baixe vídeos do YouTube direto no Telegram!',
  '',
  '<b>Como usar:</b>',
  '1️⃣ Envie qualquer texto (ex.: <i>lofi hip hop</i>) para pesquisar no YouTube;',
  '2️⃣ Cada resultado aparece com a thumbnail e botões de 🎵 áudio e 🎬 vídeo;',
  '3️⃣ Toque em um botão e aguarde — o arquivo chega aqui no chat.',
  '💡 Você também pode colar o <b>link</b> de um vídeo para baixá-lo direto.',
  '',
  '<b>Comandos:</b>',
  '/search &lt;termo&gt; — pesquisar no YouTube',
  '/id — mostrar seu ID do Telegram',
  '/help — mostrar esta mensagem',
  '',
  '<b>Administração (somente o dono):</b>',
  '/adduser &lt;id&gt; — liberar acesso para um novo ID',
  '/deluser &lt;id&gt; — revogar acesso de um ID',
  '/users — listar IDs com permissão',
  '',
  sizeNote,
].join('\n');

function createBot(token, options = {}) {
  const ffmpegAvailable = options.ffmpegAvailable === true;
  const bot = new TelegramBot(token, {
    polling: true,
    ...(config.telegramApiUrl ? { baseApiUrl: config.telegramApiUrl } : {}),
  });

  // Última busca por chat (usada na paginação "Mais resultados")
  const chatState = new Map();
  // Downloads em andamento: `${chatId}:${tipo}:${videoId}`
  const activeDownloads = new Set();
  // Mensagens enviadas que podem ser excluídas pelo botão 🗑️
  const deleteRegistry = new Map(); // deleteId -> { chatId, messageIds: [] }
  // Anti-spam do aviso de "sem permissão" (1 aviso por minuto por usuário)
  const denialLog = new Map();

  bot.on('polling_error', (err) => console.error('[polling_error]', err.message));

  // ---------- Permissões ----------
  function denyAccess(chatId, from) {
    if (!from) return;
    const last = denialLog.get(from.id) || 0;
    if (Date.now() - last < 60000) return;
    denialLog.set(from.id, Date.now());
    bot
      .sendMessage(
        chatId,
        `⛔ Você não tem permissão para usar este bot.\n🆔 Seu ID: <code>${from.id}</code>\n` +
          `O dono pode liberar você com <code>/adduser ${from.id}</code>.`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
  }

  /** Envolve handlers exigindo permissão do remetente */
  function guard(handler) {
    return (msg, ...rest) => {
      if (!msg.from || !permissions.isAllowed(msg.from.id)) {
        return denyAccess(msg.chat.id, msg.from);
      }
      return handler(msg, ...rest);
    };
  }

  // ---------- Comandos ----------
  bot.onText(/^\/(start|help)(?:@[\w]+)?$/, guard((msg) => {
    bot.sendMessage(msg.chat.id, HELP_TEXT, { parse_mode: 'HTML' }).catch(() => {});
  }));

  bot.onText(/^\/search(?:@[\w]+)?\s+(.+)/i, guard((msg, match) => {
    doSearch(msg.chat.id, match[1].trim(), 1).catch(() => {});
  }));

  bot.onText(/^\/search$/i, guard((msg) => {
    bot
      .sendMessage(msg.chat.id, 'Use: <code>/search termo da busca</code>', { parse_mode: 'HTML' })
      .catch(() => {});
  }));

  // /id é aberto a qualquer pessoa (o dono precisa descobrir IDs para liberar)
  bot.onText(/^\/id(?:@[\w]+)?$/i, (msg) => {
    const from = msg.from || {};
    bot
      .sendMessage(
        msg.chat.id,
        `🆔 Seu ID: <code>${from.id}</code>${permissions.isAllowed(from.id) ? ' (autorizado ✅)' : ''}`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
  });

  bot.onText(/^\/adduser(?:@[\w]+)?\s+(\d{4,20})$/i, guard((msg, match) => {
    if (!permissions.isOwner(msg.from.id)) {
      return bot.sendMessage(msg.chat.id, '⛔ Apenas o dono do bot pode gerenciar permissões.');
    }
    try {
      const added = permissions.addUser(match[1]);
      bot
        .sendMessage(
          msg.chat.id,
          added
            ? `✅ Usuário <code>${match[1]}</code> agora tem permissão.`
            : `ℹ️ O usuário <code>${match[1]}</code> já tinha permissão.`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
    } catch (err) {
      bot.sendMessage(msg.chat.id, `⚠️ ${escapeHtml(err.message)}`).catch(() => {});
    }
  }));

  bot.onText(/^\/deluser(?:@[\w]+)?\s+(\d{4,20})$/i, guard((msg, match) => {
    if (!permissions.isOwner(msg.from.id)) {
      return bot.sendMessage(msg.chat.id, '⛔ Apenas o dono do bot pode gerenciar permissões.');
    }
    try {
      const removed = permissions.removeUser(match[1]);
      bot
        .sendMessage(
          msg.chat.id,
          removed
            ? `✅ Permissão do usuário <code>${match[1]}</code> revogada.`
            : `ℹ️ O usuário <code>${match[1]}</code> não estava na lista.`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
    } catch (err) {
      bot.sendMessage(msg.chat.id, `⚠️ ${escapeHtml(err.message)}`).catch(() => {});
    }
  }));

  bot.onText(/^\/users(?:@[\w]+)?$/i, guard((msg) => {
    if (!permissions.isOwner(msg.from.id)) {
      return bot.sendMessage(msg.chat.id, '⛔ Apenas o dono do bot pode ver a lista de permissões.');
    }
    const users = permissions.list();
    const lines = users.map(
      (id, i) => `${i + 1}. <code>${id}</code>${id === config.ownerId ? ' 👑 <i>(dono)</i>' : ''}`
    );
    bot
      .sendMessage(
        msg.chat.id,
        `👥 <b>${users.length}</b> usuário(s) autorizado(s):\n${lines.join('\n')}\n\n` +
          'Gerencie com <code>/adduser &lt;id&gt;</code> e <code>/deluser &lt;id&gt;</code>.',
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
  }));

  // Qualquer outro texto = link direto do YouTube ou pesquisa livre
  bot.on('text', guard((msg) => {
    const text = (msg.text || '').trim();
    if (!text || text.startsWith('/')) return;

    const videoId = youtube.extractVideoId(text);
    if (videoId) {
      handleDirectUrl(msg.chat.id, videoId).catch(() => {});
      return;
    }
    doSearch(msg.chat.id, text, 1).catch(() => {});
  }));

  // ---------- Callbacks (botões inline) ----------
  bot.on('callback_query', (query) => {
    if (!query.from || !permissions.isAllowed(query.from.id)) {
      return bot.answerCallbackQuery(query.id, { text: '⛔ Sem permissão.' }).catch(() => {});
    }
    const data = query.data || '';
    const chatId = query.message && query.message.chat.id;
    if (!chatId) return bot.answerCallbackQuery(query.id).catch(() => {});

    const pageMatch = /^p:(\d+)$/.exec(data);
    const dlMatch = /^(a|v):([\w-]{11})$/.exec(data);
    const delMatch = /^del:([a-f0-9]{8})$/.exec(data);

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

    if (delMatch) {
      return handleDeleteCallback(query, delMatch[1]);
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

  // ---------- Botão de exclusão dos vídeos enviados ----------

  function deleteKeyboard(deleteId) {
    return {
      inline_keyboard: [[{ text: '🗑️ Excluir', callback_data: `del:${deleteId}` }]],
    };
  }

  /** Registra um alvo de exclusão (as messageIds são adicionadas após cada envio) */
  function registerDeletionTarget(chatId) {
    const deleteId = crypto.randomBytes(4).toString('hex'); // 8 hex chars
    const entry = { chatId, messageIds: [] };
    deleteRegistry.set(deleteId, entry);
    // Mensagens não podem ser excluídas após 48h; esquece antes disso
    const timer = setTimeout(() => deleteRegistry.delete(deleteId), 24 * 60 * 60 * 1000);
    if (timer.unref) timer.unref();
    return { deleteId, entry };
  }

  async function handleDeleteCallback(query, deleteId) {
    const entry = deleteRegistry.get(deleteId);
    if (!entry) {
      return bot
        .answerCallbackQuery(query.id, {
          text: '⌛ Registro expirado: mensagens não podem mais ser excluídas (limite de 48h do Telegram).',
          show_alert: true,
        })
        .catch(() => {});
    }

    let removed = 0;
    for (const messageId of entry.messageIds) {
      try {
        await bot.deleteMessage(entry.chatId, messageId);
        removed += 1;
      } catch (err) {
        console.error('[delete-message]', err.message);
      }
    }
    deleteRegistry.delete(deleteId);

    return bot
      .answerCallbackQuery(query.id, {
        text: removed
          ? `🗑️ ${removed} mensagem(ns) excluída(s).`
          : '⚠️ Não foi possível excluir (limite de 48h pode ter passado).',
      })
      .catch(() => {});
  }

  /** Fluxo completo: busca informações, baixa (mescla/divide) e envia o arquivo */
  async function handleDownload(chatId, type, videoId) {
    const key = `${chatId}:${type}:${videoId}`;
    if (activeDownloads.has(key)) {
      return bot.sendMessage(chatId, '⏳ Esse download já está em andamento!');
    }
    activeDownloads.add(key);

    const statusMsg = await bot.sendMessage(chatId, '📄 Buscando informações do vídeo...');
    const cleanupPaths = [];

    // Status com estágio atual + progresso (edição limitada a 1 a cada 3s)
    let lastEdit = 0;
    let stageText = '';
    const onStage = (text) => {
      stageText = text;
      safeEdit(chatId, statusMsg.message_id, text);
    };
    const onProgress = (pct) => {
      const now = Date.now();
      if (stageText && now - lastEdit > 3000) {
        lastEdit = now;
        safeEdit(chatId, statusMsg.message_id, `${stageText} ${Math.min(99, Math.floor(pct))}%`);
      }
    };

    try {
      const info = await downloader.getVideoInfo(videoId);
      const details = info.videoDetails;
      const title = details.title || 'Vídeo do YouTube';
      const duration = Math.floor(Number(details.lengthSeconds) || 0);
      const maxBytes = downloader.MAX_UPLOAD_BYTES;
      const splitTargetBytes = config.telegram.splitTargetMB * 1024 * 1024;

      let prepared;
      if (type === 'audio') {
        prepared = await downloader.prepareAudio(info, { maxBytes });
        if (!prepared) {
          return safeEdit(
            chatId,
            statusMsg.message_id,
            `⚠️ Nenhuma faixa de áudio deste vídeo cabe no limite de <b>${config.telegram.maxUploadMB} MB</b>.`
          );
        }
      } else {
        prepared = await downloader.prepareVideo(
          info,
          { maxBytes, splitTargetBytes, ffmpegAvailable },
          { onStage, onProgress }
        );
        if (!prepared) {
          return safeEdit(
            chatId,
            statusMsg.message_id,
            `⚠️ Nenhuma versão de vídeo deste vídeo cabe no limite de <b>${config.telegram.maxUploadMB} MB</b>.`
          );
        }
      }
      cleanupPaths.push(...prepared.cleanup);

      const totalParts = prepared.files.length;
      const deletion = registerDeletionTarget(chatId);

      for (let i = 0; i < totalParts; i++) {
        const file = prepared.files[i];
        await bot.sendChatAction(chatId, type === 'audio' ? 'upload_voice' : 'upload_video');
        const partLabel = totalParts > 1 ? ` — Parte ${i + 1}/${totalParts}` : '';
        const qualityLabel = prepared.label ? ` (${prepared.label})` : '';

        if (type === 'audio') {
          await bot.sendAudio(chatId, file.path, {
            title: truncate(title, 64),
            performer: truncate(details.author && details.author.name, 64),
            duration,
          });
        } else {
          const sent = await bot.sendVideo(chatId, file.path, {
            caption: `🎬 ${truncate(title, 180)}${qualityLabel}${partLabel}`,
            supports_streaming: true,
            reply_markup: deleteKeyboard(deletion.deleteId),
          });
          deletion.entry.messageIds.push(sent.message_id);
        }
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
      cleanupPaths.forEach(downloader.deleteFile);
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



