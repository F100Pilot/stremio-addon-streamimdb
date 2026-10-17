'use strict';
// Porque é que o vídeo fica em 720p?
//
// Num stream HLS a resolução não é escolhida por nós: o player mede a rapidez
// com que os segmentos chegam e sobe ou desce de variante conforme isso. Há
// três razões possíveis para ficar preso no 720p, e cada uma tem solução
// diferente — este script distingue-as:
//
//   1. O master nem sequer anuncia 1080p  → problema na fonte
//   2. Anuncia, mas o débito pelo proxy não dá → problema de caminho
//      (CDN → servidor de casa → Cloudflare Tunnel → cliente)
//   3. Anuncia e o débito dá → problema do player
//
// Uso: node diag_quality.js tt4655480 series 1 1
//      node diag_quality.js tt0076759 movie
require('dotenv').config();
const axios = require('axios');
const { fetchVideoSource } = require('./scraper');

const [, , imdbId = 'tt0076759', type = 'movie', season = null, episode = null] = process.argv;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

// Quantos bytes descarregar para estimar o débito. Suficiente para uma medição
// estável sem puxar um segmento inteiro.
const PROBE_BYTES = parseInt(process.env.QUALITY_PROBE_BYTES) || 3 * 1024 * 1024;

function parseVariants(m3u8, baseUrl) {
  const out = [];
  const lines = m3u8.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!/^#EXT-X-STREAM-INF/i.test(t)) continue;
    const uri = (lines[i + 1] || '').trim();
    if (!uri || uri.startsWith('#')) continue;
    const res = t.match(/RESOLUTION=(\d+)x(\d+)/i);
    let abs; try { abs = new URL(uri, baseUrl).href; } catch { abs = uri; }
    out.push({
      height: res ? parseInt(res[2], 10) : 0,
      resolution: res ? `${res[1]}x${res[2]}` : '?',
      bandwidth: parseInt(t.match(/[^-]BANDWIDTH=(\d+)/i)?.[1] || 0, 10),
      url: abs,
    });
  }
  return out.sort((a, b) => b.height - a.height);
}

// Débito real: descarrega PROBE_BYTES e cronometra. Devolve Mbps.
async function medirDebito(url, referer) {
  const t0 = Date.now();
  let bytes = 0;
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) },
      timeout: 30000, responseType: 'stream', maxRedirects: 5, validateStatus: () => true,
    });
    if (res.status >= 400) return { erro: `HTTP ${res.status}` };

    await new Promise((resolve, reject) => {
      res.data.on('data', chunk => {
        bytes += chunk.length;
        if (bytes >= PROBE_BYTES) { res.data.destroy(); resolve(); }
      });
      res.data.on('end', resolve);
      res.data.on('error', reject);
    });
  } catch (e) {
    if (!bytes) return { erro: e.message };
  }
  const segundos = (Date.now() - t0) / 1000;
  return { bytes, segundos, mbps: (bytes * 8) / segundos / 1e6 };
}

(async () => {
  console.log(`\n=== Diagnóstico de qualidade: ${imdbId}${type === 'series' ? ` S${season}E${episode}` : ''} ===\n`);

  const result = await fetchVideoSource(imdbId, type, season, episode);
  if (!result?.streams?.length) { console.log('✗ nenhum stream resolvido'); process.exit(1); }

  for (const s of result.streams) {
    console.log(`\n── ${s.source || '?'} (rótulo: ${s.quality}) ──`);

    const master = await axios.get(s.url, {
      headers: { 'User-Agent': UA, ...(s.referer ? { Referer: s.referer } : {}) },
      timeout: 15000, responseType: 'text', maxRedirects: 5, validateStatus: () => true,
    }).catch(e => ({ status: 0, data: '', erro: e.message }));

    if (master.status !== 200) { console.log(`  ✗ master HTTP ${master.status} ${master.erro || ''}`); continue; }

    const variantes = parseVariants(String(master.data), s.url);
    if (!variantes.length) {
      console.log('  (playlist única — sem variantes de qualidade para escolher)');
      continue;
    }

    console.log('  Variantes anunciadas:');
    for (const v of variantes) {
      console.log(`    ${String(v.resolution).padEnd(10)} ${(v.bandwidth / 1e6).toFixed(1).padStart(5)} Mbps`);
    }

    const melhor = variantes[0];
    const temHD = melhor.height >= 1080;
    console.log(`  → máximo anunciado: ${melhor.resolution}${temHD ? '' : '  ⚠ a FONTE não tem 1080p'}`);
    if (!temHD) continue;

    // Débito até à variante de topo. É este número que o player usa para
    // decidir — se for inferior ao BANDWIDTH da variante, ele desce.
    console.log(`\n  A medir débito até ${melhor.resolution} (${(PROBE_BYTES / 1e6).toFixed(0)} MB)...`);
    const d = await medirDebito(melhor.url, s.referer);
    if (d.erro) { console.log(`    ✗ ${d.erro}`); continue; }

    console.log(`    ${(d.bytes / 1e6).toFixed(1)} MB em ${d.segundos.toFixed(1)}s = ${d.mbps.toFixed(1)} Mbps`);
    const precisa = melhor.bandwidth / 1e6;
    console.log(`    a variante pede ${precisa.toFixed(1)} Mbps`);

    if (d.mbps >= precisa * 1.5) {
      console.log(`    ✓ folga suficiente — se o player fica em 720p, o problema é dele`);
    } else if (d.mbps >= precisa) {
      console.log(`    ⚠ dá, mas sem margem — o player desce ao primeiro soluço`);
    } else {
      console.log(`    ✗ INSUFICIENTE — o player vai descer de variante, como se vê`);
    }
  }

  console.log('\nNota: esta medição é feita DAQUI (servidor). O cliente Stremio');
  console.log('ainda acrescenta o Cloudflare Tunnel e o upload de casa por cima.');
  process.exit(0);
})();
