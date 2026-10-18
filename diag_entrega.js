'use strict';
// Onde é que se perde o débito: no caminho até à CDN, ou no túnel até ao
// cliente?
//
// Serve o MESMO segmento por dois caminhos e cronometra os dois:
//   localhost:7000  → servidor → CDN              (sem túnel)
//   SERVER_URL      → Cloudflare → servidor → CDN (como o Stremio o recebe)
//
// Se o localhost for rápido e o público lento, o estrangulamento é o túnel
// mais o upload de casa — e aí não há nada no addon que o resolva.
// Se os dois forem lentos, o problema está entre o servidor e a CDN.
//
// Uso: node diag_entrega.js [imdbId] [type] [season] [episode]
//      node diag_entrega.js                      (Star Wars, por omissão)
//      node diag_entrega.js tt4655480 series 1 1
require('dotenv').config();
const axios = require('axios');

const [, , imdbId = 'tt0076759', type = 'movie', season = null, episode = null] = process.argv;

const PORT   = process.env.PORT || 7000;
const LOCAL  = `http://localhost:${PORT}`;
const PUBLIC = (process.env.SERVER_URL || '').replace(/\/$/, '');

const espera = ms => new Promise(r => setTimeout(r, ms));

// O servidor pode ter acabado de reiniciar — tenta até estar de pé.
async function esperarServidor(tentativas = 15) {
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await axios.get(`${LOCAL}/health`, { timeout: 3000, validateStatus: () => true });
      if (r.status === 200) return true;
    } catch { /* ainda a arrancar */ }
    if (i === 0) process.stdout.write('  à espera do servidor');
    process.stdout.write('.');
    await espera(1000);
  }
  return false;
}

async function cronometrar(url, etiqueta) {
  const t0 = Date.now();
  let bytes = 0;
  try {
    const res = await axios.get(url, {
      timeout: 60000, responseType: 'stream', maxRedirects: 5, validateStatus: () => true,
    });
    if (res.status !== 200 && res.status !== 206) {
      console.log(`  ${etiqueta.padEnd(28)} HTTP ${res.status}`);
      return null;
    }
    const enc = res.headers['content-encoding'];
    await new Promise((resolve, reject) => {
      res.data.on('data', c => { bytes += c.length; });
      res.data.on('end', resolve);
      res.data.on('error', reject);
    });
    const s = (Date.now() - t0) / 1000;
    const mbps = (bytes * 8) / s / 1e6;
    console.log(`  ${etiqueta.padEnd(28)} ${(bytes / 1e6).toFixed(2)} MB em ${s.toFixed(2)}s = ${mbps.toFixed(1)} Mbps${enc ? `  ⚠ content-encoding: ${enc}` : ''}`);
    return { mbps, s, bytes };
  } catch (e) {
    console.log(`  ${etiqueta.padEnd(28)} ✗ ${e.message}`);
    return null;
  }
}

(async () => {
  console.log(`\n=== Entrega: ${imdbId}${type === 'series' ? ` S${season}E${episode}` : ''} ===\n`);

  if (!await esperarServidor()) { console.log('\n✗ servidor não respondeu em localhost:' + PORT); process.exit(1); }
  console.log('');

  const path = type === 'series'
    ? `/stream/series/${imdbId}:${season}:${episode}.json`
    : `/stream/movie/${imdbId}.json`;

  const r = await axios.get(LOCAL + path, { timeout: 90000, validateStatus: () => true });
  if (r.status !== 200) { console.log(`✗ stream HTTP ${r.status}`); process.exit(1); }

  const stream = (r.data?.streams || []).find(s => s.url && s.url.includes('/hls/'));
  if (!stream) { console.log('✗ nenhum stream proxiado (/hls) devolvido'); process.exit(1); }
  console.log(`stream: ${stream.title}`);

  // O URL vem com o domínio público; para o lado local trocamos a base.
  const hlsPublico = stream.url;
  const hlsLocal   = PUBLIC ? hlsPublico.replace(PUBLIC, LOCAL) : hlsPublico;

  const master = await axios.get(hlsLocal, { timeout: 20000, responseType: 'text', validateStatus: () => true });
  if (master.status !== 200) { console.log(`✗ master HTTP ${master.status}`); process.exit(1); }

  // Primeira variante → primeiro segmento. O master aponta para /hls (a
  // variante) e só dentro dela é que estão os /seg.
  const variante = String(master.data).split('\n').map(l => l.trim())
    .find(l => l && !l.startsWith('#') && l.includes('/hls/'));
  if (!variante) { console.log('✗ sem variante no master'); process.exit(1); }

  const vLocal = PUBLIC ? variante.replace(PUBLIC, LOCAL) : variante;
  const vres = await axios.get(vLocal, { timeout: 20000, responseType: 'text', validateStatus: () => true });
  const seg = String(vres.data || '').split('\n').map(l => l.trim())
    .find(l => l && !l.startsWith('#') && l.includes('/seg/'));
  if (!seg) { console.log('✗ sem segmento na variante'); process.exit(1); }

  const segLocal = PUBLIC ? seg.replace(PUBLIC, LOCAL) : seg;
  console.log(`segmento: ...${seg.slice(-50)}\n`);

  console.log('Mesmo segmento, dois caminhos:');
  const l = await cronometrar(segLocal, 'localhost (sem túnel)');
  if (!PUBLIC) {
    console.log('\n(SERVER_URL não definido no .env — não dá para testar o caminho público)');
    process.exit(0);
  }
  const p = await cronometrar(seg, 'domínio público (túnel)');

  if (l && p) {
    const racio = l.mbps / p.mbps;
    console.log('');
    if (racio > 2) {
      console.log(`→ o túnel corta o débito para 1/${racio.toFixed(1)}. É AÍ que se perde.`);
      console.log('  Nada no addon corrige isto: é o upload de casa + Cloudflare.');
    } else if (l.mbps < 4) {
      console.log('→ lento nos DOIS caminhos: o estrangulamento está entre o servidor e a CDN.');
    } else {
      console.log('→ os dois caminhos entregam bem. Os engasgos não vêm daqui.');
    }
  }
  process.exit(0);
})();
