'use strict';
// O browser toca o Vidlink por DASH (surge…/sacdn/dash/…), não pelos .mp4.
// Este diagnóstico procura de onde vem o DASH na API e se o proxy o serve
// sem os cabeçalhos do browser (o Stremio não os manda).
const axios = require('axios');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const REF = 'https://vidlink.pro';
const [tmdb = '1421', se = '9', ep = '13'] = process.argv.slice(2);
const H = { 'User-Agent': UA, Referer: REF + '/', Origin: REF };
const resumo = st => st ? JSON.stringify({
  deliveryType: st.deliveryType, type: st.type, playlist: st.playlist && st.playlist.slice(0, 90),
  playlistHeaders: st.playlistHeaders && Object.keys(st.playlistHeaders), requiresProxy: st.requiresProxy,
  qualities: st.qualities && Object.keys(st.qualities),
  alternates: st.alternates && Object.fromEntries(Object.entries(st.alternates).map(([k, v]) => [k, { type: v.type, requiresProxy: v.requiresProxy, headers: v.headers && Object.keys(v.headers), playlist: v.playlist && v.playlist.slice(0, 80) }])),
}) : 'null';
(async () => {
  const enc = (await axios.get(`https://enc-dec.app/api/enc-vidlink?text=${tmdb}`, { timeout: 10000 })).data.result;
  let dash = null;
  for (const qs of ['multiLang=0', 'multiLang=1', '', 'multiLang=0&dash=1', 'multiLang=1&dash=1']) {
    const url = `${REF}/api/b/tv/${enc}/${se}/${ep}${qs ? '?' + qs : ''}`;
    const r = await axios.get(url, { headers: H, timeout: 20000, validateStatus: () => true }).catch(e => ({ status: 'ERRO ' + e.code }));
    const st = r.data && r.data.stream;
    console.log(`\n[${qs || 'sem params'}] HTTP ${r.status} · sourceId=${r.data && r.data.sourceId}\n  ${resumo(st)}`);
    if (!dash && st) {
      if (st.deliveryType === 'dash' && st.playlist) dash = { url: st.playlist, headers: st.playlistHeaders || {} };
      for (const v of Object.values(st.alternates || {})) if (!dash && v.type === 'dash' && v.playlist) dash = { url: v.playlist, headers: v.headers || {} };
    }
  }
  if (!dash) return console.log('\nnenhum DASH na API com estes parâmetros');

  // Réplica da função v() do leitor: {base}/sacdn{path}?{query}&host={origin}&sc={base64url(cookie)}
  const u = new URL(dash.url);
  const cookie = Object.entries(dash.headers).find(([k]) => k.toLowerCase() === 'cookie');
  const sc = cookie ? Buffer.from(cookie[1]).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : '';
  const q = [u.search.slice(1), `host=${encodeURIComponent(u.origin)}`, `sc=${encodeURIComponent(sc)}`].filter(Boolean).join('&');
  const mpd = `https://surge.flooderrr.store/sacdn${u.pathname}?${q}`;
  console.log('\nDASH original:', dash.url.slice(0, 100), '· cookie:', !!cookie);
  console.log('MPD via proxy:', mpd.slice(0, 140));
  for (const [nome, h] of [['com Referer/Origin vidlink', H], ['sem Referer (como o Stremio)', { 'User-Agent': UA }]]) {
    const r = await axios.get(mpd, { headers: h, timeout: 20000, responseType: 'text', validateStatus: () => true }).catch(e => ({ status: 'ERRO ' + e.code, data: '' }));
    const body = String(r.data || '');
    console.log(`\nMPD ${nome}: HTTP ${r.status} · ${body.length} bytes`);
    console.log(body.slice(0, 900));
    const seg = body.match(/(?:initialization|media)="([^"]+)"/);
    if (seg) console.log('→ 1.º template de segmento:', seg[1].slice(0, 160));
  }
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
