'use strict';
// Segue a cadeia completa do vidsrc (família .pm/.in/.net/.xyz) passo a passo,
// imprimindo o que encontra em cada etapa. A cadeia típica é:
//
//   embed → iframe cloudnestra.com/rcp/... → /prorcp/... → .m3u8
//
// É o mesmo padrão do antigo streamimdb.me, que exigia Puppeteer por causa do
// Cloudflare Turnstile no passo /prorcp. O objectivo aqui é ver exactamente
// onde (e se) a cadeia parte hoje, usando só axios.
//
// Uso: node diag_vidsrc.js [host] [imdbId] [season] [episode]
//      node diag_vidsrc.js vidsrc.pm tt4655480 1 1
require('dotenv').config();
const axios = require('axios');

const [, , HOST = 'vidsrc.pm', IMDB = 'tt4655480', S = '1', E = '1'] = process.argv;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

function get(url, referer) {
  return axios.get(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(referer ? { Referer: referer, Origin: new URL(referer).origin } : {}),
    },
    timeout: 15000, maxRedirects: 5, validateStatus: () => true,
    responseType: 'text', transformResponse: x => x,
  });
}

const abs = (u, base) => {
  if (!u) return null;
  if (u.startsWith('//')) return 'https:' + u;
  try { return new URL(u, base).href; } catch { return u; }
};

const isCf = b => /Just a moment|challenge-platform|cf-browser-verification|turnstile/i.test(b || '');

function report(label, res) {
  const b = typeof res.data === 'string' ? res.data : '';
  console.log(`  status ${res.status} · ${b.length}b${isCf(b) ? '  ⚠ CLOUDFLARE/TURNSTILE' : ''}`);
  return b;
}

(async () => {
  const embedUrl = `https://${HOST}/embed/tv/${IMDB}/${S}-${E}`;
  console.log(`\n[1] embed: ${embedUrl}`);
  const r1 = await get(embedUrl);
  const b1 = report('embed', r1);
  if (!b1) return;

  // iframes na página do embed
  const iframes = [...b1.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map(m => abs(m[1], embedUrl));
  console.log(`  iframes: ${iframes.length ? iframes.join('\n           ') : '(nenhum)'}`);

  // o m3u8 pode até já estar aqui
  const direct = b1.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/);
  if (direct) console.log(`  ★ m3u8 já no embed: ${direct[0]}`);

  const rcp = iframes.find(u => /cloudnestra|rcp|player/i.test(u)) || iframes[0];
  if (!rcp) { console.log('\nSem iframe para seguir — fim.'); return; }

  console.log(`\n[2] rcp: ${rcp}`);
  const r2 = await get(rcp, embedUrl);
  const b2 = report('rcp', r2);
  if (!b2) return;

  const m2 = b2.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/);
  if (m2) { console.log(`  ★ m3u8: ${m2[0]}`); return; }

  // o passo seguinte costuma vir num src: '/prorcp/...' dentro de JS
  const pro = b2.match(/src\s*:\s*['"]([^'"]*prorcp[^'"]*)['"]/i)
           || b2.match(/['"]([^'"]*\/prorcp\/[^'"]+)['"]/i);
  const proUrl = pro ? abs(pro[1], rcp) : null;
  console.log(`  prorcp: ${proUrl || '(não encontrado)'}`);
  if (!proUrl) {
    console.log('\n  --- amostra do corpo (1200 chars) ---');
    console.log(b2.substring(0, 1200));
    return;
  }

  console.log(`\n[3] prorcp: ${proUrl}`);
  const r3 = await get(proUrl, rcp);
  const b3 = report('prorcp', r3);
  if (!b3) return;

  const m3 = b3.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/)
          || b3.match(/file\s*:\s*["']([^"']+)["']/i);
  if (m3) {
    console.log(`  ★ m3u8: ${m3[1] || m3[0]}`);
  } else {
    console.log('\n  --- amostra do corpo (1200 chars) ---');
    console.log(b3.substring(0, 1200));
  }
})();
