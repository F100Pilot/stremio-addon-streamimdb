'use strict';
// Resolve streams do vidsrc através de um browser real.
//
// Porquê browser: a cadeia é
//   vidsrc.in/embed → vsembed.ru → cloudorchestranova.com/embed/player
// e o URL final do .m3u8 é descodificado em **WebAssembly** (vsdec.js) já
// dentro do player. Não há forma sã de replicar isso em axios — mas basta
// deixar a página correr e apanhar o .m3u8 quando ele passa na rede.
//
// Diferença importante para o antigo puppeteer_resolver (removido): esta
// cadeia **não tem Cloudflare Turnstile** em passo nenhum. Foi o loop
// infinito de challenges do streamimdb.me que tornava o outro inviável;
// aqui é só executar JS/WASM, o que funciona bem em headless.
//
// Browser partilhado, lazy (só arranca quando é preciso), com limite de
// concorrência e auto-fecho por inatividade para não segurar RAM à toa.

let puppeteer;
try {
  const extra = require('puppeteer-extra');
  extra.use(require('puppeteer-extra-plugin-stealth')());
  puppeteer = extra;
} catch {
  try { puppeteer = require('puppeteer'); } catch { puppeteer = null; }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

const NAV_TIMEOUT    = parseInt(process.env.VIDSRC_NAV_TIMEOUT_MS) || 30000;
const MAX_CONCURRENT = parseInt(process.env.VIDSRC_CONCURRENCY)    || 2;
const IDLE_CLOSE_MS  = parseInt(process.env.VIDSRC_IDLE_CLOSE_MS)  || 5 * 60 * 1000;
// Sem Turnstile para resolver, o headless normal chega e gasta menos.
const HEADLESS = process.env.VIDSRC_HEADLESS === 'false' ? false : 'new';

// Hosts de anúncios/tracking: bloqueados para a página carregar mais depressa
// e não abrir popunders.
const AD_RE = /histats|doubleclick|googlesyndication|googletagmanager|google-analytics|popunder|popads|popcash|propeller|onclick|llvpn|jsdelivr\.net\/npm\/disable/i;

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
  console.log(`[vidsrc] browser lançado (headless=${HEADLESS})`);
  return b;
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (activePages === 0 && browserPromise) {
      try { (await browserPromise).close(); console.log('[vidsrc] browser fechado (inatividade)'); }
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

// ── Resolução ────────────────────────────────────────────────────────────────
function embedUrl(imdbId, type, season, episode) {
  return type === 'series'
    ? `https://vidsrc.in/embed/tv/${imdbId}/${season}-${episode}`
    : `https://vidsrc.in/embed/movie/${imdbId}`;
}

async function resolveVidsrc(imdbId, type, season, episode) {
  if (!puppeteer) { console.log('[vidsrc] puppeteer indisponível — a saltar'); return null; }

  await acquire();
  activePages++;
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 720 });

    // Promessa que resolve assim que um .m3u8 passar na rede.
    let done;
    const m3u8 = new Promise(res => { done = res; });

    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = req.url();
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

    const target = embedUrl(imdbId, type, season, episode);
    console.log(`[vidsrc] a resolver ${target}`);
    page.goto(target, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});

    // O player costuma precisar de um clique para arrancar (#bigPlay).
    setTimeout(async () => {
      for (const frame of page.frames()) {
        try { await frame.click('#bigPlay, .jw-bigplay, #player', { delay: 30 }); } catch { /* não existe nesta frame */ }
      }
    }, 3000);

    const hit = await Promise.race([
      m3u8,
      new Promise(res => setTimeout(() => res(null), NAV_TIMEOUT)),
    ]);

    if (!hit) { console.log('[vidsrc] ✗ nenhum m3u8 capturado'); return null; }
    console.log(`[vidsrc] ✓ m3u8: ${hit.url.substring(0, 90)}...`);
    return [{
      url: hit.url,
      quality: 'Auto',
      // O nosso servidor tem o IP residencial bom, por isso serve via /hls
      // (mesma lógica das outras fontes na branch Server).
      proxyable: true,
      referer: hit.referer || 'https://cloudorchestranova.com/',
      source: 'VidSrc',
    }];
  } catch (e) {
    console.log(`[vidsrc] erro: ${e.message}`);
    return null;
  } finally {
    if (page) { try { await page.close(); } catch { /* já fechada */ } }
    activePages--;
    release();
    scheduleIdleClose();
  }
}

module.exports = { resolveVidsrc };
