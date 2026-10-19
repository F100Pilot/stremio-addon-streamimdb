'use strict';
// Diagnóstico do Vidlink: o que respondem o codificador (enc-dec.app) e a API,
// e que endpoints/hosts a página do player usa agora.
const axios = require('axios');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const REF = 'https://vidlink.pro', id = process.argv[2] || '11';
const get = (u, h = {}) => axios.get(u, { headers: { 'User-Agent': UA, Referer: REF + '/', ...h }, timeout: 15000, responseType: 'text', validateStatus: () => true, maxRedirects: 5 })
  .then(r => ({ status: r.status, data: String(r.data), url: r.request?.res?.responseUrl })).catch(e => ({ status: 'ERRO', data: e.message }));
const show = (t, r) => console.log(`\n== ${t}\nHTTP ${r.status}${r.url ? ' → ' + r.url : ''}\n${r.data.slice(0, 400).replace(/\s+/g, ' ')}`);
(async () => {
  const enc = await get(`https://enc-dec.app/api/enc-vidlink?text=${id}`); show('enc-dec.app', enc);
  let encoded = null; try { encoded = JSON.parse(enc.data).result; } catch {}
  console.log('encoded:', encoded);
  if (encoded) show('API /api/b/movie/<enc>', await get(`${REF}/api/b/movie/${encodeURIComponent(encoded)}?multiLang=0`));
  show('API /api/b/movie/11 (id em claro)', await get(`${REF}/api/b/movie/${id}?multiLang=0`));
  const page = await get(`${REF}/movie/${id}`); show('página /movie/11', page);
  const scripts = [...page.data.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => new URL(m[1], REF).href);
  console.log('\nscripts:', scripts.length, scripts.slice(0, 8).join('\n  '));
  const found = new Set();
  for (const s of scripts.slice(0, 12)) {
    const js = await get(s); if (typeof js.data !== 'string') continue;
    for (const m of js.data.matchAll(/["'`](\/api\/[a-zA-Z0-9_\/\-$\{\}]+|https?:\/\/[a-z0-9.-]+\.[a-z]{2,}\/api\/[^"'`\s]{0,40})/g)) found.add(m[1]);
    for (const m of js.data.matchAll(/enc-dec|encrypt|decrypt|CryptoJS|AES/g)) { found.add(`[${s.split('/').pop()}] usa ${m[0]}`); }
  }
  console.log('\nendpoints/pistas nos scripts:\n  ' + [...found].slice(0, 40).join('\n  '));
})();
