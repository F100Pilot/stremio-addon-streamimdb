'use strict';
// Porque é que a CDN do Vidlink (bcdn.hakunaymatata.com) responde 429?
// Pede um URL fresco ao Vidlink e tenta 64 KB do ficheiro com vários
// conjuntos de cabeçalhos, espaçados 3s para não sermos nós a causar o 429.
// Uso: node diag_vidlink_cdn.js [tmdbId] [season] [episode]   (por defeito: Modern Family 9x13)
const axios = require('axios');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const [tmdb = '1421', se = '9', ep = '13'] = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const enc = (await axios.get(`https://enc-dec.app/api/enc-vidlink?text=${tmdb}`, { timeout: 10000 })).data.result;
  const api = await axios.get(`https://vidlink.pro/api/b/tv/${enc}/${se}/${ep}?multiLang=0`, {
    headers: { 'User-Agent': UA, Referer: 'https://vidlink.pro/' }, timeout: 15000, validateStatus: () => true });
  const q = api.data?.stream?.qualities || {};
  console.log('API', api.status, '· qualidades:', Object.keys(q).join('/'));
  const first = Object.values(q).find(v => v && v.url);
  if (!first) { console.log(JSON.stringify(api.data).slice(0, 400)); return; }
  console.log('campos da qualidade:', JSON.stringify({ ...first, url: first.url.slice(0, 60) + '…' }));
  console.log('campos do stream   :', Object.keys(api.data.stream).join(', '), '· raiz:', Object.keys(api.data).join(', '));
  const url = (q['360'] || first).url;   // a mais leve
  const combos = [
    ['referer vidlink.pro', { Referer: 'https://vidlink.pro/', Origin: 'https://vidlink.pro' }],
    ['sem referer', {}],
    ['referer fmoviesunblocked', { Referer: 'https://fmoviesunblocked.net/', Origin: 'https://fmoviesunblocked.net' }],
    ['referer moviebox', { Referer: 'https://moviebox.ng/', Origin: 'https://moviebox.ng' }],
    ['headers do próprio item', first.headers || {}],
  ];
  for (const [nome, h] of combos) {
    const r = await axios.get(url, { headers: { 'User-Agent': UA, Range: 'bytes=0-65535', ...h }, timeout: 20000,
      responseType: 'arraybuffer', validateStatus: () => true, maxRedirects: 5 }).catch(e => ({ status: 'ERRO ' + e.code }));
    const hd = r.headers || {};
    console.log(`${nome.padEnd(26)} → HTTP ${r.status} · ${r.data ? r.data.byteLength : 0} bytes` +
      (hd['retry-after'] ? ` · retry-after=${hd['retry-after']}` : '') +
      (r.status >= 400 && r.data ? ` · corpo: ${Buffer.from(r.data).toString().slice(0, 120).replace(/\s+/g, ' ')}` : ''));
    await sleep(3000);
  }
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
