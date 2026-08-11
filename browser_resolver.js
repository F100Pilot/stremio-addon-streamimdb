'use strict';
// Resolve streams através de um browser real, tentando várias fontes em série.
//
// Porquê browser: nas cadeias modernas (vidsrc e companhia) o URL final do
// .m3u8 é descodificado em **WebAssembly** já dentro do player. Não há forma sã
// de replicar isso em axios — mas basta deixar a página correr e apanhar o
// .m3u8 quando ele passa na rede.
//
// Diferença para o antigo puppeteer_resolver (removido): estas cadeias **não
// têm Cloudflare Turnstile**. Foi o loop infinito de challenges do
// streamimdb.me que tornava o outro inviável; aqui é só executar JS/WASM, o que
// funciona bem em headless e dispensa o Xvfb.
//
// Browser partilhado, lazy (só arranca quando é preciso), com limite de
// concorrência, circuit breaker e auto-fecho por inatividade.

const { convertImdbToTmdb } = require('./tmdb');

// puppeteer é opcional: no deploy Vercel não há Chromium nenhum. Sem ele este
// módulo inteiro é um no-op silencioso em vez de rebentar o require.
let puppeteer;
try {
  const extra = require('puppeteer-extra');
  extra.use(require('puppeteer-extra-plugin-stealth')());
  puppeteer = extra;
} catch {
  try { puppeteer = require('puppeteer'); } catch { puppeteer = null; }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

const NAV_TIMEOUT    = parseInt(process.env.BROWSER_NAV_TIMEOUT_MS) || 30000;
const PROVIDER_MS    = parseInt(process.env.BROWSER_PROVIDER_MS)    || 25000;
const MAX_CONCURRENT = parseInt(process.env.BROWSER_CONCURRENCY)    || 2;
const IDLE_CLOSE_MS  = parseInt(process.env.BROWSER_IDLE_CLOSE_MS)  || 5 * 60 * 1000;
const CB_THRESHOLD   = parseInt(process.env.BROWSER_CB_THRESHOLD)   || 5;
const CB_COOLDOWN_MS = parseInt(process.env.BROWSER_CB_COOLDOWN_MS) || 10 * 60 * 1000;
// Sem Turnstile para resolver, o headless normal chega e gasta menos.
const HEADLESS = process.env.BROWSER_HEADLESS === 'false' ? false : 'new';
// BROWSER_DEBUG=1 despeja pedidos de rede, frames e erros da página — é assim
// que se percebe em que ponto da cadeia o player encravou.
const DEBUG = process.env.BROWSER_DEBUG === '1';
// O caminho do browser só corre onde há Chromium instalado — na prática o
// servidor caseiro, que tem o IP residencial bom. Daí servir via o nosso /hls.
const PROXYABLE = process.env.BROWSER_PROXYABLE !== 'false';

// Hosts de anúncios/tracking: bloqueados para a página carregar mais depressa e
// não abrir popunders. Inclui o disable-devtool: essa biblioteca detecta
// automação e pode abortar o player antes de ele pedir o m3u8. Bloqueá-la é o
// que nos deixa correr em headless.
const AD_RE = /histats|doubleclick|googlesyndication|googletagmanager|google-analytics|popunder|popads|popcash|propeller|onclick|llvpn|allowtohimselfew|edtoflyawayutbefo|disable-devtool/i;

// ── Fontes ───────────────────────────────────────────────────────────────────
// `mode`:
//   chain  — axios segue os iframes até encontrar `window.CFG.playerUrl` e só
//            então entrega ao browser a última página (a do WASM). Mais barato
//            e mais determinista que carregar a cadeia toda no Chromium, e
//            evita ter de clicar em iframes aninhados.
//   direct — carrega o embed directamente no browser, bloqueia anúncios, clica
//            no play e apanha o m3u8 que passar na rede.
//
// `id`: que identificador o provider indexa ('imdb' ou 'tmdb').
//
// ATENÇÃO — só o vidsrc.in está comprovado. Os restantes vieram da sonda
// diag_newsrc.js e NUNCA foram validados ponta-a-ponta: respondiam ao pedido
// HTTP, o que não é o mesmo que entregar um m3u8. Corre o diag_browser_sources.js
// no servidor caseiro para saber quais valem a pena e poda a lista com
// BROWSER_PROVIDERS.
const PROVIDERS = [
  {
    name: 'vidsrc.in', mode: 'chain', id: 'imdb', proven: true,
    url: ({ imdbId, type, season, episode }) => type === 'series'
      ? `https://vidsrc.in/embed/tv/${imdbId}/${season}-${episode}`
      : `https://vidsrc.in/embed/movie/${imdbId}`,
  },
  {
    name: 'vidsrc.xyz', mode: 'chain', id: 'imdb',
    url: ({ imdbId, type, season, episode }) => type === 'series'
      ? `https://vidsrc.xyz/embed/tv/${imdbId}/${season}-${episode}`
      : `https://vidsrc.xyz/embed/movie/${imdbId}`,
  },
  // vidsrc.pm foi retirado: a investigação de Jul/2026 (ver "Fontes já
  // descartadas" no CLAUDE.md) encontrou Cloudflare Turnstile no
  // nextgencloudfabric.com, e Turnstile é precisamente o que este resolver não
  // sabe passar — foi o que matou o antigo puppeteer_resolver.
  {
    name: 'vidsrc.cc', mode: 'direct', id: 'tmdb',
    url: ({ tmdbId, type, season, episode }) => type === 'series'
      ? `https://vidsrc.cc/v2/embed/tv/${tmdbId}/${season}/${episode}`
      : `https://vidsrc.cc/v2/embed/movie/${tmdbId}`,
  },
  {
    name: 'embed.su', mode: 'direct', id: 'tmdb',
    url: ({ tmdbId, type, season, episode }) => type === 'series'
      ? `https://embed.su/embed/tv/${tmdbId}/${season}/${episode}`
      : `https://embed.su/embed/movie/${tmdbId}`,
  },
  {
    name: 'moviesapi.club', mode: 'direct', id: 'tmdb',
    url: ({ tmdbId, type, season, episode }) => type === 'series'
      ? `https://moviesapi.club/tv/${tmdbId}-${season}-${episode}`
      : `https://moviesapi.club/movie/${tmdbId}`,
  },
  {
    name: 'autoembed.cc', mode: 'direct', id: 'tmdb',
    url: ({ tmdbId, type, season, episode }) => type === 'series'
      ? `https://player.autoembed.cc/embed/tv/${tmdbId}/${season}/${episode}`
      : `https://player.autoembed.cc/embed/movie/${tmdbId}`,
  },
  {
    name: '111movies', mode: 'direct', id: 'tmdb',
    url: ({ tmdbId, type, season, episode }) => type === 'series'
      ? `https://111movies.com/tv/${tmdbId}/${season}/${episode}`
      : `https://111movies.com/movie/${tmdbId}`,
  },
  {
    name: 'vidsrc.icu', mode: 'direct', id: 'tmdb',
    url: ({ tmdbId, type, season, episode }) => type === 'series'
      ? `https://vidsrc.icu/embed/tv/${tmdbId}/${season}/${episode}`
      : `https://vidsrc.icu/embed/movie/${tmdbId}`,
  },
  {
    name: 'nontongo.win', mode: 'direct', id: 'tmdb',
    url: ({ tmdbId, type, season, episode }) => type === 'series'
      ? `https://www.nontongo.win/embed/tv/${tmdbId}/${season}/${episode}`
      : `https://www.nontongo.win/embed/movie/${tmdbId}`,
  },
  // As duas seguintes ficam no fim de propósito: são as menos prováveis de
  // prestar, e assim não atrasam as outras em produção.
  {
    // O 2embed.cc foi descartado em Jul/2026 por ser hoje uma landing de
    // anúncios. O .skin é outro domínio da mesma família — pode ter tido o
    // mesmo destino, mas não é o mesmo host, por isso vale medir em vez de
    // assumir. O formato do URL de série é mesmo assim (`&s=`, não `?s=`).
    name: '2embed.skin', mode: 'direct', id: 'imdb',
    url: ({ imdbId, type, season, episode }) => type === 'series'
      ? `https://www.2embed.skin/embedtv/${imdbId}&s=${season}&e=${episode}`
      : `https://www.2embed.skin/embed/${imdbId}`,
  },
  {
    // O multiembed só alguma vez foi tentado por axios (o `directstream.php`
    // do alt_scraper, removido), e nunca resolveu nada. Aqui vai a página do
    // player em vez do directstream: é JS que monta o stream, que é justamente
    // o que o axios não conseguia executar. Por isso é um teste novo, não uma
    // repetição do que já falhou.
    name: 'multiembed', mode: 'direct', id: 'imdb',
    url: ({ imdbId, type, season, episode }) => type === 'series'
      ? `https://multiembed.mov/?video_id=${imdbId}&s=${season}&e=${episode}`
      : `https://multiembed.mov/?video_id=${imdbId}`,
  },
];

// BROWSER_PROVIDERS=vidsrc.in,embed.su restringe (e reordena) a lista.
function activeProviders() {
  const want = (process.env.BROWSER_PROVIDERS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!want.length) return PROVIDERS;
  return want.map(n => PROVIDERS.find(p => p.name === n)).filter(Boolean);
}

// ── Circuit breaker ──────────────────────────────────────────────────────────
// Depois de N falhas seguidas, pára de lançar o browser durante um tempo. Sem
// isto, um título indisponível faz-nos martelar todas as fontes de cada vez que
// o Stremio repete o pedido.
let consecutiveFailures = 0;
let breakerUntil = 0;

function breakerOpen() {
  if (Date.now() < breakerUntil) return true;
  if (breakerUntil && Date.now() >= breakerUntil) {
    breakerUntil = 0;
    consecutiveFailures = 0;
    console.log('[browser] circuit breaker reposto');
  }
  return false;
}

function recordFailure() {
  if (++consecutiveFailures >= CB_THRESHOLD) {
    breakerUntil = Date.now() + CB_COOLDOWN_MS;
    console.log(`[browser] circuit breaker ABERTO por ${Math.round(CB_COOLDOWN_MS / 1000)}s (${consecutiveFailures} falhas seguidas)`);
  }
}

function recordSuccess() {
  consecutiveFailures = 0;
  breakerUntil = 0;
}

// ── Browser partilhado ───────────────────────────────────────────────────────
let browserPromise = null;
let idleTimer = null;
let activePages = 0;

async function getBrowser() {
  if (!puppeteer) throw new Error('puppeteer não instalado (npm install)');
  if (browserPromise) {
    const b = await browserPromise;
    if (b.isConnected()) return b;
    browserPromise = null;
  }
  browserPromise = puppeteer.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--mute-audio', '--no-first-run', '--window-size=1280,720',
      ...(HEADLESS ? ['--disable-gpu'] : []),
    ],
  });
  const b = await browserPromise;
  b.on('disconnected', () => { browserPromise = null; });
  console.log(`[browser] lançado (headless=${HEADLESS})`);
  return b;
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (activePages === 0 && browserPromise) {
      try { (await browserPromise).close(); console.log('[browser] fechado (inatividade)'); }
      catch { /* já fechado */ }
      browserPromise = null;
    }
  }, IDLE_CLOSE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

// ── Semáforo ─────────────────────────────────────────────────────────────────
let running = 0;
const queue = [];
const acquire = () => running < MAX_CONCURRENT
  ? (running++, Promise.resolve())
  : new Promise(res => queue.push(res));
function release() {
  running--;
  const next = queue.shift();
  if (next) { running++; next(); }
}

// ── Modo chain: seguir a cadeia com axios até ao player ──────────────────────
const MAX_HOPS = 4;

async function resolvePlayerUrl(startUrl) {
  const axios = require('axios');
  const get = (url, referer) => axios.get(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(referer ? { Referer: referer, Origin: new URL(referer).origin } : {}),
    },
    timeout: 12000, maxRedirects: 5, validateStatus: () => true,
    responseType: 'text', transformResponse: x => x,
  });

  let url = startUrl;
  let referer = null;

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const res = await get(url, referer);
    const body = String(res.data || '');

    // Chegámos ao player? O window.CFG traz o playerUrl (a página do WASM).
    const cfgRaw = body.match(/window\.CFG\s*=\s*(\{[\s\S]*?\})\s*[;<]/);
    if (cfgRaw) {
      let cfg;
      try { cfg = JSON.parse(cfgRaw[1]); }
      catch (e) { console.log(`[browser:chain] CFG inválido: ${e.message}`); return null; }
      if (!cfg.playerUrl) { console.log('[browser:chain] CFG sem playerUrl'); return null; }

      const meta = await readMeta(cfg, url, get);
      return { url: new URL(cfg.playerUrl, url).href, referer: url, ...meta };
    }

    // Senão, segue o próximo iframe.
    const next = body.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1];
    if (!next) {
      console.log(`[browser:chain] hop ${hop + 1}: sem iframe nem CFG`);
      return null;
    }
    referer = url;
    url = new URL(next, url).href;
  }

  console.log(`[browser:chain] ${MAX_HOPS} hops sem chegar ao player`);
  return null;
}

// Legendas próprias da fonte (`default_subs` do metaApi). São as que
// correspondem a ESTE encode — usar as de outra fonte dessincroniza, porque são
// releases diferentes.
async function readMeta(cfg, baseUrl, get) {
  if (!cfg.metaApi) return { subtitles: [], releaseName: null };
  try {
    const meta = await get(cfg.metaApi, baseUrl);
    const data = typeof meta.data === 'string' ? JSON.parse(meta.data) : meta.data;
    const subtitles = (data?.default_subs || [])
      .map(s => ({ url: s.url || s.file || s.src, lang: s.lang || s.language || s.label || null }))
      .filter(s => s.url);
    // O nome do ficheiro identifica o release (ex.: "...1080p.WEB-DL...-SbR").
    const releaseName = data?.data?.file_name || data?.file_name || null;
    console.log(`[browser:chain] ${subtitles.length} legenda(s) próprias${releaseName ? ` · release: ${releaseName.split('/').pop()}` : ''}`);
    return { subtitles, releaseName };
  } catch (e) {
    console.log(`[browser:chain] metaApi falhou: ${e.message}`);
    return { subtitles: [], releaseName: null };
  }
}

// ── Resolução de um provider ─────────────────────────────────────────────────
async function tryProvider(browser, provider, ids) {
  const startUrl = provider.url(ids);
  console.log(`[browser] ${provider.name} (${provider.mode}) → ${startUrl}`);

  let target = { url: startUrl, referer: null, subtitles: [], releaseName: null };
  if (provider.mode === 'chain') {
    const player = await resolvePlayerUrl(startUrl);
    if (!player) return null;
    target = player;
    if (DEBUG) console.log(`[browser:debug] playerUrl: ${player.url}`);
  }

  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 720 });

    // Promessa que resolve assim que um .m3u8 passar na rede.
    let done;
    const m3u8 = new Promise(res => { done = res; });

    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = req.url();
      if (DEBUG) console.log(`[browser:req] ${req.resourceType().padEnd(10)} ${url.substring(0, 130)}`);
      if (AD_RE.test(url)) return req.abort().catch(() => {});
      if (/\.m3u8(\?|$)/i.test(url)) {
        done({ url, referer: req.frame()?.url() || page.url() });
        // deixa seguir: abortar aqui às vezes faz o player tentar outro caminho
      }
      req.continue().catch(() => {});
    });
    // Alguns players pedem o m3u8 via XHR cuja resposta é que traz o URL final.
    page.on('response', res => {
      const url = res.url();
      if (/\.m3u8(\?|$)/i.test(url)) done({ url, referer: page.url() });
    });
    if (DEBUG) {
      page.on('console', m => console.log(`[browser:console] ${m.text().substring(0, 200)}`));
      page.on('pageerror', e => console.log(`[browser:pageerror] ${e.message.substring(0, 200)}`));
      page.on('framenavigated', f => console.log(`[browser:frame→] ${f.url().substring(0, 130)}`));
    }

    // Sem o referer da página que gerou o playerUrl, o token é rejeitado.
    if (target.referer) await page.setExtraHTTPHeaders({ Referer: target.referer });
    page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});

    // Quase todos estes players seguram o arranque atrás de um botão de play,
    // às vezes dentro de iframes aninhados. Clicar em ciclo é mais robusto do
    // que tentar adivinhar qual o selector certo desta fonte.
    const clicker = setInterval(async () => {
      for (const frame of page.frames()) {
        for (const sel of ['#bigPlay', '.jw-bigplay', '#pl_but', '#player', 'video']) {
          try { await frame.click(sel, { delay: 20 }); } catch { /* selector ausente nesta frame */ }
        }
      }
    }, 2000);

    const hit = await Promise.race([
      m3u8,
      new Promise(res => setTimeout(() => res(null), PROVIDER_MS)),
    ]);
    clearInterval(clicker);

    if (!hit) {
      console.log(`[browser] ✗ ${provider.name}: nenhum m3u8 capturado`);
      if (DEBUG) {
        console.log('[browser:debug] frames no fim:');
        for (const f of page.frames()) console.log(`    ${f.url().substring(0, 140)}`);
      }
      return null;
    }

    console.log(`[browser] ✓ ${provider.name}: ${hit.url.substring(0, 90)}...`);
    return [{
      url: hit.url,
      quality: 'Auto',
      proxyable: PROXYABLE,
      referer: hit.referer || target.referer || startUrl,
      source: provider.name,
      subtitles: target.subtitles || [],
      releaseName: target.releaseName || null,
    }];
  } finally {
    try { await page.close(); } catch { /* já fechada */ }
  }
}

// ── Entrada ──────────────────────────────────────────────────────────────────
async function resolveWithBrowser(imdbId, type, season, episode) {
  if (!puppeteer) { console.log('[browser] puppeteer indisponível — a saltar'); return null; }
  if (breakerOpen()) {
    console.log(`[browser] circuit breaker aberto (mais ${Math.round((breakerUntil - Date.now()) / 1000)}s) — a saltar`);
    return null;
  }

  const providers = activeProviders();
  if (!providers.length) { console.log('[browser] nenhuma fonte activa'); return null; }

  // Só convertemos para TMDB se alguma fonte activa precisar disso — poupa uma
  // chamada à API quando a lista está podada às fontes indexadas por IMDb.
  let tmdbId = null;
  if (providers.some(p => p.id === 'tmdb')) {
    tmdbId = (await convertImdbToTmdb(imdbId))?.id || null;
    if (!tmdbId) console.log('[browser] sem TMDB id — fontes que o exigem serão saltadas');
  }
  const ids = { imdbId, tmdbId, type, season, episode };

  await acquire();
  activePages++;
  try {
    // Lançar o browser uma só vez: se o Chromium não existir ou não arrancar,
    // não vale a pena repetir a tentativa por cada uma das fontes da lista.
    let browser;
    try {
      browser = await getBrowser();
    } catch (e) {
      console.log(`[browser] não foi possível lançar o Chromium: ${e.message}`);
      recordFailure();
      return null;
    }

    for (const provider of providers) {
      if (provider.id === 'tmdb' && !tmdbId) continue;
      try {
        const streams = await tryProvider(browser, provider, ids);
        if (streams && streams.length) { recordSuccess(); return streams; }
      } catch (e) {
        console.log(`[browser] ${provider.name} erro: ${e.message}`);
      }
    }
    // Nenhuma fonte deu nada: conta como falha para o circuit breaker.
    recordFailure();
    return null;
  } finally {
    activePages--;
    release();
    scheduleIdleClose();
  }
}

function getStatus() {
  return {
    available: !!puppeteer,
    headless: HEADLESS,
    providers: activeProviders().map(p => p.name),
    activePages,
    running,
    queued: queue.length,
    breaker: {
      open: Date.now() < breakerUntil,
      consecutiveFailures,
      cooldownRemainingSeconds: breakerUntil ? Math.max(0, Math.round((breakerUntil - Date.now()) / 1000)) : 0,
    },
  };
}

module.exports = { resolveWithBrowser, getStatus, PROVIDERS };
