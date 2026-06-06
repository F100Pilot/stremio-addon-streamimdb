'use strict';
// Corre: node diag_ppt.js
// Testa o fluxo completo do Puppeteer para Star Wars (tt0076759).
// Mostra todos os URLs interceptados e se o m3u8 foi capturado.

const axios = require('axios');
const puppeteer = require('puppeteer');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const IMDB  = 'tt0076759';
const EMBED = `https://streamimdb.me/embed/${IMDB}/`;
const TIMEOUT = 60000; // 60s para dar tempo ao Turnstile

async function main() {
  console.log('[diag] Passo 1: axios busca embed para extrair iframe rcp...');
  const embedRes = await axios.get(EMBED, {
    headers: { 'User-Agent': UA }, timeout: 12000, validateStatus: () => true,
  });
  console.log(`[diag] embed HTTP ${embedRes.status}`);

  const body = typeof embedRes.data === 'string' ? embedRes.data : '';
  const m = body.match(/id="player_iframe"[^>]+src="([^"]+)"/)
         || body.match(/<iframe[^>]+src="([^"]+)"[^>]*allowfullscreen/i);

  if (!m) { console.log('[diag] ✗ iframe não encontrado no embed'); process.exit(1); }
  let rcpUrl = m[1];
  if (rcpUrl.startsWith('//')) rcpUrl = 'https:' + rcpUrl;
  console.log(`[diag] ✓ rcp URL: ${rcpUrl}`);

  const cleanHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0">
    <iframe src="${rcpUrl}" allow="autoplay; fullscreen; encrypted-media"
      style="width:1280px;height:720px;border:0"></iframe></body></html>`;
  const embedPrefix = EMBED.split('?')[0];

  console.log('\n[diag] Passo 2: lançar Chromium...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-gpu', '--mute-audio', '--window-size=1280,720',
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const seen = [];
  let captured = null;

  await page.setRequestInterception(true);
  page.on('request', req => {
    try {
      const url = req.url();
      // Intercept embed navigation → serve cleanHtml
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()
          && url.split('?')[0] === embedPrefix) {
        console.log(`[diag] intercepted embed nav → a servir cleanHtml`);
        return req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: cleanHtml });
      }
      // Log all requests
      const short = url.length > 100 ? url.substring(0, 100) + '…' : url;
      if (!seen.includes(short)) { seen.push(short); console.log(`[req] ${short}`); }
      // Capture m3u8
      if (!captured && url.includes('.m3u8')) {
        captured = url;
        console.log(`\n[diag] ✓ M3U8 CAPTURADO: ${url}\n`);
      }
      req.continue();
    } catch (_) { try { req.continue(); } catch (__) {} }
  });

  console.log('[diag] Passo 3: goto embed (será interceptado)...');
  await page.goto(EMBED, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => {
    console.log(`[diag] goto erro (ignorado): ${e.message}`);
  });

  console.log(`[diag] Passo 4: a aguardar m3u8 por ${TIMEOUT / 1000}s (a clicar play)...`);
  const deadline = Date.now() + TIMEOUT;
  const selectors = ['#pl_but', '.fa-play', '.play-button', '.jw-icon-display', '#player', 'video'];

  while (!captured && Date.now() < deadline) {
    for (const frame of page.frames()) {
      for (const sel of selectors) {
        try {
          const el = await frame.$(sel);
          if (el) { console.log(`[diag] click: ${sel}`); await el.click().catch(() => {}); }
        } catch (_) {}
      }
    }
    await new Promise(r => setTimeout(r, 2000));
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    process.stdout.write(`\r[diag] ${remaining}s restantes...`);
  }

  console.log('');
  if (captured) {
    console.log(`\n[diag] ✓ SUCESSO — m3u8: ${captured}`);
  } else {
    console.log('\n[diag] ✗ FALHA — nenhum m3u8 capturado em 60s');
    console.log('[diag] Verifica os URLs acima — o Turnstile resolveu?');
    console.log('[diag] Procura por "rcp_verify" ou "prorcp" nos requests.');
  }

  await browser.close();
}

main().catch(e => { console.error('[diag] Erro fatal:', e.message); process.exit(1); });
