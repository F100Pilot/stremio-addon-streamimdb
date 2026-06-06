'use strict';
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT = 12000;

function extractM3u8(text) {
  const m = text.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/);
  return m ? m[0] : null;
}

function extractSources(body) {
  try {
    const m = body.match(/"sources"\s*:\s*(\[[\s\S]*?\])/);
    if (m) {
      const sources = JSON.parse(m[1]);
      return sources
        .map(s => ({ url: s.file || s.src || s.url, quality: s.label || s.type || 'Auto' }))
        .filter(s => s.url && (s.url.includes('.m3u8') || s.url.includes('.mp4')));
    }
  } catch {}
  return [];
}

// multiembed.mov - redireciona directamente para stream
async function tryMultiEmbed(imdbId, type, season, episode) {
  let url = type === 'series'
    ? `https://multiembed.mov/directstream.php?video_id=${imdbId}&s=${season}&e=${episode}`
    : `https://multiembed.mov/directstream.php?video_id=${imdbId}`;

  try {
    const res = await axios.get(url, {
      timeout: TIMEOUT,
      maxRedirects: 10,
      headers: { 'User-Agent': UA, 'Referer': 'https://multiembed.mov/' },
      validateStatus: s => s < 500,
    });

    const finalUrl = res.request?.res?.responseUrl || res.config?.url || url;
    if (finalUrl.includes('.m3u8')) {
      console.log(`[alt] multiembed redirect → m3u8`);
      return [{ url: finalUrl, quality: 'Auto' }];
    }

    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    const sources = extractSources(body);
    if (sources.length) { console.log(`[alt] multiembed sources: ${sources.length}`); return sources; }

    const m3u8 = extractM3u8(body);
    if (m3u8) { console.log(`[alt] multiembed m3u8 found`); return [{ url: m3u8, quality: 'Auto' }]; }

  } catch (e) {
    console.log(`[alt] multiembed: ${e.message}`);
  }
  return null;
}

// moviesapi.club - retorna JSON com sources
async function tryMoviesApi(imdbId, type, season, episode) {
  const url = type === 'series'
    ? `https://moviesapi.club/tv/${imdbId}-${season}-${episode}`
    : `https://moviesapi.club/movie/${imdbId}`;

  try {
    const res = await axios.get(url, {
      timeout: TIMEOUT,
      headers: { 'User-Agent': UA, 'Referer': 'https://moviesapi.club/' },
      validateStatus: s => s < 500,
    });

    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    const sources = extractSources(body);
    if (sources.length) { console.log(`[alt] moviesapi sources: ${sources.length}`); return sources; }

    const m3u8 = extractM3u8(body);
    if (m3u8) { console.log(`[alt] moviesapi m3u8 found`); return [{ url: m3u8, quality: 'Auto' }]; }

  } catch (e) {
    console.log(`[alt] moviesapi: ${e.message}`);
  }
  return null;
}

// vidsrc.xyz
async function tryVidsrcXyz(imdbId, type, season, episode) {
  const url = type === 'series'
    ? `https://vidsrc.xyz/embed/tv?imdb=${imdbId}&season=${season}&episode=${episode}`
    : `https://vidsrc.xyz/embed/movie?imdb=${imdbId}`;

  try {
    const res = await axios.get(url, {
      timeout: TIMEOUT,
      headers: { 'User-Agent': UA, 'Referer': 'https://vidsrc.xyz/' },
      validateStatus: s => s < 500,
    });

    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    const sources = extractSources(body);
    if (sources.length) { console.log(`[alt] vidsrc.xyz sources: ${sources.length}`); return sources; }

    const m3u8 = extractM3u8(body);
    if (m3u8) { console.log(`[alt] vidsrc.xyz m3u8 found`); return [{ url: m3u8, quality: 'Auto' }]; }

  } catch (e) {
    console.log(`[alt] vidsrc.xyz: ${e.message}`);
  }
  return null;
}

async function fetchFromAltSources(imdbId, type, season, episode) {
  const sources = [
    () => tryMultiEmbed(imdbId, type, season, episode),
    () => tryMoviesApi(imdbId, type, season, episode),
    () => tryVidsrcXyz(imdbId, type, season, episode),
  ];

  for (const fn of sources) {
    const result = await fn();
    if (result && result.length > 0) return result;
  }
  return null;
}

module.exports = { fetchFromAltSources };
