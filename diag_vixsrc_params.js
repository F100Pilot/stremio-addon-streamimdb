'use strict';
// A VixSrc só dá 720p — é mesmo o tecto dela, ou somos nós a pedir mal?
//
// O URL do master leva parâmetros que herdámos sem saber o que fazem (`h=1`,
// e às vezes um `b=1` que vem da própria página). Se algum deles for um
// selector de qualidade, estamos a limitar-nos sem precisar de mudar de fonte.
// Este script pede o mesmo master com várias combinações e compara as
// variantes que cada uma devolve.
//
// Uso: node diag_vixsrc_params.js [tmdbId]
//      node diag_vixsrc_params.js 11        (Star Wars)
//      node diag_vixsrc_params.js 62650 1 1 (série: tmdb, temporada, episódio)
require('dotenv').config();
const axios = require('axios');

const [, , TMDB = '11', SEASON = null, EPISODE = null] = process.argv;

const VIX = 'https://vixsrc.to';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, Referer: VIX, Origin: VIX };

// Combinações a testar. A primeira é a que o addon usa hoje.
const COMBOS = [
  { nome: 'actual (h=1&lang=en)', extra: 'h=1&lang=en' },
  { nome: 'sem h, com lang',      extra: 'lang=en' },
  { nome: 'sem nada',             extra: '' },
  { nome: 'h=0',                  extra: 'h=0&lang=en' },
  { nome: 'b=1',                  extra: 'b=1&lang=en' },
  { nome: 'h=1&b=1',              extra: 'h=1&b=1&lang=en' },
];

function variantes(m3u8) {
  const out = [];
  for (const line of m3u8.split('\n')) {
    const t = line.trim();
    if (!/^#EXT-X-STREAM-INF/i.test(t)) continue;
    const r = t.match(/RESOLUTION=(\d+)x(\d+)/i);
    const b = parseInt(t.match(/[^-]BANDWIDTH=(\d+)/i)?.[1] || 0, 10);
    out.push({ h: r ? parseInt(r[2], 10) : 0, res: r ? `${r[1]}x${r[2]}` : '?', mbps: b / 1e6 });
  }
  return out.sort((a, b) => b.h - a.h);
}

(async () => {
  const apiUrl = SEASON
    ? `${VIX}/api/tv/${TMDB}/${SEASON}/${EPISODE}`
    : `${VIX}/api/movie/${TMDB}`;

  console.log(`\nVixSrc — teste de parâmetros · TMDB ${TMDB}${SEASON ? ` S${SEASON}E${EPISODE}` : ''}\n`);

  const api = await axios.get(apiUrl, { headers: H, timeout: 10000, validateStatus: () => true });
  if (api.status !== 200 || !api.data?.src) {
    console.log(`✗ API HTTP ${api.status} — sem src`); process.exit(1);
  }

  const embed = await axios.get(VIX + api.data.src, {
    headers: { ...H, Accept: 'text/html,*/*' },
    timeout: 10000, responseType: 'text', validateStatus: () => true,
  });
  const html = String(embed.data || '');
  const token    = html.match(/token["']\s*:\s*["']([^"']+)/)?.[1];
  const expires  = html.match(/expires["']\s*:\s*["']([^"']+)/)?.[1];
  const playlist = html.match(/url\s*:\s*["']([^"']+)/)?.[1];
  if (!token || !expires || !playlist) { console.log('✗ token/playlist não encontrados'); process.exit(1); }

  console.log(`playlist base: ${playlist}\n`);

  for (const c of COMBOS) {
    const sep = playlist.includes('?') ? '&' : '?';
    const url = `${playlist}${sep}token=${token}&expires=${expires}${c.extra ? '&' + c.extra : ''}`;
    try {
      const r = await axios.get(url, {
        headers: { ...H, Referer: VIX + '/' },
        timeout: 12000, responseType: 'text', maxRedirects: 5, validateStatus: () => true,
      });
      if (r.status !== 200) { console.log(`${c.nome.padEnd(22)} HTTP ${r.status}`); continue; }
      const v = variantes(String(r.data));
      if (!v.length) { console.log(`${c.nome.padEnd(22)} (playlist única, sem variantes)`); continue; }
      const topo = v[0];
      const lista = v.map(x => x.res.split('x')[1] + 'p').join(', ');
      console.log(`${c.nome.padEnd(22)} máx ${String(topo.res).padEnd(9)} ${topo.mbps.toFixed(1)} Mbps   [${lista}]`);
    } catch (e) {
      console.log(`${c.nome.padEnd(22)} ✗ ${e.message}`);
    }
  }

  console.log('\nSe todas derem o mesmo máximo, 720p é mesmo o tecto da VixSrc');
  console.log('e nenhum parâmetro nosso o muda.');
  process.exit(0);
})();
