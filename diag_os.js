'use strict';
// Testa a procura de legendas externas por nome de release, sem tocar no
// addon. Mostra a percentagem de correspondência de cada candidata — 100%
// significa mesmo release (sincronia garantida), valores baixos são palpites.
//
// Uso: node diag_os.js tt4655480 series 1 2 "Chicago.Med.S01E02.1080p.WEB-DL.DD+5.1.H.264-SbR.mkv"
//      node diag_os.js tt4655480 series 1 2      (sem release: mostra o efeito de não filtrar)
require('dotenv').config();
const { fetchSubtitlesForRelease } = require('./subtitles_os');

const [, , imdbId = 'tt4655480', type = 'series', season = '1', episode = '2', release = null] = process.argv;

(async () => {
  console.log(`\n${imdbId} ${type === 'series' ? `S${season}E${episode}` : ''}`);
  console.log(`release: ${release || '(nenhum — sem filtro por versão)'}\n`);

  const t0 = Date.now();
  const subs = await fetchSubtitlesForRelease(
    imdbId, type,
    type === 'series' ? season : null,
    type === 'series' ? episode : null,
    release,
  );
  console.log(`\ndemorou ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (!subs.length) { console.log('✗ nenhuma legenda encontrada'); return; }
  for (const s of subs) {
    console.log(`  [${s.lang}] ${s.name}`);
    console.log(`        ${s.url.substring(0, 100)}`);
  }
  console.log('\nMatch alto = mesmo release = em sincronia. Match baixo = palpite.');
})();
