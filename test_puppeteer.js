'use strict';
// Teste: confirma se o Turnstile auto-resolve e captura o .m3u8
// Uso: node test_puppeteer.js [tt0076759] [--headful]
const puppeteer = require('puppeteer');

const imdbId = process.argv.find(a => a.startsWith('tt')) || 'tt0076759';
const headful = process.argv.includes('--headful');
const embedUrl = `https://streamimdb.me/embed/${imdbId}/`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

(async () => {
  console.log(`\n=== Teste Puppeteer ===`);
  console.log(`IMDb: ${imdbId} | URL: ${embedUrl} | headless: ${!headful}\n`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: headful ? false : 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,720',
      ],
    });
  } catch (e) {
    console.error('FALHA ao lançar browser:', e.message);
    console.error('\nProvavelmente falta o Chromium. No servidor corre:');
    console.error('  npx puppeteer browsers install chrome');
    console.error('  (ou instala dependências: apt install -y chromium libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2)');
    return;
  }

  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1280, height: 720 });

  const m3u8Urls = new Set();
  const allMedia = [];

  page.on('request', req => {
    const url = req.url();
    if (url.includes('.m3u8')) {
      m3u8Urls.add(url);
      console.log(`  >>> M3U8 CAPTURADO: ${url}`);
      console.log(`      Referer: ${req.headers().referer || '(nenhum)'}`);
    }
    if (/\.(mp4|ts)(\?|$)/.test(url)) allMedia.push(url);
  });

  // captura também via response (alguns players carregam via fetch)
  page.on('response', resp => {
    const url = resp.url();
    if (url.includes('.m3u8') && !m3u8Urls.has(url)) {
      m3u8Urls.add(url);
      console.log(`  >>> M3U8 (response): ${url}`);
    }
  });

  try {
    console.log('1. A carregar embed page...');
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    console.log('2. À espera de Turnstile / player (8s)...');
    await new Promise(r => setTimeout(r, 8000));

    // Tenta clicar no botão de play em todas as frames
    console.log('3. A procurar e clicar no botão de play...');
    for (const frame of page.frames()) {
      try {
        await frame.evaluate(() => {
          const sels = ['#pl_but', '.fa-play', '#player', '.play-button', 'video', '#the_frame'];
          for (const s of sels) {
            const el = document.querySelector(s);
            if (el) { el.click(); }
          }
          document.body && document.body.click();
        });
      } catch (_) {}
    }

    console.log('4. À espera do m3u8 (até 20s)...');
    for (let i = 0; i < 20; i++) {
      if (m3u8Urls.size > 0) break;
      await new Promise(r => setTimeout(r, 1000));
      // re-tenta clicar
      if (i === 5 || i === 10) {
        for (const frame of page.frames()) {
          try { await frame.evaluate(() => { const b=document.querySelector('#pl_but'); b&&b.click(); }); } catch(_){}
        }
      }
    }

    console.log(`\n=== RESULTADO ===`);
    if (m3u8Urls.size > 0) {
      console.log(`✓ SUCESSO! ${m3u8Urls.size} m3u8 capturado(s):`);
      for (const u of m3u8Urls) console.log(`   ${u}`);
      console.log(`\n>>> O Turnstile auto-resolveu no teu IP. Podemos construir o resolver completo.`);
    } else {
      console.log(`✗ Nenhum m3u8 capturado.`);
      console.log(`   Media (mp4/ts) vista: ${allMedia.length}`);
      if (allMedia.length) allMedia.slice(0,5).forEach(u => console.log(`   ${u}`));
      console.log(`\n   Possíveis causas: Turnstile não passou, ou player precisa de mais interação.`);
      console.log(`   Tenta com --headful para ver o browser: node test_puppeteer.js ${imdbId} --headful`);
    }

  } catch (e) {
    console.error('ERRO durante teste:', e.message);
  } finally {
    if (!headful) await browser.close();
    else console.log('\n(browser deixado aberto — fecha manualmente com Ctrl+C)');
  }
})();
