# 📺 teleTube

Bot do Telegram que **pesquisa vídeos no YouTube**, lista os resultados **com thumbnails** e **baixa o áudio ou o vídeo** direto para o chat.

## ✨ Funcionalidades

- 🔎 Pesquisa no YouTube **sem precisar de API key** (via `yt-search`)
- 🖼️ Resultados enviados como fotos (thumbnail) com título, canal, duração e views
- 🎵 Download de **áudio** (m4a, com thumbnail e duração no player do Telegram)
- 🎬 Download de **vídeo** (mp4 progressivo, com streaming no Telegram)
- 📊 Progresso do download em tempo real (`⏬ Baixando... 42%`)
- ➡️ Paginação com "Mais resultados"
- 🔗 Reconhece links do YouTube (`watch`, `youtu.be`, `shorts`, `embed`, `live`)
- 🧹 Limpeza automática dos arquivos temporários

## 🚀 Como usar

1. Crie um bot conversando com o [@BotFather](https://t.me/BotFather) no Telegram e copie o token.
2. Coloque o token no arquivo `.env`:
   ```
   BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
   ```
3. Instale as dependências e inicie:
   ```bash
   npm install
   npm start        # ou: npm run dev (com nodemon)
   ```
4. No Telegram, envie qualquer texto ao bot para pesquisar (ou `/search <termo>`), ou cole o link de um vídeo.

## 📁 Estrutura

```
index.js                  # Entrada: valida o token e inicia o bot
src/
  bot.js                  # Handlers do Telegram (comandos, busca, callbacks, download)
  config.js               # Configurações (.env, limites, pasta temporária)
  services/
    youtube.js            # Busca/pesquisa no YouTube (yt-search) e paginação
    downloader.js         # Download (ytdl-core), seleção de formato, progresso, limpeza
  utils/format.js         # Formatação de duração, views, bytes, HTML e filenames
  tests/index.js          # Smoke test dos serviços (npm test)
```

## ⚠️ Limitações

- **49 MB por arquivo**: a API do Telegram permite que bots enviem no máximo 50 MB — vídeos maiores são recusados (o bot escolhe a melhor qualidade que couber).
- **Sem ffmpeg**: o bot usa apenas formatos progressivos (áudio+vídeo juntos), então a resolução de vídeo costuma ficar limitada a 360p/720p. Com ffmpeg instalado seria possível mesclar 1080p+.
- Vídeos privados, com restrição de idade ou lives não podem ser baixados.
