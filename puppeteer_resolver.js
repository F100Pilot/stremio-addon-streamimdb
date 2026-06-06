'use strict';
// Resolver via browser real — passa o Cloudflare Turnstile que bloqueia o axios.
// Browser partilhado + limite de concorrência + auto-fecho por inatividade.
// Orientado por lista de PROVIDERS para redundância: se um morre, tenta o seguinte.
const axios = require('axios');
let puppeteer;
try { puppeteer = require('puppeteer'); } catch { puppeteer = null; }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const NAV_TIMEOUT    = parseInt(process.env.PPT_NAV_TIMEOUT_MS) || 45000;
const MAX_CONCURRENT = parseInt(process.env.PPT_CONCURRENCY)    || 2;
const IDLE_CLOSE_MS  = parseInt(process.env.PPT_IDLE_CLOSE_MS)  || 5 * 60 * 1000;
const PER_PROVIDER_MS = parseInt(process.env.PPT_PROVIDER_MS)   || 22000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── PROVIDERS ────────────────────────────────────────────────────────────────
// mode 'extract': axios busca o embed → extrai a iframe do player → carrega-a numa
//   página limpa na origin do provider (evita anti-bot/ads). Comprovado p/ streamimdb.
// mode 'direct': carrega o embed directamente no browser (stealth + bloqueio de ads).
// Para adicionar/remover fontes, edita só esta lista.
const PROVIDERS = [
  {
    name: 'streamimdb',
    mode: 'extract',
    embed: (id, t, s, e) => t === 'series'
      ? `https://streamimdb.me/embed/${id}/${s}/${e}/`
      : `https://streamimdb.me/embed/${id}/`,
  },
  {
    name: 'vidsrc.net',
    mode: 'direct',
    embed: (id, t, s, e) => t === 'series'
      ? `https://vidsrc.net/embed/tv/${id}/${s}/${e}`
      : `https://vidsrc.net/embed/movie/${id}`,
  },
  {
    name: '2embed',
    mode: 'direct',
    embed: (id, t, s, e) => t === 'series'
      ? `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${e}`
      : `https://www.2embed.cc/embed/${id}`,
  },
];

const PLAY_SELECTORS = ['#pl_but', '.fa-play', '.play-button', '.jw-icon-display', '#player', 'video'];
const AD_RE = /(histats|\.cfd\/|unwrapsstow|specefeaster|popunder|doubleclick|googlesyndication|adservice|propeller|onclick|popcash|popads)/i;

// ── Browser partilhado ───────────────────────────────────────────────────────
let browserPromise = null;
let idleTimer = null;
let activePages = 0;

async function getBrowser() {
  if (!puppeteer) throw new Error('puppeteer não instalado');
  if (browserPromise) {
    const b = await browserPromise;
    if (b.isConnected()) return b;
    browserPromise = null;
  }
  browserPromise = puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-gpu', '--mute-audio', '--no-first-run',
      '--window-size=1280,720',
    ],
  });
  const b = await browserPromise;
  b.on('disconnected', () => { browserPromise = null; });
  console.log('[puppeteer] browser lançado');
  return b;
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (activePages === 0 && browserPromise) {
      try { const b = await browserPromise; await b.close(); console.log('[puppeteer] browser fechado (inatividade)'); }
      catch (_) {}
      browserPromise = null;
    }
  }, IDLE_CLOSE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

// ── Semáforo de concorrência ─────────────────────────────────────────────────
let running = 0;
const queue = [];
function acquire() {
  if (running < MAX_CONCURRENT) { running++; return Promise.resolve(); }
  return new Promise(res => queue.push(res));
}
function release() {
  running--;
  const next = queue.shift();
  if (next) { running++; next(); }
}

// ── Captura genérica numa página ──────────────────────────────────────────────
// Devolve { url, referer } do primeiro .m3u8 visto, ou null.
async function captureOnPage(browser, provider, embedUrl) {
  const page = await browser.newPage();
  activePages++;
  let result = null;

  try {
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 720 });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });

    // Modo extract: prepara HTML limpo com a iframe do player
    let cleanHtml = null;
    let embedPrefix = null;
    if (provider.mode === 'extract') {
      const embed = await axios.get(embedUrl, {
        headers: { 'User-Agent': UA }, timeout: 12000, validateStatus: () => true,
      });
      const m = String(embed.data).match(/id="player_iframe"[^>]+src="([^"]+)"/)
        || String(embed.data).match(/<iframe[^>]+src="([^"]+)"[^>]*allowfullscreen/i);
      if (!m) { console.log(`[puppeteer:${provider.name}] iframe não encontrado`); return null; }
      let rcpUrl = m[1];
      if (rcpUrl.startsWith('//')) rcpUrl = 'https:' + rcpUrl;
      cleanHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0">
        <iframe id="player_iframe" src="${rcpUrl}" allow="autoplay; fullscreen; encrypted-media"
          style="width:1280px;height:720px;border:0"></iframe></body></html>`;
      embedPrefix = embedUrl.split('?')[0];
    }

    let captured = null;
    let capturedReferer = null;

    await page.setRequestInterception(true);
    page.on('request', req => {
      try {
        const url = req.url();
        if (cleanHtml && req.isNavigationRequest() && req.frame() === page.mainFrame()
            && url.split('?')[0] === embedPrefix) {
          return req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: cleanHtml });
        }
        if (!captured && url.includes('.m3u8')) {
          captured = url;
          capturedReferer = req.headers().referer || null;
        }
        if (AD_RE.test(url)) return req.abort();
        req.continue();
      } catch (_) { try { req.continue(); } catch (__) {} }
    });

    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});

    const deadline = Date.now() + PER_PROVIDER_MS;
    while (!captured && Date.now() < deadline) {
      for (const frame of page.frames()) {
        for (const sel of PLAY_SELECTORS) {
          try { const el = await frame.$(sel); if (el) await el.click().catch(() => {}); } catch (_) {}
        }
      }
      await sleep(1500);
    }

    if (captured) {
      // Referer: o que foi capturado, ou a origin do próprio m3u8/embed
      let referer = capturedReferer;
      if (!referer) { try { referer = new URL(embedUrl).origin + '/'; } catch { referer = ''; } }
      result = { url: captured, referer };
      console.log(`[puppeteer:${provider.name}] ✓ m3u8: ${captured.substring(0, 70)}...`);
    } else {
      console.log(`[puppeteer:${provider.name}] ✗ sem m3u8`);
    }
  } catch (e) {
    console.log(`[puppeteer:${provider.name}] erro: ${e.message}`);
  } finally {
    try { await page.close(); } catch (_) {}
    activePages--;
    scheduleIdleClose();
  }

  return result;
}

// ── Resolução: tenta cada provider em sequência ───────────────────────────────
async function doResolve(imdbId, type, season, episode) {
  const browser = await getBrowser();
  for (const provider of PROVIDERS) {
    let embedUrl;
    try { embedUrl = provider.embed(imdbId, type, season, episode); } catch { continue; }
    const r = await captureOnPage(browser, provider, embedUrl);
    if (r && r.url) {
      return [{ url: r.url, quality: 'Auto', proxyable: true, referer: r.referer }];
    }
  }
  return null;
}

async function resolvePuppeteer(imdbId, type, season, episode) {
  if (!puppeteer) { console.log('[puppeteer] indisponível (não instalado)'); return null; }
  await acquire();
  try {
    return await doResolve(imdbId, type, season, episode);
  } finally {
    release();
  }
}

module.exports = { resolvePuppeteer };
