'use strict';
// Diagnóstico das FAIXAS DE ÁUDIO por fonte.
//
// Resolve um título com o scraper real e, para cada stream devolvido, vai
// buscar o master m3u8 e lista as faixas #EXT-X-MEDIA:TYPE=AUDIO. Serve para
// responder à pergunta "esta fonte tem inglês ou só italiano/alemão?" sem ter
// de abrir o Stremio e testar à mão.
//
// Uso:
//   node diag_audio.js tt4655480 series 1 1
//   node diag_audio.js tt0076759            (filme)
require('dotenv').config();
const axios = require('axios');
const { fetchFromDatacenterSources } = require('./datacenter_scraper');
const { resolveWithBrowser } = require('./browser_resolver');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

const [, , imdbId = 'tt4655480', type = 'series', season = '1', episode = '1'] = process.argv;

async function audioTracks(url, referer) {
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) },
      timeout: 15000, responseType: 'text', maxRedirects: 5, validateStatus: () => true,
    });
    if (res.status !== 200) return { error: `HTTP ${res.status}` };
    const body = typeof res.data === 'string' ? res.data : '';

    const tracks = [];
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!/^#EXT-X-MEDIA:.*TYPE=AUDIO/i.test(t)) continue;
      tracks.push({
        name:     t.match(/NAME="([^"]+)"/i)?.[1] || null,
        language: t.match(/LANGUAGE="([^"]+)"/i)?.[1] || null,
        default:  /DEFAULT=YES/i.test(t),
      });
    }
    // Sem faixas #EXT-X-MEDIA o áudio vem multiplexado no vídeo — nesse caso
    // não há escolha de língua possível no player.
    return { tracks, muxed: tracks.length === 0, bytes: body.length };
  } catch (e) {
    return { error: e.message };
  }
}

(async () => {
  console.log(`\n=== ${imdbId} (${type}${type === 'series' ? ` S${season}E${episode}` : ''}) ===\n`);

  const s1 = type === 'series' ? season : null;
  const e1 = type === 'series' ? episode : null;

  const streams = (await fetchFromDatacenterSources(imdbId, type, s1, e1)) || [];

  // Fontes por browser: na cadeia normal só correm quando falta inglês nas
  // fontes rápidas. Aqui testamos sempre, para comparar as faixas de áudio das
  // duas vias lado a lado. (Substituiu o movie-web, que foi removido — os 11
  // providers estavam todos mortos.)
  console.log('\n[browser] a testar (pode demorar)...');
  let bs = [];
  try {
    bs = (await resolveWithBrowser(imdbId, type, s1, e1)) || [];
    console.log(`[browser] ${bs.length} stream(s)`);
  } catch (e) {
    console.log(`[browser] falhou: ${e.message}`);
  }

  const all = [...streams, ...bs.map(s => ({ ...s, source: s.source || 'browser' }))];
  if (!all.length) { console.log('Nenhuma fonte resolveu.'); return; }

  console.log('');
  for (const s of all) {
    console.log(`--- ${s.source || 'desconhecida'} (${s.quality}) ---`);
    console.log(`URL: ${s.url.substring(0, 100)}...`);
    const info = await audioTracks(s.url, s.referer);
    if (info.error) { console.log(`  ✗ ${info.error}\n`); continue; }
    if (info.muxed) { console.log('  áudio multiplexado (sem faixas separadas)\n'); continue; }
    for (const t of info.tracks) {
      console.log(`  ${t.default ? '▶' : ' '} ${t.language || '?'}  ${t.name || ''}`);
    }
    const hasEn = info.tracks.some(t => /^en/i.test(t.language || '') || /english|ingl/i.test(t.name || ''));
    console.log(`  → inglês: ${hasEn ? 'SIM' : 'NÃO'}\n`);
  }
})();
