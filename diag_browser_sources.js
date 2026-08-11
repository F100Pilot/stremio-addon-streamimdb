'use strict';
// Valida, UMA A UMA, as fontes do browser_resolver — resolução completa até ao
// m3u8, não apenas "o site respondeu".
//
// Porquê este script existe: a lista PROVIDERS do browser_resolver foi montada
// a partir da sonda diag_newsrc.js, que só mede se o servidor devolve HTML.
// Isso não diz nada sobre entregar vídeo: um site pode responder 200 e nunca
// chegar a um m3u8. Só o vidsrc.in está comprovado ponta-a-ponta; os restantes
// são candidatos por confirmar.
//
// Tem de correr no SERVIDOR CASEIRO (IP residencial). De um datacenter os
// resultados não valem nada — as CDNs bloqueiam o IP e tudo parece morto.
//
// Uso:
//   node diag_browser_sources.js                          # filme por defeito
//   node diag_browser_sources.js tt4655480 series 1 1      # episódio
//   BROWSER_DEBUG=1 node diag_browser_sources.js           # rede e frames
//
// Depois de saber quais prestam, poda a lista em produção:
//   BROWSER_PROVIDERS=vidsrc.in,embed.su
require('dotenv').config();

// ATENÇÃO à ordem: o browser_resolver lê estas variáveis no `require`, não a
// cada chamada. Defini-las depois do require não tem efeito nenhum — e o
// resultado é o circuit breaker abrir a meio do varrimento e saltar as fontes
// que faltavam, dando um relatório em que tudo parece morto.
//
// O breaker existe para proteger produção; num diagnóstico só esconderia
// fontes, por isso fica praticamente desligado.
process.env.BROWSER_CB_THRESHOLD = '9999';
process.env.BROWSER_PROVIDER_MS  = process.env.BROWSER_PROVIDER_MS || '20000';

// Um BROWSER_PROVIDERS já definido (no .env ou na linha de comando) serve aqui
// de filtro: testa só essas fontes. Tem de ser lido ANTES do ciclo, porque o
// ciclo reescreve a variável a cada iteração para isolar uma fonte de cada vez.
const FILTRO = (process.env.BROWSER_PROVIDERS || '').split(',').map(s => s.trim()).filter(Boolean);

const { PROVIDERS, resolveWithBrowser } = require('./browser_resolver');

const [, , IMDB = 'tt0076759', TYPE = 'movie', S = null, E = null] = process.argv;

const ALVO = FILTRO.length
  ? FILTRO.map(n => PROVIDERS.find(p => p.name === n)).filter(Boolean)
  : PROVIDERS;

(async () => {
  console.log(`\nValidação das fontes do browser_resolver`);
  console.log(`Título: ${IMDB} ${TYPE}${TYPE === 'series' ? ` S${S}E${E}` : ''}`);
  console.log(`Fontes a testar: ${ALVO.length}${FILTRO.length ? ` (filtradas de ${PROVIDERS.length})` : ''}\n`);

  const desconhecidas = FILTRO.filter(n => !PROVIDERS.some(p => p.name === n));
  if (desconhecidas.length) {
    console.log(`AVISO: nome(s) não reconhecido(s) em BROWSER_PROVIDERS: ${desconhecidas.join(', ')}`);
    console.log(`Nomes válidos: ${PROVIDERS.map(p => p.name).join(', ')}\n`);
  }
  if (!ALVO.length) { console.log('Nada para testar.\n'); process.exit(1); }

  if (!process.env.TMDB_API_KEY) {
    console.log('AVISO: TMDB_API_KEY não definida — as fontes indexadas por TMDB vão ser saltadas.\n');
  }

  const results = [];
  for (const p of ALVO) {
    // resolveWithBrowser pára na primeira fonte que resolve; restringir a lista
    // a uma fonte de cada vez é o que nos dá um veredicto por fonte.
    process.env.BROWSER_PROVIDERS = p.name;
    const t0 = Date.now();
    let streams = null;
    let error = null;
    try {
      streams = await resolveWithBrowser(IMDB, TYPE, S, E);
    } catch (e) {
      error = e.message;
    }
    const ms = Date.now() - t0;
    const s = streams && streams[0];
    results.push({
      name: p.name, mode: p.mode, id: p.id, proven: !!p.proven, ms,
      ok: !!s,
      url: s ? s.url : null,
      subs: s ? (s.subtitles || []).length : 0,
      release: s ? s.releaseName : null,
      error,
    });
    console.log(''); // separa o ruído de cada fonte
  }

  console.log('\n───────────────────────────────────────────────────────────────');
  console.log('RESUMO');
  console.log('───────────────────────────────────────────────────────────────');
  const pad = (s, n) => String(s).padEnd(n);
  for (const r of results) {
    const verdict = r.ok ? '✓ m3u8' : (r.error ? '✗ erro' : '✗ nada');
    const extra = r.ok
      ? `${r.subs} legenda(s)${r.release ? ` · ${String(r.release).split('/').pop().substring(0, 40)}` : ''}`
      : (r.error || '');
    console.log(`${pad(r.name, 16)} ${pad(r.mode, 7)} ${pad(verdict, 7)} ${pad(r.ms + 'ms', 8)} ${extra}`);
  }

  const live = results.filter(r => r.ok).map(r => r.name);
  console.log('\n───────────────────────────────────────────────────────────────');
  if (live.length) {
    console.log(`${live.length} de ${results.length} fontes entregaram m3u8.`);
    console.log(`\nPara usar só estas em produção, no .env:\n  BROWSER_PROVIDERS=${live.join(',')}`);
  } else {
    console.log('Nenhuma fonte entregou m3u8.');
    console.log('Confirma que corres isto no servidor caseiro e não num datacenter,');
    console.log('e repete com BROWSER_DEBUG=1 para veres onde a cadeia encrava.');
  }
  console.log('');
  process.exit(0);
})();
