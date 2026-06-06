'use strict';
// Testa cada provider do PROVIDERS list individualmente.
// Corre: xvfb-run -a node diag_providers.js
// Ou para um provider específico: xvfb-run -a node diag_providers.js vidsrc.net

const axios = require('axios');
let puppeteer;
try {
  const pe = require('puppeteer-extra');
  pe.use(require('puppeteer-extra-plugin-stealth')());
  puppeteer = pe;
} catch {
  puppeteer = require('puppeteer');
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const HEADLESS = process.env.PPT_HEADLESS === 'false' ? false : 'new';
const TIMEOUT  = parseInt(process.env.PPT_PROVIDER_MS) || 30000;

// Título de teste: Star Wars (1977)
const IMDB = 'tt0076759';
const TYPE = 'movie';

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
    name: 'vidsrc.to',
    mode: 'direct',
    embed: (id, t, s, e) => t === 'series'
      ? `https://vidsrc.to/embed/tv/${id}/${s}/${e}`
      : `https://vidsrc.to/embed/movie/${id}`,
  },
  {
    name: '2embed',
    mode: 'direct',
    embed: (id, t, s, e) => t === 'series'
      ? `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${e}`
      : `https://www.2embed.cc/embed/${id}`,
  },
  {
    name: 'embed.su',
    mode: 'direct',
    embed: (id, t, s, e) => t === 'series'
      ? `https://embed.su/embed/tv/${id}/${s}/${e}`
      : `https://embed.su/embed/movie/${id}`,
  },
  {
    name: 'vidlink.pro',
    mode: 'direct',
    embed: (id, t, s, e) => t === 'series'
      ? `https://vidlink.pro/tv/${id}/${s}/${e}`
      : `https://vidlink.pro/movie/${id}`,
  },
  {
    name: 'autoembed.cc',
    mode: 'direct',
    embed: (id, t, s, e) => t === 'series'
      ? `https://autoembed.cc/tv/imdb/${id}-${s}-${e}`
      : `https://autoembed.cc/movie/imdb/${id}`,
  },
  {
    name: 'multiembed.mov',
    mode: 'direct',
    embed: (id, t, s, e) => t === 'series'
      ? `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${s}&e=${e}`
      : `https://multiembed.mov/?video_id=${id}&tmdb=1`,
  },
  {
    name: 'smashystream',
    mode: 'direct',
    embed: (id, t, s, e) => t === 'series'
      ? `https://player.smashy.stream/tv/${id}?s=${s}&e=${e}`
      : `https://player.smashy.stream/movie/${id}`,
  },
];

const AD_RE = /(histats|\.cfd\/|unwrapsstow|specefeaster|popunder|doubleclick|googlesyndication|adservice|propeller|onclick|popcash|popads)/i;

async function testProvider(browser, provider) {
  const embedUrl = provider.embed(IMDB, TYPE, null, null);
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[${provider.name}] mode=${provider.mode} url=${embedUrl}`);

  const page = await browser.newPage();
  let result = null;

  try {
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 720 });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });

    let cleanHtml = null;
    let embedPrefix = null;

    if (provider.mode === 'extract') {
      const res = await axios.get(embedUrl, {
        headers: { 'User-Agent': UA }, timeout: 12000, validateStatus: () => true,
      });
      const body = typeof res.data === 'string' ? res.data : '';
      const m = body.match(/id="player_iframe"[^>]+src="([^"]+)"/)
             || body.match(/<iframe[^>]+src="([^"]+)"[^>]*allowfullscreen/i);
      if (!m) { console.log(`[${provider.name}] ✗ iframe não encontrado`); return null; }
      let rcpUrl = m[1];
      if (rcpUrl.startsWith('//')) rcpUrl = 'https:' + rcpUrl;
      console.log(`[${provider.name}] iframe → ${rcpUrl.substring(0, 80)}`);
      cleanHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0">
        <iframe src="${rcpUrl}" allow="autoplay; fullscreen; encrypted-media"
          style="width:1280px;height:720px;border:0"></iframe></body></html>`;
      embedPrefix = embedUrl.split('?')[0];
    }

    let captured = null;
    const requests = [];

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
          console.log(`[${provider.name}] ✓ M3U8: ${url.substring(0, 100)}`);
        }
        if (AD_RE.test(url)) return req.abort();
        // Log de domínios relevantes
        try {
          const host = new URL(url).hostname;
          if (!requests.includes(host)) { requests.push(host); console.log(`  → ${host}`); }
        } catch {}
        req.continue();
      } catch (_) { try { req.continue(); } catch (__) {} }
    });

    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    const deadline = Date.now() + TIMEOUT;
    const selectors = ['#pl_but', '.fa-play', '.play-button', '.jw-icon-display', '#player', 'video', 'button'];
    while (!captured && Date.now() < deadline) {
      for (const frame of page.frames()) {
        for (const sel of selectors) {
          try { const el = await frame.$(sel); if (el) await el.click().catch(() => {}); } catch (_) {}
        }
      }
      await new Promise(r => setTimeout(r, 1500));
    }

    if (captured) {
      result = { url: captured };
      console.log(`[${provider.name}] ✅ SUCESSO`);
    } else {
      console.log(`[${provider.name}] ✗ Sem m3u8 em ${TIMEOUT / 1000}s`);
    }
  } catch (e) {
    console.log(`[${provider.name}] ✗ Erro: ${e.message}`);
  } finally {
    try { await page.close(); } catch (_) {}
  }

  return result;
}

async function main() {
  const filter = process.argv[2]; // provider específico opcional
  const toTest = filter ? PROVIDERS.filter(p => p.name === filter) : PROVIDERS;

  if (toTest.length === 0) {
    console.log(`Provider "${filter}" não encontrado. Disponíveis: ${PROVIDERS.map(p => p.name).join(', ')}`);
    process.exit(1);
  }

  console.log(`\nA testar ${toTest.length} provider(s) para ${IMDB} (headless=${HEADLESS}, timeout=${TIMEOUT / 1000}s)\n`);

  const args = [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--mute-audio', '--window-size=1280,720',
  ];
  if (HEADLESS) args.push('--disable-gpu');

  const browser = await puppeteer.launch({ headless: HEADLESS, args });

  const results = [];
  for (const provider of toTest) {
    const r = await testProvider(browser, provider);
    results.push({ name: provider.name, ok: !!r });
  }

  await browser.close();

  console.log(`\n${'═'.repeat(60)}`);
  console.log('RESULTADOS:');
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '✗ '} ${r.name}`);
  }
  console.log('');
}

main().catch(e => { console.error('Erro fatal:', e.message); process.exit(1); });
