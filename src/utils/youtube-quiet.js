'use strict';

/**
 * Silencia o "spam" de avisos do youtubei.js.
 *
 * O YouTube adiciona novos nodes de UI o tempo todo (ex.: a prateleira de
 * compras "ShoppingTimelyShelfView" na página de vídeo). Quando o parser
 * encontra um node que a lib ainda não conhece, ele gera a classe
 * dinamicamente (JIT) e CONTINUA funcionando — mas despeja avisos enormes
 * no console. Esses avisos não afetam o download.
 *
 * Estratégia:
 *  1. Log.setLevel(ERROR): esconde todos os avisos (WARNING) da lib, mas
 *     mantém erros de verdade visíveis no console.
 *  2. Quando possível, troca o manipulador de erros do parser por uma versão
 *     que registra UMA linha curta por node desconhecido (deduplicada).
 *
 * configure() é idempotente e pode ser chamada de vários pontos.
 */

let configured = false;
const seen = new Set();

async function configure() {
  if (configured) return;
  configured = true;

  try {
    const yt = await import('youtubei.js');

    if (yt.Log && yt.Log.Level && typeof yt.Log.setLevel === 'function') {
      yt.Log.setLevel(yt.Log.Level.ERROR);
    }

    // setParserErrorHandler não é exportado na raiz do pacote; acessa o módulo
    // interno por caminho absoluto (bypassa o mapa de "exports").
    try {
      const { createRequire } = require('node:module');
      const { pathToFileURL } = require('node:url');

      const nodeRequire = createRequire(__filename);
      const pkgJsonPath = nodeRequire.resolve('youtubei.js/package.json'); // './package.json' é exportado
      const parserUrl = pathToFileURL(pkgJsonPath).href.replace(
        /package\.json$/,
        'dist/src/parser/parser.js'
      );

      const parserModule = await import(parserUrl);

      if (typeof parserModule.setParserErrorHandler === 'function') {
        parserModule.setParserErrorHandler(({ classname, error_type: type }) => {
          const key = `${type}:${classname}`;
          if (seen.has(key)) return; // registra cada node desconhecido apenas 1x
          seen.add(key);
          console.warn(
            `[youtube-parser] Node '${classname}' (${type}) ainda não suportado pela lib — ignorado. O download não é afetado.`
          );
        });
        console.log('[youtube-quiet] Avisos do parser do YouTube silenciados (nodes desconhecidos aparecem 1x, em 1 linha).');
      }
    } catch (_) {
      // Sem acesso ao módulo interno: o Log.setLevel já elimina o ruído.
    }
  } catch (err) {
    console.warn('[youtube-quiet] Não foi possível configurar:', err.message);
  }
}

module.exports = { configure };
