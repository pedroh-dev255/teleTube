const fs = require("fs");
const path = require("path");
const config = require("../config");
const ffmpegUtil = require("../utils/ffmpeg");
const youtubeQuiet = require("../utils/youtube-quiet");
const { createYtFetch } = require("../utils/yt-fetch");
const { sanitizeFilename, formatBytes } = require("../utils/format");

const MAX_UPLOAD_BYTES = config.telegram.maxUploadMB * 1024 * 1024;
const MB = 1024 * 1024;

// -----------------------------------------------------------------------------
// YouTube.js / Innertube
// -----------------------------------------------------------------------------

let youtubeInstancePromise = null;

/**

* Cria uma única instância do YouTube.js e reutiliza durante a execução.
* Isso evita abrir uma nova sessão HTTP para cada download.
  */
async function getYouTube() {
  if (!youtubeInstancePromise) {
    youtubeInstancePromise = (async () => {
      // Silencia os avisos do parser ANTES do primeiro uso do YouTube.js
      await youtubeQuiet.configure();

      const { Innertube } = await import("youtubei.js");

      // Fetch customizado: User-Agent por cliente + retry com a família de IP
      // correta quando o googlevideo responde 403 (IP/UA não correspondem).
      const ytFetch = createYtFetch();

      return Innertube.create({ fetch: ytFetch });
    })();
  }

  return youtubeInstancePromise;
}

/**

* Converte o formato do youtubei.js para um formato compatível
* com o restante deste downloader.
  */
function normalizeFormat(format) {
  if (!format) return null;

  const mimeType = format.mime_type || format.mimeType || "";
  const codecs = format.codecs || "";

  const container = mimeType.includes("mp4")
    ? "mp4"
    : mimeType.includes("webm")
      ? "webm"
      : mimeType.includes("m4a")
        ? "m4a"
        : mimeType.includes("mp4a")
          ? "m4a"
          : "";

  const hasVideo =
    format.has_video !== undefined
      ? Boolean(format.has_video)
      : format.hasVideo !== undefined
        ? Boolean(format.hasVideo)
        : Boolean(format.height || format.width);

  const hasAudio =
    format.has_audio !== undefined
      ? Boolean(format.has_audio)
      : format.hasAudio !== undefined
        ? Boolean(format.hasAudio)
        : Boolean(
            format.audio_quality ||
            format.audioQuality ||
            format.audio_sample_rate ||
            format.audioSampleRate,
          );

  let audioCodec = null;

  if (codecs) {
    const codecString = String(codecs);

    if (codecString.includes("mp4a")) {
      audioCodec = "mp4a.40.2";
    } else if (codecString.includes("opus")) {
      audioCodec = "opus";
    }
  }

  return {
    ...format,

    // Identificação
    itag: Number(format.itag),

    // Container / codecs
    container,
    codecs,
    audioCodec,

    // Vídeo
    width: Number(format.width) || null,
    height: Number(format.height) || null,
    qualityLabel:
      format.quality_label || format.qualityLabel || format.quality || null,

    // Áudio
    audioBitrate:
      Number(format.audio_bitrate) ||
      Number(format.audioBitrate) ||
      Number(format.average_bitrate) ||
      Number(format.averageBitrate) ||
      0,

    averageBitrate:
      Number(format.average_bitrate) || Number(format.averageBitrate) || 0,

    // Bitrate
    bitrate: Number(format.bitrate) || 0,

    // Tamanho
    contentLength:
      format.content_length !== undefined
        ? Number(format.content_length)
        : format.contentLength !== undefined
          ? Number(format.contentLength)
          : null,

    // Compatibilidade com o código antigo
    hasAudio,
    hasVideo,

    // Referência original
    _youtubeiFormat: format,
  };
}

/**

* Obtém todos os formatos do vídeo através do youtubei.js.
  */
function getAllFormats(info) {
  if (!info) return [];

  if (Array.isArray(info.formats)) {
    return info.formats;
  }

  return [];
}

/**

* Filtra formatos mantendo a mesma ideia do ytdl-core.
  */
function filterFormats(formats, type) {
  if (!Array.isArray(formats)) return [];

  switch (type) {
    case "audioonly":
      return formats.filter((f) => f.hasAudio && !f.hasVideo);

    case "videoonly":
      return formats.filter((f) => f.hasVideo && !f.hasAudio);

    case "audioandvideo":
      return formats.filter((f) => f.hasAudio && f.hasVideo);

    default:
      return formats;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Tamanho estimado do formato (contentLength ou bitrate x duração) */
function estimateFormatSize(format, durationSeconds) {
  if (format.contentLength) return Number(format.contentLength);

  const bitrate =
    Number(format.bitrate) ||
    Number(format.averageBitrate) ||
    Number(format.audioBitrate);

  if (bitrate && durationSeconds) {
    return Math.round((bitrate / 8) * durationSeconds);
  }

  return null;
}

/**

* Escolhe o melhor formato de áudio que caiba no limite.
* Preferência: m4a, maior bitrate possível.
* Retorna { format, size } ou null quando nem o menor cabe.
  */
function pickAudio(info, maxBytes = MAX_UPLOAD_BYTES) {
  const formats = filterFormats(getAllFormats(info), "audioonly");

  if (!formats.length) return null;

  const duration = Number(info.videoDetails.lengthSeconds) || 0;

  const m4a = formats.filter(
    (f) =>
      f.container === "m4a" ||
      f.audioCodec === "mp4a.40.2" ||
      String(f.codecs || "").includes("mp4a"),
  );

  const pool = (m4a.length ? m4a : formats)
    .map((f) => ({
      format: f,
      size: estimateFormatSize(f, duration),
    }))
    .sort(
      (a, b) =>
        (b.format.audioBitrate || b.format.bitrate || 0) -
        (a.format.audioBitrate || a.format.bitrate || 0),
    );

  const fits = pool.find((c) => c.size !== null && c.size <= maxBytes);

  if (fits) return fits;

  const smallest = pool[pool.length - 1];

  if (smallest.size !== null && smallest.size > maxBytes) {
    return null;
  }

  return smallest;
}

/**

* Escolhe o melhor formato progressivo
* (áudio + vídeo juntos, sem ffmpeg).
*
* Preferência: MP4, maior qualidade que caiba no limite.
  */
function pickVideo(info, maxBytes = MAX_UPLOAD_BYTES) {
  const combined = filterFormats(getAllFormats(info), "audioandvideo");

  if (!combined.length) return null;

  const duration = Number(info.videoDetails.lengthSeconds) || 0;

  const mp4 = combined.filter((f) => f.container === "mp4");

  const pool = (mp4.length ? mp4 : combined)
    .map((f) => ({
      format: f,
      size: estimateFormatSize(f, duration),
    }))
    .sort((a, b) => (b.format.bitrate || 0) - (a.format.bitrate || 0));

  const fits = pool.find((c) => c.size !== null && c.size <= maxBytes);

  if (fits) return fits;

  const smallest = [...pool].sort(
    (a, b) => (a.size ?? Infinity) - (b.size ?? Infinity),
  )[0];

  if (smallest.size !== null && smallest.size > maxBytes) {
    return null;
  }

  return smallest;
}

/**

* Melhor par adaptativo:
* vídeo H.264 + áudio M4A.
*
* Mantém a mesma estratégia anterior.
  */
function pickAdaptivePair(info) {
  const duration = Number(info.videoDetails.lengthSeconds) || 0;
  const capBytes = config.download.maxVideoMB * MB;

  const videoFormats = filterFormats(getAllFormats(info), "videoonly")
    .filter(
      (f) =>
        f.container === "mp4" &&
        String(f.codecs || "").includes("avc1") &&
        f.height,
    )
    .map((f) => ({
      format: f,
      size: estimateFormatSize(f, duration),
    }));

  if (!videoFormats.length) return null;

  const withinCap = videoFormats.filter(
    (c) => c.size === null || c.size <= capBytes,
  );

  const candidates = (withinCap.length ? withinCap : videoFormats).sort(
    (a, b) =>
      b.format.height - a.format.height ||
      (b.format.bitrate || 0) - (a.format.bitrate || 0),
  );

  const audioFormats = filterFormats(getAllFormats(info), "audioonly")
    .filter(
      (f) =>
        f.container === "m4a" ||
        f.audioCodec === "mp4a.40.2" ||
        String(f.codecs || "").includes("mp4a"),
    )
    .sort(
      (a, b) =>
        (b.format?.audioBitrate || b.audioBitrate || b.bitrate || 0) -
        (a.format?.audioBitrate || a.audioBitrate || a.bitrate || 0),
    );

  if (!audioFormats.length) return null;

  const best = candidates[0];

  return {
    video: best,

    audio: {
      format: audioFormats[0],
      size: estimateFormatSize(audioFormats[0], duration),
    },

    label: best.format.qualityLabel || `${best.format.height}p`,
  };
}

// -----------------------------------------------------------------------------
// Video information
// -----------------------------------------------------------------------------

/**

* Obtém os metadados/formatos do vídeo via youtubei.js.
*
* Mantém o mesmo retorno esperado pelo restante do downloader.
  */
/**
 * Clientes do InnerTube, em ordem de tentativa. Clientes "web" modernos
 * costumam responder sem URLs de streaming ("gated") quando a requisição
 * não apresenta um PO Token; ANDROID_VR / IOS / TV_EMBEDDED costumam
 * devolver URLs diretas.
 */
const CLIENT_CHAIN = ["ANDROID_VR", "IOS", "TV_EMBEDDED", "WEB"];

/** Um formato é utilizável se tem URL direta ou cifra para decifrar */
function hasUsableFormats(info) {
  const streaming = info && info.streaming_data;

  if (!streaming) return false;

  const all = [
    ...(streaming.formats || []),
    ...(streaming.adaptive_formats || []),
  ];

  return all.some(
    (f) => f && (f.url || f.signature_cipher || f.signatureCipher || f.cipher),
  );
}

async function getVideoInfo(videoId) {
  const youtube = await getYouTube();

  let chosen = null;
  let lastError = null;

  for (const client of CLIENT_CHAIN) {
    try {
      const info = await youtube.getInfo(videoId, { client });

      if (!hasUsableFormats(info)) {
        lastError = new Error(
          `Cliente ${client} respondeu sem URLs de streaming (gated).`,
        );

        console.warn(
          `[youtube] Cliente ${client}: sem URLs utilizáveis — tentando o próximo...`,
        );

        continue;
      }

      chosen = info;

      console.log(`[youtube] Formatos obtidos via cliente ${client}.`);

      break;
    } catch (err) {
      lastError = err;

      console.warn(
        `[youtube] Cliente ${client} falhou: ${err.message} — tentando o próximo...`,
      );
    }
  }

  if (!chosen) {
    throw new Error(
      `Nenhum cliente do YouTube devolveu URLs de streaming para este vídeo` +
        ` (último erro: ${lastError ? lastError.message : "desconhecido"}).`,
    );
  }

  const basic = chosen.basic_info || {};
  const streaming = chosen.streaming_data || {};

  const rawFormats = [
    ...(streaming.formats || []),
    ...(streaming.adaptive_formats || []),
  ];

  const formats = rawFormats.map(normalizeFormat).filter(Boolean);

  return {
    // Mantém estrutura parecida com ytdl-core
    videoDetails: {
      videoId: basic.id || basic.video_id || videoId,

      title: basic.title || "Vídeo sem título",

      lengthSeconds:
        Number(basic.duration) || Number(basic.duration_seconds) || 0,

      author: basic.author?.name || basic.author || "",

      channelId: basic.channel_id || basic.channel_id || null,
    },

    formats,

    // Mantém referência interna do youtubei.js
    _youtubei: {
      info: chosen,
      videoId,
    },
  };
}

// -----------------------------------------------------------------------------
// Download
// -----------------------------------------------------------------------------

/**

* Baixa a mídia escolhida para a pasta temporária.
*
* onProgress(downloadedBytes, totalBytes)
* é chamado durante o download.
*
* Um watchdog aborta se não houver progresso por 60s.
  */
async function downloadMedia(info, choice, onProgress = () => {}) {
  const details = info.videoDetails;

  const container = ["mp4", "m4a", "webm"].includes(choice.format.container)
    ? choice.format.container
    : "bin";

  const baseName = sanitizeFilename(details.title);

  fs.mkdirSync(config.tmpDir, {
    recursive: true,
  });

  const filePath = path.join(
    config.tmpDir,
    `${baseName} [${details.videoId}].${container}`,
  );

  const itag = Number(choice.format.itag);

  if (!itag) {
    throw new Error("Formato do YouTube sem itag válido.");
  }

  // Baixa usando a MESMA resposta obtida em getVideoInfo (mesmo cliente).
  // Chamar youtube.download() re-faria o getInfo com o cliente padrão,
  // que pode estar "gated" (sem URLs de streaming).
  const ytInfo = info._youtubei && info._youtubei.info;

  if (!ytInfo || typeof ytInfo.download !== "function") {
    throw new Error("Referência do youtubei.js indisponível para download.");
  }

  await new Promise(async (resolve, reject) => {
    let stream = null;
    let file = null;
    let settled = false;
    let watchdog = null;
    let downloadedBytes = 0;

    const armWatchdog = () => {
      clearTimeout(watchdog);

      watchdog = setTimeout(() => {
        fail(
          new Error("Download interrompido: sem progresso por 60 segundos."),
        );
      }, 60000);
    };

    const fail = (err) => {
      if (settled) return;

      settled = true;

      clearTimeout(watchdog);

      try {
        if (stream && typeof stream.destroy === "function") {
          stream.destroy();
        }
      } catch (_) {}

      try {
        if (file && !file.destroyed) {
          file.destroy();
        }
      } catch (_) {}

      fs.unlink(filePath, () => {});

      reject(err);
    };

    const done = () => {
      if (settled) return;

      settled = true;

      clearTimeout(watchdog);

      resolve();
    };

    try {
      armWatchdog();

      /**
       * O youtubei.js retorna Web ReadableStream.
       *
       * Node moderno suporta Readable.fromWeb().
       */
      const webStream = await ytInfo.download({
        itag,
      });

      if (!webStream) {
        throw new Error("youtubei.js não retornou um stream de download.");
      }

      if (typeof webStream.getReader !== "function") {
        throw new Error("Stream retornado pelo youtubei.js é inválido.");
      }

      const { Readable } = require("stream");

      stream = Readable.fromWeb(webStream);

      file = fs.createWriteStream(filePath);

      stream.on("data", (chunk) => {
        downloadedBytes += chunk.length;

        armWatchdog();

        const total = choice.size || choice.format.contentLength || 0;

        onProgress(downloadedBytes, Number(total) || 0);
      });

      stream.on("error", fail);

      file.on("error", fail);

      file.on("finish", done);

      stream.pipe(file);
    } catch (err) {
      fail(err);
    }
  });

  return {
    filePath,
    size: fs.statSync(filePath).size,
  };
}

/**

* Prepara o áudio (m4a) respeitando o limite.
*
* Retorna:
* { files, cleanup, label }
*
* ou null.
  */
async function prepareAudio(info, opts = {}) {
  const maxBytes = opts.maxBytes || MAX_UPLOAD_BYTES;

  const choice = pickAudio(info, maxBytes);

  if (!choice) return null;

  const { filePath, size } = await downloadMedia(info, choice, () => {});

  return {
    files: [
      {
        path: filePath,
        size,
      },
    ],

    cleanup: [filePath],

    label: `${choice.format.audioBitrate || "?"}kbps`,
  };
}

/**

* Baixa vídeo-only + áudio e mescla com ffmpeg
* (stream copy, sem recodificar).
  */
async function tryAdaptiveMerge(info, { onStage, onProgress }) {
  const pair = pickAdaptivePair(info);

  if (!pair) return null;

  const details = info.videoDetails;

  onStage(`⏬ Baixando vídeo (${pair.label})...`);

  const video = await downloadMedia(
    info,
    pair.video,
    (d, t) => t && onProgress((d / t) * 85),
  );

  onStage("⏬ Baixando áudio...");

  const audio = await downloadMedia(
    info,
    pair.audio,
    (d, t) => t && onProgress(85 + (d / t) * 10),
  );

  onStage(`⚙️ Mesclando vídeo + áudio (${pair.label}) com ffmpeg...`);

  onProgress(96);

  fs.mkdirSync(config.tmpDir, {
    recursive: true,
  });

  const outPath = path.join(
    config.tmpDir,
    `${sanitizeFilename(details.title)} [${details.videoId}].mp4`,
  );

  try {
    await ffmpegUtil.mergeAv(video.filePath, audio.filePath, outPath);
  } catch (err) {
    deleteFile(outPath);
    throw err;
  } finally {
    deleteFile(video.filePath);
    deleteFile(audio.filePath);
  }

  onProgress(99);

  return {
    filePath: outPath,
    size: fs.statSync(outPath).size,
    label: pair.label,
  };
}

/**

* Prepara o vídeo para envio:
*
* 1. Com ffmpeg:
* melhor qualidade (H.264) mesclada.
*
* 2. Se ficar acima do limite:
* divide em partes.
*
* 3. Sem ffmpeg:
* formato progressivo compatível.
*
* Retorna:
* { files: [{path,size}], cleanup: [paths], label }
*
* ou null.
  */
async function prepareVideo(info, opts = {}, callbacks = {}) {
  const maxBytes = opts.maxBytes || MAX_UPLOAD_BYTES;

  const splitTargetBytes = opts.splitTargetBytes || Math.floor(maxBytes * 0.92);

  const onStage = callbacks.onStage || (() => {});

  const onProgress = callbacks.onProgress || (() => {});

  let merged = null;

  if (opts.ffmpegAvailable) {
    try {
      merged = await tryAdaptiveMerge(info, {
        onStage,
        onProgress,
      });
    } catch (err) {
      console.error("[adaptive-merge]", err.message);

      onStage("⚠️ Falha ao mesclar em HD; usando formato compatível...");
    }
  }

  if (merged) {
    if (merged.size <= maxBytes) {
      return {
        files: [
          {
            path: merged.filePath,
            size: merged.size,
          },
        ],

        cleanup: [merged.filePath],

        label: merged.label,
      };
    }

    onStage(
      `✂️ Vídeo com ${formatBytes(merged.size)} — dividindo em partes...`,
    );

    const parts = await ffmpegUtil.splitFile(merged.filePath, splitTargetBytes);

    const files = parts.map((p) => ({
      path: p,
      size: fs.statSync(p).size,
    }));

    return {
      files,

      cleanup: [merged.filePath, ...parts],

      label: merged.label,
    };
  }

  const choice = pickVideo(info, maxBytes);

  if (!choice) return null;

  const label = choice.format.qualityLabel || "qualidade padrão";

  onStage(`⏬ Baixando vídeo (${label})...`);

  const { filePath, size } = await downloadMedia(
    info,
    choice,
    (d, t) => t && onProgress((d / t) * 100),
  );

  return {
    files: [
      {
        path: filePath,
        size,
      },
    ],

    cleanup: [filePath],

    label,
  };
}

/** Remove arquivo temporário sem lançar erro */
function deleteFile(filePath) {
  if (filePath) {
    fs.unlink(filePath, () => {});
  }
}

module.exports = {
  MAX_UPLOAD_BYTES,

  getVideoInfo,

  pickAudio,

  pickVideo,

  pickAdaptivePair,

  downloadMedia,

  prepareAudio,

  prepareVideo,

  deleteFile,
};
