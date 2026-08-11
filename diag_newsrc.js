'use strict';
// Sonda fontes candidatas A PARTIR DESTE SERVIDOR (IP residencial).
//
// Porquê aqui e não no Vercel: a sonda /diag/sources do Vercel deu ENOTFOUND
// em metade dos candidatos e Cloudflare 403 noutros — mas isso é o datacenter
// a ser bloqueado, não os sites estarem mortos. Do IP de casa o resultado é
// outro (o primesrc.me, por exemplo, responde aqui e é 403 no Vercel).
//
// Uso: node diag_newsrc.js [tmdbId] [imdbId] [season] [episode]
//      node diag_newsrc.js 62650 tt4655480 1 1
require('dotenv').config();
const axios = require('axios');

const [, , TMDB = '62650', IMDB = 'tt4655480', S = '1', E = '1'] = process.argv;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

// Cada candidato: como construir o URL da série + o que conta como "útil".
// NOTA: o 2embed.cc, o 2embed.skin e o multiembed.mov foram tirados desta lista
// de propósito. Todos respondem HTTP 200 com HTML, por isso esta sonda dava-lhes
// "OK" — mas são landings de anúncios, sem player nenhum. Foram confirmados
// mortos com browser em Ago/2026 (ver "Fontes já descartadas" no CLAUDE.md).
// Responder a um GET não é entregar vídeo; é essa a limitação desta sonda.
const CANDIDATES = [
  { name: 'primewire.mov /s', url: `https://primewire.mov/api/v1/s?type=tv&tmdb=${TMDB}&season=${S}&episode=${E}` },
  { name: 'primesrc.me /s',   url: `https://primesrc.me/api/v1/s?type=tv&tmdb=${TMDB}&season=${S}&episode=${E}` },
  { name: 'vidsrc.xyz',       url: `https://vidsrc.xyz/embed/tv/${IMDB}/${S}-${E}` },
  { name: 'vidsrc.net',       url: `https://vidsrc.net/embed/tv/${IMDB}/${S}-${E}` },
  { name: 'vidsrc.in',        url: `https://vidsrc.in/embed/tv/${IMDB}/${S}-${E}` },
  { name: 'vidsrc.pm',        url: `https://vidsrc.pm/embed/tv/${IMDB}/${S}-${E}` },
  { name: 'vidsrc.cc',        url: `https://vidsrc.cc/v2/embed/tv/${TMDB}/${S}/${E}` },
  { name: 'embed.su',         url: `https://embed.su/embed/tv/${TMDB}/${S}/${E}` },
  { name: 'moviesapi.club',   url: `https://moviesapi.club/tv/${TMDB}-${S}-${E}` },
  { name: 'autoembed.cc',     url: `https://player.autoembed.cc/embed/tv/${TMDB}/${S}/${E}` },
  { name: 'vidbinge.dev',     url: `https://vidbinge.dev/embed/tv/${TMDB}/${S}/${E}` },
  { name: 'vidlink.pro page', url: `https://vidlink.pro/tv/${TMDB}/${S}/${E}` },
  { name: '111movies',        url: `https://111movies.com/tv/${TMDB}/${S}/${E}` },
  { name: 'vidsrc.icu',       url: `https://vidsrc.icu/embed/tv/${TMDB}/${S}/${E}` },
  { name: 'nontongo.win',     url: `https://www.nontongo.win/embed/tv/${TMDB}/${S}/${E}` },
];

// Um "Just a moment" da Cloudflare devolve 403 + HTML de challenge; queremos
// distinguir isso de um bloqueio real e de uma resposta boa.
function classify(status, body) {
  if (!body) return 'vazio';
  if (/Just a moment|challenge-platform|cf-browser-verification/i.test(body)) return 'CLOUDFLARE';
  if (status !== 200) return `HTTP ${status}`;
  if (body.length < 400) return 'resposta curta';
  return 'OK';
}

(async () => {
  console.log(`\nSonda a partir deste servidor (IP residencial)`);
  console.log(`Título: TMDB ${TMDB} / ${IMDB}  S${S}E${E}\n`);

  const results = await Promise.all(CANDIDATES.map(async c => {
    const t0 = Date.now();
    try {
      const r = await axios.get(c.url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: new URL(c.url).origin + '/',
        },
        timeout: 12000, maxRedirects: 5, validateStatus: () => true,
        responseType: 'text', transformResponse: x => x,
      });
      const body = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      return {
        name: c.name, ms: Date.now() - t0, status: r.status,
        verdict: classify(r.status, body), bytes: body.length,
        // pistas de que há mesmo vídeo por trás
        m3u8: /\.m3u8/i.test(body), iframe: /<iframe/i.test(body),
        english: /"?audio_language"?\s*:\s*"en"|LANGUAGE="en/i.test(body),
      };
    } catch (e) {
      return { name: c.name, ms: Date.now() - t0, verdict: e.code || e.message };
    }
  }));

  const pad = s => String(s).padEnd(20);
  for (const r of results) {
    const flags = [r.m3u8 && 'm3u8', r.iframe && 'iframe', r.english && 'EN'].filter(Boolean).join(' ');
    console.log(`${pad(r.name)} ${String(r.verdict).padEnd(14)} ${String(r.bytes || '').padStart(7)}b  ${flags}`);
  }
  console.log('\nOK + (m3u8|iframe) = vale a pena investigar a fundo.');
})();
