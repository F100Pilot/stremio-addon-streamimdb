'use strict';
const axios = require('axios');
const { convertImdbToTmdb } = require('./tmdb');
const { fetchFromDatacenterSources } = require('./datacenter_scraper');
const { resolveWithBrowser } = require('./browser_resolver');
const { fetchSubtitlesForRelease } = require('./subtitles_os');

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

// Rótulo da resolução máxima anunciada no master (#EXT-X-STREAM-INF).
// Mesmos limiares do detectQuality em datacenter_scraper.js, para os títulos
// ficarem consistentes entre fontes.
const RES_THRESHOLDS = [[2160, '4K'], [1440, '1440p'], [1080, '1080p'], [720, '720p'], [480, '480p']];
function maxQualityLabel(m3u8) {
  let maxH = 0;
  for (const line of m3u8.split('\n')) {
    const m = line.match(/RESOLUTION=\d+x(\d+)/i);
    if (m) maxH = Math.max(maxH, parseInt(m[1], 10));
  }
  if (!maxH) return null;
  for (const [min, label] of RES_THRESHOLDS) if (maxH >= min) return label;
  return `${maxH}p`;
}

// Lê o master m3u8 de cada stream, uma só vez, e anota:
//   - `audioLangs` — códigos ISO das faixas #EXT-X-MEDIA:TYPE=AUDIO
//   - `quality`    — resolução máxima, quando a fonte não a soube dizer
// Devolve true se algum stream serve para quem quer inglês.
//
// Um master SEM faixas TYPE=AUDIO tem o áudio multiplexado no vídeo e a língua
// não é legível no manifesto. Nesses casos usa-se o idioma original do título
// (TMDB) como estimativa, marcada com `audioInferred` — o título mostra-a com
// asterisco para não a fazer passar por leitura directa. É uma estimativa boa
// para releases WEB-DL/BluRay originais, mas erra numa dobragem.
async function annotateStreams(streams, originalLanguage = null) {
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

      // Qualidade máxima, da mesma leitura do master. Fontes que já a trazem
      // (VixSrc calcula-a em masterInfo) ficam intactas; o VidSrc chega aqui
      // com 'Auto' porque o resolver captura o URL da rede sem ler o conteúdo.
      if (!s.quality || s.quality === 'Auto') {
        const q = maxQualityLabel(body);
        if (q) s.quality = q;
      }
      if (!langs.length && originalLanguage) {
        s.audioLangs = [originalLanguage];
        s.audioInferred = true; // veio do TMDB, não do manifesto
      }
    } catch (e) {
      // Não conseguir ler não significa que o stream não preste: pode ser só a
      // CDN a recusar-nos este pedido. Fica sem rótulo e marcado como
      // "desconhecido" para não disparar o browser à toa.
      console.log(`[scraper] leitura de áudio falhou (${s.source || '?'}): ${e.message}`);
      s.audioUnknown = true;
    }
  }));

  // Para decidir se vale a pena acordar o browser, um idioma inferido ou
  // ilegível conta como "serve": inferência não é prova de que falta inglês, e
  // lançar o Chromium com base nela seria pagar caro por um palpite.
  return streams.some(s =>
    s.audioLangs?.includes('en') || s.audioInferred || s.audioUnknown || !s.audioLangs?.length);
}

// Acrescenta legendas externas aos streams que não têm nenhumas.
//
// Deliberadamente conservador: quem já traz legendas (VixSrc, do próprio
// manifesto) fica intacto, porque essas estão garantidamente em sincronia.
// Qualquer falha aqui é engolida — legendas são um extra, não podem impedir
// o stream de ser devolvido.
async function addExternalSubtitles(streams, imdbId, type, season, episode) {
  const semLegendas = streams.filter(s => !s.subtitles || !s.subtitles.length);
  if (!semLegendas.length) return;

  for (const s of semLegendas) {
    try {
      const subs = await fetchSubtitlesForRelease(imdbId, type, season, episode, s.releaseName);
      if (subs.length) {
        s.subtitles = subs;
        s.subsExternal = true; // usado no título para assinalar a origem
        console.log(`[scraper] ${subs.length} legenda(s) externa(s) para ${s.source || '?'}`);
      }
    } catch (e) {
      console.log(`[scraper] legendas externas falharam (${s.source || '?'}): ${e.message}`);
    }
  }
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

    // Idioma original do título — estimativa para os streams cujo áudio vem
    // multiplexado (ver `annotateStreams`). Falha em silêncio: sem isto os
    // streams ficam apenas sem rótulo.
    let origLang = null;
    try { origLang = (await convertImdbToTmdb(imdbId))?.originalLanguage || null; }
    catch (e) { console.log('[scraper] idioma original indisponível:', e.message); }

    // 1b. Browser — só quando é preciso. A VixSrc é italiana e há títulos que
    // só traz em ita/ger (ex.: Chicago Med); nesses casos vale a pena pagar o
    // custo do Chromium para ter uma opção em inglês. Se as fontes rápidas já
    // trazem inglês, o browser nem chega a arrancar.
    //
    // O `resolveVidsrc` foi substituído pelo `resolveWithBrowser`, que tenta
    // uma lista de fontes em sequência em vez de só o vidsrc.in — o vidsrc.in
    // continua a ser a primeira da lista e usa exactamente a mesma cadeia.
    if (!dcStreams || !(await annotateStreams(dcStreams, origLang))) {
      console.log('[scraper] sem áudio inglês nas fontes rápidas — a tentar o browser');
      try {
        const vs = await resolveWithBrowser(imdbId, type, season, episode);
        if (vs) {
          await annotateStreams(vs, origLang); // idioma + qualidade também para estes
          dcStreams = [...(dcStreams || []), ...vs];
        }
      } catch (e) { console.log('[scraper] browser resolver falhou:', e.message); }
    }

    // 1c. Legendas externas, só para os streams que NÃO trazem as suas.
    // Fontes com legendas próprias (VixSrc) não são tocadas — as delas vêm do
    // manifesto e estão garantidamente em sincronia.
    if (dcStreams && dcStreams.length) {
      await addExternalSubtitles(dcStreams, imdbId, type, season, episode);
      setCached(key, dcStreams);
      return dcStreams;
    }

    // Não há passo 2 nem 3: o alt_scraper (streamimdb.me, morto pelo Cloudflare
    // Turnstile) e os movie-web providers (11 providers, todos mortos) foram
    // removidos. Só eram alcançados quando tudo o resto falhava, e nessa altura
    // custavam até 30s de timeout para não devolver nada.
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

module.exports = { fetchVideoSource, getStatus, invalidateCache, cacheKey, getMfCache };
