'use strict';
// Diagnóstico ponta-a-ponta do proxy HLS via domínio público (Cloudflare Tunnel)
// — exatamente o que o cliente Stremio faz: master → variante de vídeo → 1º
// segmento, reportando o status de cada passo.
// Uso: node diag_proxy.js [stremio-path]
//   default: stream/series/tt1442437:3:9.json
require('dotenv').config();
const axios = require('axios');

const LOCAL  = 'http://localhost:7000';
const PUBLIC = (process.env.SERVER_URL || LOCAL).replace(/\/$/, '');
const PATH   = process.argv[2] || 'stream/series/tt1442437:3:9.json';

async function get(url, label) {
  try {
    const r = await axios.get(url, { responseType: 'text', timeout: 20000, validateStatus: () => true, maxRedirects: 5 });
    const body = typeof r.data === 'string' ? r.data : '';
    console.log(`  [${label}] HTTP ${r.status} · ${body.length} bytes · ${url.substring(0, 80)}`);
    return { status: r.status, body };
  } catch (e) {
    console.log(`  [${label}] ERRO ${e.message} · ${url.substring(0, 80)}`);
    return { status: 0, body: '' };
  }
}

function firstVariant(m3u8) {
  const lines = m3u8.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const u = (lines[i + 1] || '').trim();
      if (u && !u.startsWith('#')) return u;
    }
  }
  return null;
}
function firstSegment(m3u8) {
  for (const line of m3u8.split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#')) return t;
  }
  return null;
}

async function main() {
  console.log('Domínio público:', PUBLIC);
  console.log('\n=== 1. /stream → URL do master ===');
  const s = await get(`${LOCAL}/${PATH}`, 'stream');
  const master = (s.body.match(/"url":"([^"]+)"/) || [])[1];
  if (!master) { console.log('  Sem URL no /stream. Abortar.'); return; }

  console.log('\n=== 2. Master via Cloudflare ===');
  const m = await get(master, 'master');
  if (m.status !== 200) { console.log('  Master falhou. Abortar.'); return; }

  const variant = firstVariant(m.body);
  if (!variant) { console.log('  Nenhuma variante #EXT-X-STREAM-INF no master. Abortar.'); return; }
  console.log('\n=== 3. Variante de vídeo ===');
  const v = await get(variant, 'variante');
  if (v.status !== 200) { console.log('  Variante falhou. Provável bug na reescrita.'); return; }

  const seg = firstSegment(v.body);
  if (!seg) { console.log('  Variante sem segmentos. Conteúdo:\n' + v.body.substring(0, 400)); return; }
  console.log('\n=== 4. 1º segmento de vídeo ===');
  const g = await get(seg, 'segmento');
  console.log('\n=== RESULTADO ===');
  console.log(g.status === 200
    ? '✓ Cadeia completa OK. Se o vídeo não abre, o problema é no player/cliente.'
    : `✗ Segmento falhou (HTTP ${g.status}) — a CDN recusa o pedido do servidor (Referer/IP).`);
}

main().catch(e => console.error('Erro fatal:', e.message));
