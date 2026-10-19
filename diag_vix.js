'use strict';
// Diagnóstico da VixSrc: de onde vêm os hosts dos segmentos e se resolvem.
// Uso: node diag_vix.js [tmdbId]   (por defeito 11 = Star Wars)
const axios = require('axios');
const dns = require('dns').promises;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const BASE = 'https://vixsrc.to';
const id = process.argv[2] || '11';
const get = (url, ref, extra = {}) => axios.get(url, {
  headers: { 'User-Agent': UA, ...(ref ? { Referer: ref, Origin: new URL(ref).origin } : {}), ...extra },
  timeout: 20000, responseType: 'text', validateStatus: () => true,
});
const resolve = async h => { try { return (await dns.lookup(h)).address; } catch (e) { return 'NÃO RESOLVE (' + e.code + ')'; } };

(async () => {
  const api = await get(`${BASE}/api/movie/${id}`, BASE + '/', { Accept: 'application/json' });
  console.log('API', api.status, String(api.data).slice(0, 200));
  const src = JSON.parse(api.data).src;
  const embedUrl = BASE + src;
  const emb = await get(embedUrl, BASE + '/', { Accept: 'text/html' });
  const html = String(emb.data);
  console.log('embed', emb.status, html.length, 'bytes');

  const token = html.match(/token["']\s*:\s*["']([^"']+)/)?.[1];
  const expires = html.match(/expires["']\s*:\s*["']([^"']+)/)?.[1];
  const playlist = html.match(/url\s*:\s*["']([^"']+)/)?.[1];
  console.log('playlist', playlist, '· token', !!token, '· expires', expires);
  console.log('variáveis window.*:', [...new Set(html.match(/window\.[A-Za-z_]+\s*=/g) || [])].join(' '));
  const hosts = [...new Set(html.match(/[a-z0-9-]+(\.[a-z0-9-]+)+\.(boats|com|net|org|cc|to|xyz|top|site|online|live)\b/g) || [])];
  console.log('hosts no embed:', hosts.join(' '));

  const sep = playlist.includes('?') ? '&' : '?';
  for (const extra of ['&h=1&lang=en', '&h=1', '&lang=en', '']) {
    const master = `${playlist}${sep}token=${token}&expires=${expires}${extra}`;
    for (const ref of [embedUrl, BASE + '/', `${BASE}/api/movie/${id}`]) {
      const m = await get(master, ref);
      const variant = String(m.data).split('\n').find(l => /^https?:/.test(l.trim()));
      if (!variant) { console.log(`[${extra || 'sem params'}] ref=${ref.slice(0, 35)} master HTTP ${m.status}, sem variante: ${String(m.data).slice(0, 80).replace(/\n/g, ' ')}`); continue; }
      const v = await get(variant.trim(), ref);
      const seg = String(v.data).split('\n').find(l => /^https?:/.test(l.trim()));
      const host = seg ? new URL(seg.trim()).host : '(sem segmentos, HTTP ' + v.status + ')';
      const res = seg ? await resolve(host) : '';
      let segStatus = '';
      if (seg && !res.startsWith('NÃO')) { const s = await get(seg.trim(), ref, { Range: 'bytes=0-1023' }); segStatus = `segmento HTTP ${s.status}`; }
      console.log(`[${extra || 'sem params'}] ref=${ref.slice(0, 35).padEnd(35)} → ${host} · ${res} ${segStatus}`);
    }
  }
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
