'use strict';
// Diagnóstico: mostra como o VixSrc declara as legendas no master m3u8.
// Uso: node diag_subs.js [tmdbId] [season] [episode]   (default: Severance S3E9 → tmdb 1421)
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const VIX_BASE = 'https://vixsrc.to';
const HEADERS = { 'User-Agent': UA, 'Referer': VIX_BASE, 'Origin': VIX_BASE };

async function main() {
  const tmdbId  = process.argv[2] || '1421';
  const season  = process.argv[3] || '3';
  const episode = process.argv[4] || '9';

  const apiUrl = `${VIX_BASE}/api/tv/${tmdbId}/${season}/${episode}`;
  console.log('→ API:', apiUrl);
  const api = await axios.get(apiUrl, { headers: HEADERS });
  if (!api.data || !api.data.src) { console.log('Sem src na API:', api.data); return; }

  const embedUrl = VIX_BASE + api.data.src;
  console.log('→ Embed:', embedUrl);
  const embed = await axios.get(embedUrl, { headers: { ...HEADERS, Accept: 'text/html' }, responseType: 'text' });
  const html = embed.data;

  const token    = html.match(/token["']\s*:\s*["']([^"']+)/)?.[1];
  const expires  = html.match(/expires["']\s*:\s*["']([^"']+)/)?.[1];
  const playlist = html.match(/url\s*:\s*["']([^"']+)/)?.[1];
  if (!token || !expires || !playlist) { console.log('Token/playlist não encontrados no embed'); return; }

  const sep = playlist.includes('?') ? '&' : '?';
  const masterUrl = `${playlist}${sep}token=${token}&expires=${expires}&h=1`;
  console.log('→ Master:', masterUrl.substring(0, 90), '...\n');

  const master = await axios.get(masterUrl, { headers: HEADERS, responseType: 'text' });
  const lines = master.data.split('\n');

  console.log('=== Linhas #EXT-X-MEDIA (todas, primeiras 12) ===');
  const mediaLines = lines.filter(l => /#EXT-X-MEDIA/i.test(l));
  mediaLines.slice(0, 12).forEach((l, i) => console.log(`[${i}] ${l.trim()}`));
  console.log(`\nTotal de linhas #EXT-X-MEDIA: ${mediaLines.length}`);

  console.log('\n=== Linhas com TYPE=SUBTITLES ===');
  const subLines = lines.filter(l => /TYPE=SUBTITLES/i.test(l));
  console.log(`Total: ${subLines.length}`);
  subLines.slice(0, 6).forEach((l, i) => console.log(`[${i}] ${l.trim()}`));

  console.log('\n=== Primeiras 40 linhas do master (estrutura geral) ===');
  console.log(lines.slice(0, 40).join('\n'));
}

main().catch(e => console.error('Erro:', e.message));
