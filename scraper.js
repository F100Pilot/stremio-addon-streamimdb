'use strict';
const axios = require('axios');
const { fetchFromProviders } = require('./providers');
const { fetchFromAltSources } = require('./alt_scraper');

const VAPLAYER_API_URL = process.env.VAPLAYER_API_URL || 'https://streamdata.vaplayer.ru/api.php';
const BRIGHTPATH_BASE  = 'https://brightpathsignals.com/embed';

const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS) || 5 * 60 * 1000; // 5min
const MAX_QUEUE = parseInt(process.env.MAX_QUEUE)    || 8;

const cache   = new Map();
const pending = new Map();
let activeScrapes = 0;

const mfCache = new Map();
const MF_TTL  = 3 * 60 * 1000; // 3 min

function setMfCache(url, body) {
  mfCache.set(url, { body, ts: Date.now() });
  for (const [k, v] of mfCache) if (Date.now() - v.ts > MF_TTL) mfCache.delete(k);
}
function getMfCache(url) {
  const e = mfCache.get(url);
  if (!e || Date.now() - e.ts > MF_TTL) { mfCache.delete(url); return null; }
  return e.body;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function cacheKey(imdbId, type, season, episode) {
  return `${imdbId}:${type}:${season || ''}:${episode || ''}`;
}

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) { cache.delete(key); return null; }
  return entry.streams;
}

function setCached(key, streams) {
  cache.set(key, { streams, timestamp: Date.now() });
  console.log(`[cache] Guardado: ${key} (cache size: ${cache.size})`);
}

function resolutionToQuality(resolution, bandwidth) {
  if (resolution) {
    const h = parseInt(resolution.split('x')[1]) || 0;
    if (h >= 2160) return '4K';
    if (h >= 1440) return '2K';
    if (h >= 1080) return '1080p';
    if (h >= 720)  return '720p';
    if (h >= 480)  return '480p';
    if (h >= 360)  return '360p';
  }
  if (bandwidth > 8000000) return '4K';
  if (bandwidth > 4000000) return '1080p';
  if (bandwidth > 2000000) return '720p';
  if (bandwidth > 800000)  return '480p';
  return 'Auto';
}

function parseMasterPlaylist(body, masterUrl) {
  const base  = masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1);
  const lines = body.split('\n');
  const seen  = new Set();
  const variants = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;

    const bwMatch  = line.match(/BANDWIDTH=(\d+)/);
    const resMatch = line.match(/RESOLUTION=([\dx]+)/);
    const bandwidth  = bwMatch  ? parseInt(bwMatch[1])  : 0;
    const resolution = resMatch ? resMatch[1] : null;

    const urlLine = lines[i + 1]?.trim();
    if (!urlLine || urlLine.startsWith('#')) continue;

    let url;
    try { url = new URL(urlLine, masterUrl).href; } catch { url = urlLine; }
    const quality = resolutionToQuality(resolution, bandwidth);

    if (!seen.has(quality)) {
      seen.add(quality);
      variants.push({ url, quality, bandwidth });
    }
  }

  const sorted = variants.sort((a, b) => b.bandwidth - a.bandwidth);
  if (sorted.length > 0) {
    const variantStr = sorted.map(v => `${v.quality}(${(v.bandwidth/1000).toFixed(0)}kbps)`).join(', ');
    console.log(`[scraper] Variantes no m3u8: ${variantStr}`);
  }
  return sorted;
}

// Testa um stream_url:
//   verified=true  → CDN respondeu 200 com playlist HLS válida
//   verified=false → CDN respondeu 4xx (stream provavelmente funciona)
//   null           → CDN inacessível (timeout / 5xx)
async function resolveStream(m3u8Url, referer) {
  for (const headers of [
    { 'User-Agent': UA, Referer: referer, Origin: 'https://brightpathsignals.com' },
    { 'User-Agent': UA, Referer: referer },
    { 'User-Agent': UA },
  ]) {
    try {
      const res = await axios.get(m3u8Url, {
        headers,
        timeout: 6000,
        maxRedirects: 5,
        responseType: 'text',
        validateStatus: s => s < 500,
      });
      if (res.status === 200) {
        const body = typeof res.data === 'string' ? res.data : '';
        if (body.trimStart().startsWith('#EXTM3U'))
          return { url: m3u8Url, verified: true, body };
      }
      return { url: m3u8Url, verified: false };
    } catch { /* timeout ou erro de rede — tenta sem Referer */ }
  }
  return null;
}

async function doFetch(imdbId, type, season, episode) {
  const referer = type === 'series'
    ? `${BRIGHTPATH_BASE}/tv/${imdbId}/${season}/${episode}`
    : `${BRIGHTPATH_BASE}/movie/${imdbId}`;

  const params = { imdb: imdbId, type: type === 'series' ? 'tv' : 'movie' };
  if (type === 'series') { params.season = season; params.episode = episode; }

  let apiRes;
  try {
    apiRes = await axios.get(VAPLAYER_API_URL, {
      params,
      headers: {
        'User-Agent': UA,
        'Referer': referer,
        'Origin': 'https://brightpathsignals.com',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
      },
      timeout: 10000,
      maxRedirects: 5,
    });
  } catch (e) {
    console.error('[scraper] Erro na chamada API:', e.message);
    return null;
  }

  const body = apiRes.data;
  console.log(`[scraper] API ${apiRes.status} — ${JSON.stringify(body).substring(0, 200)}`);

  if (apiRes.status !== 200 || !body || !body.data) {
    console.log('[scraper] Resposta inválida ou erro da API');
    return null;
  }

  const streamUrls = body.data.stream_urls;
  if (!Array.isArray(streamUrls) || !streamUrls.length) {
    console.log('[scraper] Nenhum stream_url na resposta');
    return null;
  }

  const results = await Promise.all(streamUrls.map(u => resolveStream(u, referer)));
  const best = results.find(r => r?.verified) || results.find(r => r && !r.verified);

  if (!best) {
    console.log('[scraper] Todas as fontes inacessíveis — a usar primeira como último recurso');
    return [{ url: streamUrls[0], quality: 'Auto' }];
  }

  if (!best.verified || !best.body) {
    console.log('[scraper] Fonte acessível (CDN bloqueou pré-fetch) — a proxy para adicionar headers');
    return [{ url: best.url, quality: 'Auto' }];
  }

  setMfCache(best.url, best.body);
  const variants = parseMasterPlaylist(best.body, best.url);
  if (variants.length > 0) {
    const top = variants[0]; // já ordenado por bandwidth desc — melhor qualidade
    try {
      const vr = await resolveStream(top.url, referer);
      if (vr?.body) setMfCache(top.url, vr.body);
    } catch (_) {}
    console.log(`[scraper] melhor qualidade: ${top.quality}`);
    return [{ url: top.url, quality: top.quality }];
  }

  console.log('[scraper] Fonte verificada (sem variantes)');
  return [{ url: best.url, quality: 'Auto' }];
}

async function fetchVideoSource(imdbId, type = 'movie', season = null, episode = null) {
  if (!imdbId || !imdbId.startsWith('tt')) throw new Error(`ID IMDb inválido: ${imdbId}`);

  const key = cacheKey(imdbId, type, season, episode);

  const cached = getCached(key);
  if (cached) { console.log(`[cache] Hit: ${key}`); return { streams: cached, type: 'direct' }; }

  if (pending.has(key)) {
    console.log(`[cache] Dedup: aguardando fetch em curso para ${key}`);
    const streams = await pending.get(key);
    return streams ? { streams, type: 'direct' } : null;
  }

  if (activeScrapes >= MAX_QUEUE) {
    console.log(`[scraper] Sobrecarga (${activeScrapes} pedidos activos) — a rejeitar`);
    return null;
  }

  activeScrapes++;
  const fetchPromise = doFetch(imdbId, type, season, episode)
    .then(streams => {
      if (streams) setCached(key, streams);
      pending.delete(key);
      activeScrapes = Math.max(0, activeScrapes - 1);
      return streams;
    })
    .catch(err => {
      console.error('[scraper] Erro:', err.message);
      pending.delete(key);
      activeScrapes = Math.max(0, activeScrapes - 1);
      return null;
    });

  pending.set(key, fetchPromise);
  let streams = await fetchPromise;

  if (!streams) {
    console.log('[scraper] Provider principal falhou — a tentar fontes alternativas...');
    try {
      streams = await fetchFromAltSources(imdbId, type, season, episode);
      if (streams) {
        console.log('[scraper] Fontes alternativas OK');
        setCached(key, streams);
      }
    } catch (e) {
      console.log('[scraper] Fontes alternativas falharam:', e.message);
    }
  }

  if (!streams) {
    console.log('[scraper] A tentar movie-web providers...');
    try {
      streams = await fetchFromProviders(imdbId, type, season, episode);
      if (streams) {
        console.log('[scraper] movie-web providers OK');
        setCached(key, streams);
      }
    } catch (e) {
      console.log('[scraper] movie-web providers falhou:', e.message);
    }
  }

  return streams ? { streams, type: 'direct' } : null;
}

function invalidateCache(imdbId, type, season, episode) {
  const key = cacheKey(imdbId, type, season, episode);
  const had = cache.delete(key);
  if (had) console.log(`[cache] Invalidado: ${key}`);
  return had;
}

function getStatus() {
  const now = Date.now();
  const entries = [];
  for (const [key, entry] of cache.entries()) {
    entries.push({ key, ageSeconds: Math.floor((now - entry.timestamp) / 1000) });
  }
  return {
    activeScrapes,
    maxQueue: MAX_QUEUE,
    cache: { size: cache.size, ttlSeconds: Math.floor(CACHE_TTL / 1000), entries },
  };
}

module.exports = { fetchVideoSource, getStatus, invalidateCache, cacheKey, getMfCache };
