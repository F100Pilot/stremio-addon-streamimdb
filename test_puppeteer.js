'use strict';
// Teste diagnóstico com stealth manual
// Uso: node test_puppeteer.js [tt0076759]
const puppeteer = require('puppeteer');

const imdbId = process.argv.find(a => a.startsWith('tt')) || 'tt0076759';
const embedUrl = `https://streamimdb.me/embed/${imdbId}/`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`\n=== Teste Puppeteer + Stealth ===`);
  console.log(`IMDb: ${imdbId}\n`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,720',
      '--lang=en-US,en',
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1280, height: 720 });

  // Stealth manual: esconde sinais de automação
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
    const orig = navigator.permissions.query;
    navigator.permissions.query = (p) => p.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : orig(p);
  });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  let reqCount = 0;
  const domains = {};
  const m3u8Urls = new Set();
  const interesting = [];

  page.on('request', req => {
    reqCount++;
    try { const h = new URL(req.url()).hostname; domains[h] = (domains[h]||0)+1; } catch(_){}
    const url = req.url();
    if (url.includes('.m3u8')) {
      m3u8Urls.add(url);
      console.log(`  >>> M3U8: ${url}`);
      console.log(`      Referer: ${req.headers().referer || '(nenhum)'}`);
    }
    if (/(prorcp|rcp_verify|turnstile|challenges\.cloudflare|\.mp4|master|playlist)/i.test(url)) {
      interesting.push(`${req.method()} ${url.substring(0, 110)}`);
    }
  });

  console.log('1. A carregar embed (networkidle2)...');
  try {
    await page.goto(embedUrl, { waitUntil: 'networkidle2', timeout: 35000 });
  } catch (e) { console.log('   goto timeout/erro:', e.message); }

  await sleep(2000);
  const info = await page.evaluate(() => ({
    url: location.href, title: document.title,
    bodyLen: document.body ? document.body.innerHTML.length : 0,
    iframe: document.querySelector('#player_iframe')?.src || null,
  }));
  console.log(`\n2. PÁGINA PRINCIPAL:`);
  console.log(`   url: ${info.url}`);
  console.log(`   title: ${info.title}`);
  console.log(`   bodyLen: ${info.bodyLen}`);
  console.log(`   player_iframe src: ${info.iframe ? info.iframe.substring(0,80)+'...' : '(NÃO ENCONTRADO)'}`);
  console.log(`   pedidos totais: ${reqCount}`);
  console.log(`   domínios: ${Object.keys(domains).join(', ')}`);

  console.log('\n3. FRAMES:');
  for (const f of page.frames()) console.log(`   - ${f.url().substring(0, 90)}`);

  console.log('\n4. A clicar play (#pl_but)...');
  for (const frame of page.frames()) {
    try { const b = await frame.$('#pl_but'); if (b) { await b.click().catch(()=>{}); console.log(`   ✓ ${frame.url().substring(0,55)}`);} } catch(_){}
  }

  console.log('\n5. À espera do m3u8 (30s)...');
  for (let i = 0; i < 30; i++) {
    if (m3u8Urls.size > 0) break;
    await sleep(1000);
    if (i % 6 === 0) for (const frame of page.frames()) {
      try { const b = await frame.$('#pl_but'); if (b) await b.click().catch(()=>{}); } catch(_){}
    }
  }

  console.log('\n6. FRAMES finais:');
  for (const f of page.frames()) console.log(`   - ${f.url().substring(0, 90)}`);

  console.log('\n=== PEDIDOS RELEVANTES ===');
  if (!interesting.length) console.log('   (nenhum)');
  interesting.slice(0, 40).forEach(l => console.log('   ' + l));

  console.log('\n=== RESULTADO ===');
  if (m3u8Urls.size > 0) {
    console.log(`✓ SUCESSO!`);
    for (const u of m3u8Urls) console.log(`   ${u}`);
  } else {
    console.log(`✗ Sem m3u8.`);
  }

  await browser.close();
})().catch(e => console.error('ERRO:', e.message));
