# 📺 teleTube

Site para **buscar, baixar e assistir** a vídeos do YouTube sem sair da aplicação — o navegador **nunca** conversa com o YouTube: todas as requisições (busca, thumbnails e download do vídeo) são feitas pelo servidor Node.js.

## Como funciona

- **Busca** → o servidor consulta a página de resultados do YouTube, extrai os dados dos vídeos (`ytInitialData`) e devolve JSON pronto para a UI (título, canal, views, data, duração e thumbnail).
- **Thumbnails** → baixadas pelo servidor e servidas em proxy (`/api/thumb/:videoId`), com cache em disco (`.cache/thumbs`).
- **Download** → ao clicar em um vídeo, o servidor baixa o vídeo com `youtube-dl-exec` (wrapper do [yt-dlp](https://github.com/yt-dlp/yt-dlp)) em MP4 H.264/AAC até 720p e grava em `./downloads`, com metadados em JSON ao lado. Se o **ffmpeg** estiver disponível, vídeo e áudio são baixados em streams separados (melhor qualidade) e mesclados em MP4; sem ffmpeg, cai para um formato progressivo (vídeo+áudio no mesmo arquivo).
- **Assistir** → o arquivo é servido com suporte a `Range` (`/media/:fileId.mp4`), permitindo seek no player.
- **Biblioteca** → aba com todos os vídeos baixados (tamanho, data, qualidade), com excluir (confirmação em 2 cliques) e assistir.

## Rodando

```bash
npm install
npm start
```

Abra **http://localhost:3000**.

Opções: `PORT=3001 npm start` para trocar a porta, `npm run dev` para auto-reload.

Requisitos: Node.js ≥ 18 e Python 3 (o binário `yt-dlp` baixado no `npm install` é um zipapp Python). Opcionalmente, instale o **ffmpeg** para baixar até 720p (vídeo e áudio separados mesclados em MP4) — sem ele, usa-se um formato progressivo de menor qualidade.

## Estrutura

```
server.js            → servidor Express + rotas da API
lib/youtube.js       → busca no YouTube + fetch de thumbnails (lado servidor)
lib/downloader.js    → jobs de download com progresso/cancelamento
lib/library.js       → biblioteca local (downloads/*.mp4 + *.json)
public/              → front-end (HTML/CSS/JS puro, sem frameworks)
downloads/           → vídeos baixados (criada automaticamente)
.cache/thumbs/       → cache de thumbnails
```

## API

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/search?q=...` | Busca vídeos |
| GET | `/api/thumb/:videoId` | Thumbnail em proxy (com cache) |
| POST | `/api/downloads` `{videoId}` | Inicia o download (job) |
| GET | `/api/jobs/:id` | Progresso do job |
| POST | `/api/jobs/:id/cancel` | Cancela o download |
| GET | `/api/library` | Lista os baixados |
| DELETE | `/api/library/:fileId` | Exclui um vídeo |
| GET | `/media/:fileId.mp4` | Stream do vídeo (Range habilitado) |

## Observações

- A busca extrai dados da página pública de resultados do YouTube; mudanças de layout no YouTube podem exigir ajuste no parser (`lib/youtube.js`).
- O yt-dlp atualiza-se constantemente para acompanhar o YouTube — se os downloads voltarem a falhar, rode `npm install youtube-dl-exec@latest` (ou `npx youtube-dl-exec update`) para renovar o binário.
- Baixar vídeos do YouTube pode violar os Termos de Serviço — use por sua conta e risco, preferencialmente com conteúdo próprio/licenciado.
