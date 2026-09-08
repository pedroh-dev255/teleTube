# 📺 teleTube

Bot do Telegram que **pesquisa vídeos no YouTube**, lista os resultados **com thumbnails** e **baixa o áudio ou o vídeo** direto para o chat — com controle de acesso por usuários autorizados.

## ✨ Funcionalidades

- 🔎 Pesquisa no YouTube **sem precisar de API key** (via `yt-search`)
- 🖼️ Resultados enviados como fotos (thumbnail) com título, canal, duração e views + paginação
- 🎵 Download de **áudio** (m4a)
- 🎬 Download de **vídeo**:
  - Com **ffmpeg**: melhor qualidade disponível (H.264 + m4a mesclados com stream copy)
  - Arquivos acima do limite do Telegram são **divididos em partes** automaticamente
  - Opcionalmente, com um **servidor local da Bot API**, envia até ~2 GB em arquivo único
- 🗑️ Botão **Excluir** abaixo de cada vídeo enviado (remove as mensagens do chat)
- 👥 **Controle de acesso**: somente IDs autorizados usam o bot; o dono gerencia por comandos
- 📊 Progresso do download em tempo real (`⏬ Baixando... 42%`)
- 🔗 Reconhece links do YouTube (`watch`, `youtu.be`, `shorts`, `embed`, `live`)
- 🧹 Limpeza automática dos arquivos temporários do servidor

## 🚀 Como usar

1. Crie um bot com o [@BotFather](https://t.me/BotFather) e coloque o token no `.env`:
   ```
   BOT_TOKEN=123456:ABC-DEF...
   ALLOWED_USERS=658294274
   FFMPEG_PATH=ffmpeg
   ```
   - `ALLOWED_USERS`: IDs autorizados separados por vírgula. **O primeiro é o dono/admin**.
   - `FFMPEG_PATH`: caminho do ffmpeg (deixe `ffmpeg` se estiver no PATH do servidor).
2. Instale as dependências e inicie:
   ```bash
   npm install
   npm start        # ou: npm run dev (com nodemon)
   ```
3. No Telegram: envie qualquer texto para pesquisar (ou `/search <termo>`), ou cole o link de um vídeo.

### 👥 Permissões

| Comando | Quem usa | Efeito |
|---|---|---|
| `/id` | qualquer pessoa | Mostra o próprio ID do Telegram |
| `/adduser <id>` | dono | Libera acesso para o ID |
| `/deluser <id>` | dono | Revoga o acesso (o dono não pode ser removido) |
| `/users` | dono | Lista os IDs autorizados |

A lista fica persistida em `data/allowed-users.json` (criada a partir de `ALLOWED_USERS` na primeira execução).

## 📁 Estrutura

```
index.js                  # Entrada: valida .env, detecta ffmpeg e inicia o bot
src/
  bot.js                  # Handlers do Telegram (comandos, busca, callbacks, exclusão)
  config.js               # Configurações (.env, limites, caminhos)
  services/
    youtube.js            # Busca no YouTube (yt-search), URLs, paginação
    downloader.js         # Downloads (ytdl-core), seleção de formatos, mesclagem/divisão
    permissions.js        # Whitelist de usuários (persistida em data/)
  utils/
    ffmpeg.js             # Detecção, duração, mesclagem e divisão via ffmpeg
    format.js             # Formatação de duração, views, bytes, HTML e filenames
  tests/index.js          # Testes offline + rede (npm test)
```

## 🧪 Testes

```bash
npm test
```
A parte offline (formatação, permissões, URLs) roda em qualquer máquina. A parte de rede é **ignorada com aviso** onde o YouTube estiver bloqueado (ex.: PC de desenvolvimento).

## 🐛 Solução de problemas

- **`No valid URL to decipher` / "Nenhuma versão de vídeo cabe no limite"**
  O YouTube passou a responder **sem URLs de streaming** ("gated") para clientes web sem **PO Token**. O bot resolve isso com uma **cadeia de clientes** (`ANDROID_VR` → `IOS` → `TV_EMBEDDED` → `WEB`): ele testa cada cliente até obter formatos com URLs utilizáveis e **reaproveita a mesma resposta** no download (`VideoInfo.download`), evitando refazer a requisição com um cliente gated. Aparece no console `[youtube] Formatos obtidos via cliente X.` quando funciona.

- **`403 Forbidden` do googlevideo no download**
  As URLs de streaming são vinculadas ao **IP** (`ip=...`) e ao **cliente** (`c=...`) que as solicitaram. O bot usa um fetch customizado (`src/utils/yt-fetch.js`) que: define o **User-Agent do cliente** que gerou a URL e, se ainda assim o `googlevideo.com` recusar, **repete o download forçando a família de IP** (IPv6/IPv4) vinculada na URL. No console: `[youtube] Stream respondeu 403; tentando novamente...` seguido de `[youtube] Download OK forçando IPv6.` (ou IPv4).


- **Avisos `[YOUTUBEJS][Parser]` / `[YOUTUBEJS][Text]` gigantes no console**
  O YouTube adiciona novos componentes de UI às páginas (ex.: a prateleira de compras `ShoppingTimelyShelfView`) e a lib `youtubei.js` ainda não os conhece. **São inofensivos**: o parser gera a classe dinamicamente e o download continua normal. O bot já instala automaticamente (`src/utils/youtube-quiet.js`) um handler que silencia o ruído e registra cada node desconhecido apenas 1 vez, em 1 linha. Ao atualizar o `youtubei.js` para uma versão que conheça o node, o aviso simplesmente deixa de aparecer.

- **`409 Conflict: terminated by other getUpdates request`**
  Já existe **outra instância do bot rodando com o mesmo token** (ou outra conexão de polling aberta). Pare a outra instância antes de iniciar mais uma.

- **`unable to verify the first certificate`**
  Interferência de firewall/proxy com inspeção SSL no ambiente (típico em rede corporativa). No servidor de produção com acesso direto isso não ocorre.



## ⚠️ Limitações e observações

- **API oficial do Telegram**: bots enviam no máximo 50 MB por arquivo. Sem ffmpeg, só formatos progressivos que caibam nesse limite são enviados. **Com ffmpeg**, vídeos maiores são mesclados em HD e divididos em partes de ~45 MB (cada parte recebe o botão de exclusão).
- **Servidor local da Bot API** (opcional): definindo `TELEGRAM_API_URL` (ex.: `http://localhost:8081`), o limite sobe para ~2 GB e a divisão em partes deixa de ser necessária.
- `MAX_DOWNLOAD_MB` (padrão 2048) limita o tamanho do download adaptativo em HD.
- Vídeos privados, com restrição de idade ou lives não podem ser baixados.
- O botão 🗑️ exclui as mensagens do chat; o Telegram só permite exclusão até 48h após o envio.
- A versão do `node-telegram-bot-api` é fixada em **0.66.0** (a v2 do pacote é uma reescrita incompatível).
