'use strict';
// Mostra o que a medição por título concluiu para UM título: estado, factor de
// tempo real, débito, e a ordem final que o Stremio vai ver.
//
// Uso: node diag_probe.js tt4655480 series 1 1
//      node diag_probe.js tt0076759               (filme)
require('dotenv').config();
const { fetchVideoSource } = require('./scraper');
const { probeStats } = require('./stream_probe');

const [, , imdbId = 'tt0076759', type = 'movie', season = null, episode = null] = process.argv;

const espera = ms => new Promise(r => setTimeout(r, ms));
const ICONE = { ok: '✓ ok      ', marginal: '~ marginal', lento: '✗ lento   ', erro: '✗ erro    ' };

(async () => {
  console.log(`\n=== Medição por título: ${imdbId}${type === 'series' ? ` S${season}E${episode}` : ''} ===\n`);

  const r = await fetchVideoSource(imdbId, type, season, episode);
  if (!r?.streams?.length) { console.log('✗ nenhum stream resolvido'); process.exit(1); }

  // A 1.ª resposta só espera STREAM_PROBE_WAIT_MS; o resto acaba em segundo
  // plano nos mesmos objectos. Aqui esperamos até estarem todos medidos.
  const limite = Date.now() + 8000;
  while (r.streams.some(s => !s.probe) && Date.now() < limite) await espera(250);

  // Ordem que o Stremio vê agora (já com as medições completas).
  const final = (await fetchVideoSource(imdbId, type, season, episode)).streams;

  console.log('Ordem final (a que o Stremio vê):\n');
  final.forEach((s, i) => {
    const p = s.probe;
    const est = p ? (ICONE[p.klass] || '? sem classe') : '– sem medição';
    const num = p && p.factor != null
      ? `${p.factor.toFixed(2)}x tempo real · ${p.mbps.toFixed(1)} Mbps${p.ttfbMs != null ? ` · 1.º byte ${p.ttfbMs}ms` : ''}`
      : (p?.reason || '');
    const audio = (s.audioLangs || []).map(l => l.toUpperCase()).join('/') || '?';
    console.log(`  ${i + 1}. ${String(s.source || '?').padEnd(10)} ${String(s.quality || '').padEnd(6)} áudio ${audio.padEnd(8)} ${est}  ${num}`);
    if (p?.reason && p.factor != null) console.log(`       (${p.reason})`);
  });

  console.log('\nLeitura: factor >= 1.5 = folga · 1.0-1.5 = marginal · < 1.0 = vai parar para carregar.');
  console.log('Mede CDN → servidor. O troço servidor → túnel → cliente é outro (diag_entrega.js).\n');

  const st = probeStats();
  console.log('Estatística acumulada por fonte (última hora):');
  for (const [nome, x] of Object.entries(st.sources)) {
    console.log(`  ${nome.padEnd(10)} ${x.samples} amostras · mediana ${x.medianFactor}x${x.slow ? '  ⚠ LENTA' : ''}${x.errors ? ` · ${x.errors} erros` : ''}`);
  }
  process.exit(0);
})();
