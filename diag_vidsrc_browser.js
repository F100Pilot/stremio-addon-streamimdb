'use strict';
// Testa o vidsrc_resolver isoladamente (sem passar pelo scraper/cache) e
// mostra as faixas de áudio do m3u8 que apanhar.
//
// Uso: node diag_vidsrc_browser.js tt4655480 series 1 1
//      node diag_vidsrc_browser.js tt0076759 movie
require('dotenv').config();
const axios = require('axios');
const { resolveVidsrc } = require('./vidsrc_resolver');

const [, , imdbId = 'tt4655480', type = 'series', season = '1', episode = '1'] = process.argv;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

(async () => {
  const t0 = Date.now();
  const streams = await resolveVidsrc(
    imdbId, type,
    type === 'series' ? season : null,
    type === 'series' ? episode : null,
  );
  console.log(`\ndemorou ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (!streams || !streams.length) { console.log('✗ sem stream'); process.exit(1); }

  for (const s of streams) {
    console.log(`\n★ ${s.source}: ${s.url}`);
    console.log(`  referer: ${s.referer}`);
    try {
      const r = await axios.get(s.url, {
        headers: { 'User-Agent': UA, Referer: s.referer },
        timeout: 15000, responseType: 'text', maxRedirects: 5, validateStatus: () => true,
      });
      const body = typeof r.data === 'string' ? r.data : '';
      console.log(`  master: HTTP ${r.status} · ${body.length}b`);
      const audio = body.split('\n').filter(l => /^#EXT-X-MEDIA:.*TYPE=AUDIO/i.test(l.trim()));
      console.log(`  áudio: ${audio.length ? '' : 'multiplexado (sem faixas separadas)'}`);
      for (const a of audio) {
        console.log(`    ${a.match(/LANGUAGE="([^"]+)"/i)?.[1] || '?'}  ${a.match(/NAME="([^"]+)"/i)?.[1] || ''}${/DEFAULT=YES/i.test(a) ? '  (default)' : ''}`);
      }

      // Legendas embutidas no manifesto — as únicas garantidamente em sincronia
      // com este encode. Se estiverem aqui e mesmo assim houver dessincronia,
      // as que o player mostra vêm de outro sítio (outro addon de legendas).
      const subs = body.split('\n').filter(l => /^#EXT-X-MEDIA:.*TYPE=SUBTITLES/i.test(l.trim()));
      console.log(`  legendas no manifesto: ${subs.length || 'NENHUMA'}`);
      for (const t of subs) {
        console.log(`    ${t.match(/LANGUAGE="([^"]+)"/i)?.[1] || '?'}  ${t.match(/NAME="([^"]+)"/i)?.[1] || ''}`);
      }

      // Legendas próprias da fonte (metaApi), que é o que enviamos no stream.
      console.log(`  legendas do metaApi: ${(s.subtitles || []).length || 'NENHUMA'}`);
      for (const t of (s.subtitles || [])) console.log(`    ${t.lang || '?'}  ${t.url.substring(0, 80)}`);
    } catch (e) { console.log(`  ✗ ${e.message}`); }
  }
  process.exit(0);
})();
