'use strict';
const { fetchFromProviders } = require('./providers');
const { fetchFromAltSources } = require('./alt_scraper');
const { fetchFromDatacenterSources } = require('./datacenter_scraper');
const { resolvePuppeteer, circuitState } = require('./puppeteer_resolver');

const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS) || 5 * 60 * 1000;
const MAX_QUEUE = parseInt(process.env.MAX_QUEUE)    || 8;

const cache   = new Map();
const pending = new Map();
let activeScrapes = 0;

const mfCache = new Map();
const MF_TTL  = 3 * 60 * 1000;

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
    // 1. datacenter_scraper (VixSrc, Vidlink) — só axios, mais rápido; URLs
    // entregues directo ao cliente (proxyable:false), que tenta com o seu
    // próprio IP residencial. Vale sempre a pena tentar primeiro: evita
    // acordar o Puppeteer quando estas fontes resolvem.
    try {
      const streams = await fetchFromDatacenterSources(imdbId, type, season, episode);
      if (streams) { console.log('[scraper] datacenter sources OK'); setCached(key, streams); return streams; }
    } catch (e) { console.log('[scraper] datacenter sources falhou:', e.message); }

    // 2. alt_scraper (axios rápido — falha no Turnstile mas tenta na mesma)
    try {
      const streams = await fetchFromAltSources(imdbId, type, season, episode);
      if (streams) { console.log('[scraper] alt_scraper OK'); setCached(key, streams); return streams; }
    } catch (e) { console.log('[scraper] alt_scraper falhou:', e.message); }

    // 3. Puppeteer (passa o Turnstile via headful + Xvfb)
    console.log('[scraper] A tentar resolver via browser (Puppeteer)...');
    try {
      const streams = await resolvePuppeteer(imdbId, type, season, episode);
      if (streams) { console.log('[scraper] Puppeteer OK'); setCached(key, streams); return streams; }
    } catch (e) { console.log('[scraper] Puppeteer falhou:', e.message); }

    // 4. movie-web providers (último recurso, lento)
    console.log('[scraper] A tentar movie-web providers...');
    try {
      const streams = await fetchFromProviders(imdbId, type, season, episode);
      if (streams) { console.log('[scraper] movie-web providers OK'); setCached(key, streams); return streams; }
    } catch (e) { console.log('[scraper] movie-web providers falhou:', e.message); }

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
    puppeteerCircuit: circuitState(),
  };
}

module.exports = { fetchVideoSource, getStatus, invalidateCache, cacheKey, getMfCache };
