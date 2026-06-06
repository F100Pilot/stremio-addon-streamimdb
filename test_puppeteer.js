'use strict';
// Estratégia: axios extrai rcp URL → Puppeteer carrega rcp directo (sem ads do embed)
// Uso: node test_puppeteer.js [tt0076759]
const puppeteer = require('puppeteer');
const axios = require('axios');

const imdbId = process.argv.find(a => a.startsWith('tt')) || 'tt0076759';
const embedUrl = `https://streamimdb.me/embed/${imdbId}/`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`\n=== Teste: rcp directo no Puppeteer ===`);
  console.log(`IMDb: ${imdbId}\n`);

  // 1. axios extrai o rcp URL (não detetado)
  console.log('1. axios → embed → extrair rcp URL...');
  const embed = await axios.get(embedUrl, { headers: { 'User-Agent': UA }, validateStatus: () => true });
  const m = String(embed.data).match(/id="player_iframe"[^>]+src="([^"]+)"/);
  if (!m) { console.log('   ✗ iframe rcp não encontrado'); return; }
  let rcpUrl = m[1];
  if (rcpUrl.startsWith('//')) rcpUrl = 'https:' + rcpUrl;
  console.log(`   ✓ rcp: ${rcpUrl.substring(0, 80)}...`);
  const rcpOrigin = new URL(rcpUrl).origin;

  // 2. Puppeteer carrega o rcp directamente
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled', '--window-size=1280,720'],
  });
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });
  // Referer streamimdb.me — o CDN espera isto
  await page.setExtraHTTPHeaders({ 'Referer': embedUrl });

  const m3u8Urls = new Set();
  const interesting = [];
  page.on('request', req => {
    const url = req.url();
    if (url.includes('.m3u8')) {
      m3u8Urls.add(url);
      console.log(`  >>> M3U8: ${url}`);
      console.log(`      Referer: ${req.headers().referer || '(nenhum)'}`);
    }
    if (/(prorcp|rcp_verify|turnstile|challenges\.cloudflare|\.mp4|master|playlist|tmstr|shadowlands)/i.test(url))
      interesting.push(`${req.method()} ${url.substring(0, 110)}`);
  });
  page.on('response', resp => {
    if (/rcp_verify/i.test(resp.url())) interesting.push(`RESP ${resp.status()} rcp_verify`);
  });

  console.log('\n2. Puppeteer → carregar rcp directo...');
  try { await page.goto(rcpUrl, { waitUntil: 'networkidle2', timeout: 35000 }); }
  catch (e) { console.log('   goto:', e.message); }
  await sleep(2000);

  const info = await page.evaluate(() => ({
    url: location.href, title: document.title,
    bodyLen: document.body ? document.body.innerHTML.length : 0,
    hasPlay: !!document.querySelector('#pl_but'),
    hasTurnstile: !!document.querySelector('.cf-turnstile'),
  }));
  console.log(`   url: ${info.url.substring(0,70)}`);
  console.log(`   bodyLen: ${info.bodyLen} | botão play: ${info.hasPlay} | turnstile: ${info.hasTurnstile}`);

  console.log('\n3. Clicar play...');
  for (const frame of page.frames()) {
    try { const b = await frame.$('#pl_but'); if (b) { await b.click().catch(()=>{}); console.log('   ✓ clicado'); } } catch(_){}
  }
  await sleep(4000);

  console.log('\n4. Estado após play:');
  for (const frame of page.frames()) {
    try {
      const s = await frame.evaluate(() => ({
        ts: !!document.querySelector('.cf-turnstile'),
        tok: document.querySelector('input[name="cf-turnstile-response"]')?.value ? 'TEM-TOKEN' : 'sem-token',
      }));
      if (s.ts) console.log(`   ${frame.url().substring(0,55)}: turnstile, ${s.tok}`);
    } catch(_){}
  }

  console.log('\n5. À espera do m3u8 (30s)...');
  for (let i = 0; i < 30; i++) {
    if (m3u8Urls.size > 0) break;
    await sleep(1000);
    if (i % 6 === 0) for (const frame of page.frames()) {
      try { const b = await frame.$('#pl_but'); if (b) await b.click().catch(()=>{}); } catch(_){}
    }
  }

  console.log('\n=== PEDIDOS RELEVANTES ===');
  if (!interesting.length) console.log('   (nenhum)');
  [...new Set(interesting)].slice(0, 40).forEach(l => console.log('   ' + l));

  console.log('\n=== RESULTADO ===');
  if (m3u8Urls.size > 0) { console.log('✓ SUCESSO!'); for (const u of m3u8Urls) console.log('   ' + u); }
  else console.log('✗ Sem m3u8.');

  await browser.close();
})().catch(e => console.error('ERRO:', e.message));
