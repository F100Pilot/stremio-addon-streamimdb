'use strict';
const axios = require('axios');
const { fetchFromProviders } = require('./providers');
const { fetchFromAltSources } = require('./alt_scraper');
const { fetchFromDatacenterSources } = require('./datacenter_scraper');
const { resolveVidsrc } = require('./vidsrc_resolver');

const AUDIO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

// ISO 639-2 → 639-1: os manifests usam os dois formatos (LANGUAGE="ita" vs
// LANGUAGE="it"), e no título queremos sempre o código curto.
const ISO3_TO_ISO1 = {
  eng: 'en', por: 'pt', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de',
  ita: 'it', dut: 'nl', nld: 'nl', rus: 'ru', ara: 'ar', tur: 'tr', pol: 'pl',
  rum: 'ro', ron: 'ro', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', hin: 'hi',
  cze: 'cs', ces: 'cs', dan: 'da', gre: 'el', ell: 'el', fin: 'fi', hun: 'hu',
  nor: 'no', swe: 'sv',
};
const NAME_TO_ISO1 = {
  english: 'en', portuguese: 'pt', spanish: 'es', french: 'fr', german: 'de',
  italian: 'it', dutch: 'nl', russian: 'ru', arabic: 'ar', turkish: 'tr',
  polish: 'pl', romanian: 'ro', japanese: 'ja', korean: 'ko', chinese: 'zh', hindi: 'hi',
};
function shortLang(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (ISO3_TO_ISO1[s]) return ISO3_TO_ISO1[s];
  if (NAME_TO_ISO1[s]) return NAME_TO_ISO1[s];
  const two = s.match(/^([a-z]{2})(?:[-_]|$)/);
  if (two) return two[1];
  for (const [name, code] of Object.entries(NAME_TO_ISO1)) if (s.includes(name)) return code;
  return null;
}

// Lê o master m3u8 de cada stream e anota `audioLangs` (códigos ISO curtos das
// faixas #EXT-X-MEDIA:TYPE=AUDIO). Devolve true se alguma tiver inglês.
//
// Serve dois propósitos de uma só leitura: decidir se vale a pena acordar o
// browser (só se ninguém tiver inglês) e alimentar o rótulo de áudio que vai
// no título do stream.
//
// Um master SEM faixas TYPE=AUDIO tem o áudio multiplexado no vídeo: não dá
// para saber a língua sem descarregar segmentos. Nesse caso fica
// `audioLangs: []` e assume-se que serve — não se paga o custo do browser nem
// se inventa um idioma no título.
async function annotateAudio(streams) {
  if (!streams || !streams.length) return false;

  await Promise.all(streams.map(async s => {
    if (!s || !s.url || s.audioLangs) return;
    s.audioLangs = [];
    try {
      const res = await axios.get(s.url, {
        headers: { 'User-Agent': AUDIO_UA, ...(s.referer ? { Referer: s.referer } : {}) },
        timeout: 8000, responseType: 'text', maxRedirects: 5, validateStatus: () => true,
      });
      const body = typeof res.data === 'string' ? res.data : '';
      const langs = [];
      for (const line of body.split('\n')) {
        const t = line.trim();
        if (!/^#EXT-X-MEDIA:.*TYPE=AUDIO/i.test(t)) continue;
        const code = shortLang(t.match(/LANGUAGE="([^"]+)"/i)?.[1] || t.match(/NAME="([^"]+)"/i)?.[1]);
        // A faixa default primeiro: é a que o player vai usar.
        if (code && !langs.includes(code)) {
          if (/DEFAULT=YES/i.test(t)) langs.unshift(code); else langs.push(code);
        }
      }
      s.audioLangs = langs;
    } catch (e) {
      // Não conseguir ler não significa que o stream não preste: pode ser só a
      // CDN a recusar-nos este pedido. Fica sem rótulo e marcado como
      // "desconhecido" para não disparar o browser à toa.
      console.log(`[scraper] leitura de áudio falhou (${s.source || '?'}): ${e.message}`);
      s.audioUnknown = true;
    }
  }));

  return streams.some(s => s.audioLangs?.includes('en') || !s.audioLangs?.length);
}

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
    // acordar o browser quando estas fontes resolvem.
    let dcStreams = null;
    try {
      dcStreams = await fetchFromDatacenterSources(imdbId, type, season, episode);
      if (dcStreams) console.log('[scraper] datacenter sources OK');
    } catch (e) { console.log('[scraper] datacenter sources falhou:', e.message); }

    // 1b. VidSrc por browser — só quando é preciso. A VixSrc é italiana e há
    // títulos que só traz em ita/ger (ex.: Chicago Med); nesses casos vale a
    // pena pagar o custo do Chromium para ter uma opção em inglês. Se as
    // fontes rápidas já trazem inglês, o browser nem chega a arrancar.
    if (!dcStreams || !(await annotateAudio(dcStreams))) {
      console.log('[scraper] sem áudio inglês nas fontes rápidas — a tentar VidSrc (browser)');
      try {
        const vs = await resolveVidsrc(imdbId, type, season, episode);
        if (vs) {
          await annotateAudio(vs); // rótulo de idioma também para estes
          dcStreams = [...(dcStreams || []), ...vs];
        }
      } catch (e) { console.log('[scraper] VidSrc falhou:', e.message); }
    }

    if (dcStreams && dcStreams.length) { setCached(key, dcStreams); return dcStreams; }

    // 2. alt_scraper (axios rápido — falha no Turnstile mas tenta na mesma)
    try {
      const streams = await fetchFromAltSources(imdbId, type, season, episode);
      if (streams) { console.log('[scraper] alt_scraper OK'); setCached(key, streams); return streams; }
    } catch (e) { console.log('[scraper] alt_scraper falhou:', e.message); }

    // 3. movie-web providers (último recurso, lento)
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

// Devolve as legendas associadas ao título (capturadas na resolução do stream).
// Reaproveita a cache; se não houver, resolve o stream (que as popula).
async function fetchSubtitles(imdbId, type = 'movie', season = null, episode = null) {
  try {
    const result = await fetchVideoSource(imdbId, type, season, episode);
    const streams = result?.streams || [];
    for (const s of streams) {
      if (Array.isArray(s.subtitles) && s.subtitles.length) return s.subtitles;
    }
  } catch (e) {
    console.log('[subs] fetchSubtitles falhou:', e.message);
  }
  return [];
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

module.exports = { fetchVideoSource, fetchSubtitles, getStatus, invalidateCache, cacheKey, getMfCache };
