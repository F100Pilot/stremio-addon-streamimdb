'use strict';
// Teste diagnóstico: mapeia frames, rede e Turnstile
// Uso: node test_puppeteer.js [tt0076759] [--headful]
const puppeteer = require('puppeteer');

const imdbId = process.argv.find(a => a.startsWith('tt')) || 'tt0076759';
const headful = process.argv.includes('--headful');
const embedUrl = `https://streamimdb.me/embed/${imdbId}/`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`\n=== Teste Puppeteer DIAGNÓSTICO ===`);
  console.log(`IMDb: ${imdbId} | headless: ${!headful}\n`);

  const browser = await puppeteer.launch({
    headless: headful ? false : 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled', '--window-size=1280,720',
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1280, height: 720 });

  const m3u8Urls = new Set();
  const interesting = [];

  page.on('request', req => {
    const url = req.url();
    if (url.includes('.m3u8')) {
      m3u8Urls.add(url);
      console.log(`  >>> M3U8: ${url}`);
      console.log(`      Referer: ${req.headers().referer || '(nenhum)'}`);
    }
    // regista pedidos relevantes (não estáticos)
    if (/(prorcp|rcp_verify|turnstile|challenges\.cloudflare|\.mp4|master|playlist|\/api)/i.test(url)) {
      interesting.push(`REQ ${req.method()} ${url.substring(0, 110)}`);
    }
  });
  page.on('response', resp => {
    const url = resp.url();
    if (/rcp_verify/i.test(url)) {
      interesting.push(`RESP ${resp.status()} ${url.substring(0,90)}`);
    }
  });

  console.log('1. A carregar embed...');
  await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(5000);

  console.log('\n2. FRAMES após 5s:');
  for (const f of page.frames()) console.log(`   - ${f.url().substring(0, 100)}`);

  // Clica no botão play dentro da frame rcp usando click real
  console.log('\n3. A clicar no play (#pl_but) em cada frame...');
  for (const frame of page.frames()) {
    try {
      const btn = await frame.$('#pl_but');
      if (btn) {
        await btn.click().catch(() => {});
        console.log(`   ✓ clicado #pl_but em ${frame.url().substring(0,60)}`);
      }
    } catch (_) {}
  }

  await sleep(6000);

  console.log('\n4. FRAMES após clicar play:');
  for (const f of page.frames()) console.log(`   - ${f.url().substring(0, 100)}`);

  // Verifica Turnstile em cada frame
  console.log('\n5. Estado do Turnstile:');
  for (const frame of page.frames()) {
    try {
      const info = await frame.evaluate(() => {
        const ts = document.querySelector('.cf-turnstile');
        const input = document.querySelector('input[name="cf-turnstile-response"]');
        return {
          hasTurnstile: !!ts,
          token: input ? (input.value ? input.value.substring(0,20)+'...' : '(vazio)') : null,
          bodyLen: document.body ? document.body.innerHTML.length : 0,
        };
      });
      if (info.hasTurnstile || info.token) {
        console.log(`   frame ${frame.url().substring(0,60)}: turnstile=${info.hasTurnstile} token=${info.token}`);
      }
    } catch (_) {}
  }

  console.log('\n6. À espera do m3u8 (mais 25s, a clicar periodicamente)...');
  for (let i = 0; i < 25; i++) {
    if (m3u8Urls.size > 0) break;
    await sleep(1000);
    if (i % 5 === 0) {
      for (const frame of page.frames()) {
        try { const b = await frame.$('#pl_but'); if (b) await b.click().catch(()=>{}); } catch(_){}
        try { const v = await frame.$('video'); if (v) await v.click().catch(()=>{}); } catch(_){}
      }
    }
  }

  console.log('\n=== PEDIDOS RELEVANTES VISTOS ===');
  if (interesting.length === 0) console.log('   (nenhum — não chegámos ao prorcp/turnstile)');
  interesting.slice(0, 40).forEach(l => console.log('   ' + l));

  console.log('\n=== RESULTADO ===');
  if (m3u8Urls.size > 0) {
    console.log(`✓ SUCESSO! m3u8 capturado:`);
    for (const u of m3u8Urls) console.log(`   ${u}`);
  } else {
    console.log(`✗ Nenhum m3u8 capturado.`);
  }

  if (!headful) await browser.close();
  else console.log('\n(browser aberto — Ctrl+C para fechar)');
})().catch(e => console.error('ERRO:', e.message));
