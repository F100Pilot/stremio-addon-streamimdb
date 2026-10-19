'use strict';
// O Vidlink marca os ficheiros com requiresProxy:true — o leitor do site não
// os pede directamente à CDN. Este diagnóstico:
//  1) procura nos scripts do leitor como trata requiresProxy (e que proxy usa);
//  2) volta a testar a CDN com variantes ainda não testadas (User-Agent, sem
//     Range, HEAD), espaçadas 3s.
// Uso: node diag_vidlink_proxy.js [tmdbId] [season] [episode]
const axios = require('axios');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const REF = 'https://vidlink.pro';
const [tmdb = '1421', se = '9', ep = '13'] = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = (u, h = {}, extra = {}) => axios.get(u, { headers: { 'User-Agent': UA, ...h }, timeout: 20000, responseType: 'text', validateStatus: () => true, maxRedirects: 5, ...extra })
  .catch(e => ({ status: 'ERRO ' + (e.code || e.message), data: '', headers: {} }));

(async () => {
  // ── 1) o que o leitor faz com requiresProxy ──────────────────────────────
  const page = await get(`${REF}/tv/${tmdb}/${se}/${ep}`, { Referer: REF + '/' });
  const scripts = [...String(page.data).matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => new URL(m[1], REF).href);
  console.log(`página HTTP ${page.status} · ${scripts.length} scripts`);
  const pistas = new Set();
  for (const s of scripts) {
    const js = String((await get(s, { Referer: REF + '/' })).data || '');
    const nome = s.split('/').pop();
    for (const k of ['requiresProxy', 'proxy?', '/proxy', 'proxyUrl', 'PROXY', 'deliveryType', 'hakunaymatata', 'bcdn', 'mwVault']) {
      let i = js.indexOf(k), n = 0;
      while (i !== -1 && n < 3) {
        pistas.add(`[${nome}] ${k}: …${js.slice(Math.max(0, i - 160), i + 200).replace(/\s+/g, ' ')}…`);
        i = js.indexOf(k, i + k.length); n++;
      }
    }
  }
  console.log('\n=== pistas no leitor (requiresProxy / proxy) ===');
  console.log([...pistas].slice(0, 14).join('\n\n') || '(nenhuma)');

  // ── 2) URL fresco + variantes ainda não testadas ─────────────────────────
  const enc = (await axios.get(`https://enc-dec.app/api/enc-vidlink?text=${tmdb}`, { timeout: 10000 })).data.result;
  const api = await get(`${REF}/api/b/tv/${enc}/${se}/${ep}?multiLang=0`, { Referer: REF + '/' }, { responseType: 'json' });
  const st = api.data && api.data.stream;
  console.log(`\n=== API HTTP ${api.status} · flags=${JSON.stringify(st && st.flags)} · deliveryType=${JSON.stringify(st && st.deliveryType)} · TTL=${st && st.TTL}`);
  const q = (st && st.qualities) || {};
  const url = (q['360'] || Object.values(q)[0] || {}).url;
  if (!url) return console.log('sem URL');
  console.log('URL:', url.slice(0, 120));
  const R = { Referer: REF + '/', Origin: REF };
  const combos = [
    ['HEAD, UA Chrome',                 { ...R }, { method: 'head' }],
    ['GET sem Range, UA Chrome',        { ...R }, { maxContentLength: 2e5, responseType: 'stream' }],
    ['Range, UA okhttp (app Android)',  { ...R, 'User-Agent': 'okhttp/4.12.0' }],
    ['Range, UA ExoPlayer',             { ...R, 'User-Agent': 'ExoPlayerLib/2.19.1' }],
    ['Range, sem User-Agent',           { ...R, 'User-Agent': '' }],
    ['Range, Referer da página',        { Referer: `${REF}/tv/${tmdb}/${se}/${ep}`, Origin: REF }],
  ];
  for (const [nome, h, extra = {}] of combos) {
    const hdr = { Range: 'bytes=0-65535', ...h };
    if (nome.includes('sem Range')) delete hdr.Range;
    const r = await axios.request({ url, method: extra.method || 'get', headers: hdr, timeout: 20000, validateStatus: () => true,
      responseType: extra.responseType || 'arraybuffer', maxRedirects: 5 }).catch(e => ({ status: 'ERRO ' + e.code, headers: {} }));
    let bytes = 0;
    if (r.data && r.data.on) { await new Promise(res => { r.data.on('data', c => { bytes += c.length; if (bytes > 1e5) r.data.destroy(); }); r.data.on('close', res); r.data.on('end', res); r.data.on('error', res); }); }
    else if (r.data) bytes = r.data.byteLength || 0;
    const hd = r.headers || {};
    console.log(`${nome.padEnd(32)} → HTTP ${r.status} · ${bytes} bytes` + (hd['content-length'] ? ` · content-length=${hd['content-length']}` : '') + (hd['server'] ? ` · server=${hd['server']}` : ''));
    await sleep(3000);
  }
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
