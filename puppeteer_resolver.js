'use strict';
// Resolver via browser real — passa o Cloudflare Turnstile que bloqueia o axios.
// Browser partilhado + limite de concorrência + auto-fecho por inatividade.
const axios = require('axios');
let puppeteer;
try { puppeteer = require('puppeteer'); } catch { puppeteer = null; }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const NAV_TIMEOUT   = parseInt(process.env.PPT_NAV_TIMEOUT_MS)   || 45000;
const MAX_CONCURRENT = parseInt(process.env.PPT_CONCURRENCY)     || 2;
const IDLE_CLOSE_MS = parseInt(process.env.PPT_IDLE_CLOSE_MS)    || 5 * 60 * 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Browser partilhado ───────────────────────────────────────────────────────
let browserPromise = null;
let idleTimer = null;
let activePages = 0;

async function getBrowser() {
  if (!puppeteer) throw new Error('puppeteer não instalado');
  if (browserPromise) {
    const b = await browserPromise;
    if (b.isConnected()) return b;
    browserPromise = null; // crashou — relança
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

// ── Resolução ─────────────────────────────────────────────────────────────────
async function doResolve(imdbId, type, season, episode) {
  const embedUrl = type === 'series'
    ? `https://streamimdb.me/embed/${imdbId}/${season}/${episode}/`
    : `https://streamimdb.me/embed/${imdbId}/`;

  // 1. axios extrai o rcp URL (não detetado)
  const embed = await axios.get(embedUrl, {
    headers: { 'User-Agent': UA }, timeout: 12000, validateStatus: () => true,
  });
  const m = String(embed.data).match(/id="player_iframe"[^>]+src="([^"]+)"/);
  if (!m) { console.log('[puppeteer] iframe rcp não encontrado'); return null; }
  let rcpUrl = m[1];
  if (rcpUrl.startsWith('//')) rcpUrl = 'https:' + rcpUrl;

  const browser = await getBrowser();
  const page = await browser.newPage();
  activePages++;

  let resolved = null;
  let m3u8Referer = 'https://cloudorchestranova.com/';

  try {
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 720 });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });

    const cleanHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0">
      <iframe id="player_iframe" src="${rcpUrl}" allow="autoplay; fullscreen; encrypted-media"
        style="width:1280px;height:720px;border:0"></iframe></body></html>`;

    await page.setRequestInterception(true);

    let captured = null;
    page.on('request', req => {
      try {
        const url = req.url();
        if (req.isNavigationRequest() && req.frame() === page.mainFrame()
            && url.startsWith('https://streamimdb.me/embed/')) {
          return req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: cleanHtml });
        }
        if (!captured && url.includes('.m3u8')) {
          captured = url;
          m3u8Referer = req.headers().referer || m3u8Referer;
        }
        // bloqueia anúncios/trackers conhecidos para poupar recursos
        if (/(histats|\.cfd\/|unwrapsstow|specefeaster|popunder|doubleclick)/i.test(url)) {
          return req.abort();
        }
        req.continue();
      } catch (_) { try { req.continue(); } catch (__) {} }
    });

    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});

    // clica play e espera o m3u8
    const deadline = Date.now() + NAV_TIMEOUT;
    while (!captured && Date.now() < deadline) {
      for (const frame of page.frames()) {
        try { const b = await frame.$('#pl_but'); if (b) await b.click().catch(() => {}); } catch (_) {}
      }
      await sleep(1500);
    }

    if (captured) {
      resolved = [{ url: captured, quality: 'Auto', proxyable: true, referer: m3u8Referer }];
      console.log(`[puppeteer] ✓ m3u8: ${captured.substring(0, 70)}...`);
    } else {
      console.log('[puppeteer] ✗ sem m3u8 dentro do tempo');
    }
  } catch (e) {
    console.log(`[puppeteer] erro: ${e.message}`);
  } finally {
    try { await page.close(); } catch (_) {}
    activePages--;
    scheduleIdleClose();
  }

  return resolved;
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
