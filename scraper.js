'use strict';
// Orquestra as fontes de streaming com cache + dedup + protecção de sobrecarga.
//
// Ordem das tentativas (fetchVideoSource):
//   1. datacenter_scraper (VixSrc, Vidlink) — só axios, funciona em datacenter/Vercel
//   2. browser_resolver (vidsrc & cia) — precisa de Chromium, no-op no Vercel
//   3. upstream relay — encaminha para o servidor caseiro (IP residencial)
//
// Foram removidos daqui o alt_scraper (streamimdb.me, morto pelo Cloudflare
// Turnstile) e os movie-web providers (11 providers, todos mortos). Ver CLAUDE.md.
const { fetchFromDatacenterSources } = require('./datacenter_scraper');
const { resolveWithBrowser } = require('./browser_resolver');
const { fetchFromUpstream } = require('./upstream_relay');

const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS) || 5 * 60 * 1000; // 5min
const MAX_QUEUE = parseInt(process.env.MAX_QUEUE)    || 8;

const cache   = new Map();
const pending = new Map();
let activeScrapes = 0;

// Cache de manifests HLS (corpo do m3u8) para o proxy reutilizar
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

  const fetchPromise = (async () => {
    // 1. Fontes datacenter (VixSrc, Vidlink) — funcionam server-side no Vercel
    try {
      const streams = await fetchFromDatacenterSources(imdbId, type, season, episode);
      if (streams) { console.log('[scraper] datacenter sources OK'); setCached(key, streams); return streams; }
    } catch (e) { console.log('[scraper] datacenter sources falhou:', e.message); }

    // 2. Browser (vidsrc & cia) — o URL final é descodificado em WASM dentro do
    // player, por isso não há caminho axios. Só corre onde há Chromium: no
    // Vercel é um no-op silencioso e passamos directo ao relay.
    try {
      const streams = await resolveWithBrowser(imdbId, type, season, episode);
      if (streams) { console.log('[scraper] browser resolver OK'); setCached(key, streams); return streams; }
    } catch (e) { console.log('[scraper] browser resolver falhou:', e.message); }

    // 3. Relay para o servidor caseiro (UPSTREAM_URL) — quando as CDNs bloqueiam
    // o IP de datacenter do Vercel (VixSrc 403), o servidor de casa (IP
    // residencial) resolve e serve via o proxy /hls dele. No-op sem a var.
    try {
      const streams = await fetchFromUpstream(imdbId, type, season, episode);
      if (streams) { console.log('[scraper] upstream relay OK'); setCached(key, streams); return streams; }
    } catch (e) { console.log('[scraper] upstream relay falhou:', e.message); }

    return null;
  })().finally(() => {
    pending.delete(key);
    activeScrapes = Math.max(0, activeScrapes - 1);
  });

  pending.set(key, fetchPromise);
  const streams = await fetchPromise;
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

module.exports = { fetchVideoSource, getStatus, invalidateCache, cacheKey, getMfCache, setMfCache };
