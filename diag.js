'use strict';
// Diagnóstico: segue streamimdb.me → CDN e mostra cada etapa
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const imdbId = process.argv[2] || 'tt0076759';

async function main() {
  const embedUrl = `https://streamimdb.me/embed/${imdbId}/`;
  console.log(`\n=== 1. EMBED: ${embedUrl}`);
  const embed = await axios.get(embedUrl, { headers: { 'User-Agent': UA }, validateStatus: () => true });
  console.log(`status=${embed.status} len=${String(embed.data).length}`);

  const iframeMatch = String(embed.data).match(/id="player_iframe"[^>]+src="([^"]+)"/);
  if (!iframeMatch) { console.log('Iframe NÃO encontrado'); return; }
  let iframeSrc = iframeMatch[1];
  if (iframeSrc.startsWith('//')) iframeSrc = 'https:' + iframeSrc;
  console.log(`\n=== 2. IFRAME (rcp): ${iframeSrc}`);

  const rcp = await axios.get(iframeSrc, {
    headers: { 'User-Agent': UA, 'Referer': embedUrl },
    maxRedirects: 10, validateStatus: () => true,
  });
  const rcpBody = String(rcp.data);
  console.log(`status=${rcp.status} len=${rcpBody.length}`);
  console.log(`--- PRIMEIROS 2000 CHARS DO RCP ---`);
  console.log(rcpBody.substring(0, 2000));
  console.log(`--- FIM ---`);

  // Procura padrões conhecidos
  const prorcp = rcpBody.match(/['"](\/prorcp\/[^'"]+)['"]/);
  if (prorcp) console.log(`\n>>> /prorcp encontrado: ${prorcp[1]}`);
  const fileMatch = rcpBody.match(/file\s*:\s*['"]([^'"]+)['"]/);
  if (fileMatch) console.log(`\n>>> file: encontrado: ${fileMatch[1]}`);
  const m3u8 = rcpBody.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
  if (m3u8) console.log(`\n>>> m3u8 directo: ${m3u8[0]}`);
  const srcMatch = rcpBody.match(/src\s*:\s*['"]([^'"]+)['"]/);
  if (srcMatch) console.log(`\n>>> src: encontrado: ${srcMatch[1]}`);

  // Se há /prorcp, segue
  if (prorcp) {
    const base = new URL(iframeSrc).origin;
    const prorcpUrl = base + prorcp[1];
    console.log(`\n=== 3. PRORCP: ${prorcpUrl}`);
    const pr = await axios.get(prorcpUrl, {
      headers: { 'User-Agent': UA, 'Referer': iframeSrc },
      maxRedirects: 10, validateStatus: () => true,
    });
    const prBody = String(pr.data);
    console.log(`status=${pr.status} len=${prBody.length}`);
    console.log(`--- PRIMEIROS 2000 CHARS DO PRORCP ---`);
    console.log(prBody.substring(0, 2000));
    console.log(`--- FIM ---`);
    const prFile = prBody.match(/file\s*:\s*['"]([^'"]+)['"]/);
    if (prFile) console.log(`\n>>> file: ${prFile[1]}`);
    const prM3u8 = prBody.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
    if (prM3u8) console.log(`\n>>> m3u8: ${prM3u8[0]}`);
  }
}

main().catch(e => console.error('ERRO:', e.message));
