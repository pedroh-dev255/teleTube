# 📺 teleTube

Site para **buscar, baixar e assistir** a vídeos do YouTube sem sair da aplicação — o navegador **nunca** conversa com o YouTube: todas as requisições (busca, thumbnails e download do vídeo) são feitas pelo servidor Node.js.

## Como funciona

- **Busca** → o servidor consulta a página de resultados do YouTube, extrai os dados dos vídeos (`ytInitialData`) e devolve JSON pronto para a UI (título, canal, views, data, duração, descrição e thumbnail).
- **Thumbnails** → baixadas pelo servidor e servidas em proxy (`/api/thumb/:videoId`), com cache em disco (`.cache/thumbs`).
- **Prévia** → clicar em um resultado **não** inicia o download: abre um modal com thumbnail, dados do vídeo, **descrição completa**, escolha entre **vídeo** ou **somente áudio (MP3)** e os chips de **resolução realmente disponíveis** (com tamanho estimado de cada uma).
- **Download** → o servidor baixa com `youtube-dl-exec` (wrapper do [yt-dlp](https://github.com/yt-dlp/yt-dlp)) na resolução escolhida (MP4 H.264/AAC) ou extrai o áudio para MP3, gravando em `./downloads` com metadados em JSON ao lado. Se o **ffmpeg** estiver disponível, vídeo e áudio são baixados em streams separados (melhor qualidade) e mesclados em MP4; sem ffmpeg, cai para um formato progressivo (vídeo+áudio no mesmo arquivo) e o áudio é entregue cru (m4a).
- **Assistir** → o arquivo é servido com suporte a `Range` (`/media/:fileId.<container>`), permitindo seek no player (vídeo no `<video>`, áudio no `<audio>`).
- **Biblioteca** → aba com todos os itens baixados (tamanho, data, qualidade, descrição e badge de áudio), com **assistir**, **baixar o arquivo do servidor para o dispositivo** (`Content-Disposition: attachment`, nome de arquivo amigável) e excluir (confirmação em 2 cliques). O mesmo vídeo pode existir como vídeo e como áudio (itens separados).

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
| GET | `/api/video/:videoId` | Detalhes completos (descrição + resoluções disponíveis) |
| POST | `/api/downloads` `{videoId, kind, quality}` | Inicia o download (job); `kind`: `video`\|`audio`, `quality`: altura máx. (ex. `720`) |
| GET | `/api/jobs/:id` | Progresso do job |
| POST | `/api/jobs/:id/cancel` | Cancela o download |
| GET | `/api/library` | Lista os baixados |
| GET | `/api/library/:fileId` | Metadados de um item |
| GET | `/api/library/:fileId/download` | Baixa o arquivo do servidor para o dispositivo |
| DELETE | `/api/library/:fileId` | Exclui um item |
| GET | `/media/:fileId.<container>` | Stream de vídeo/áudio (Range habilitado) |

## Observações

- A busca extrai dados da página pública de resultados do YouTube; mudanças de layout no YouTube podem exigir ajuste no parser (`lib/youtube.js`).
- O yt-dlp atualiza-se constantemente para acompanhar o YouTube — se os downloads voltarem a falhar, rode `npm install youtube-dl-exec@latest` (ou `npx youtube-dl-exec update`) para renovar o binário.
- Baixar vídeos do YouTube pode violar os Termos de Serviço — use por sua conta e risco, preferencialmente com conteúdo próprio/licenciado.
