'use strict';
// Conversão IMDb → TMDB.
//
// Vivia no providers.js (fallback movie-web). Quando esse módulo foi removido
// — os 11 providers estavam todos mortos — esta função teve de sair de lá:
// é usada pelo datacenter_scraper (VixSrc e Vidlink indexam por TMDB, não por
// IMDb), pelo browser_resolver e pelo endpoint /diag/sources.

const TTL_MS = parseInt(process.env.TMDB_CACHE_TTL_MS) || 60 * 60 * 1000; // 1h

// O mesmo título é pedido várias vezes por sessão (uma por fonte tentada) e a
// resposta do TMDB não muda. Cache simples evita gastar quota à toa.
const cache = new Map();

async function convertImdbToTmdb(imdbId) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    console.log('[tmdb] TMDB_API_KEY não configurada');
    return null;
  }

  const hit = cache.get(imdbId);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.value;

  const url = `https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id&api_key=${apiKey}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const result = data?.movie_results?.[0] || data?.tv_results?.[0] || null;
    if (!result) return null;
    const value = {
      id: result.id,
      title: result.title || result.name || '',
      releaseYear: parseInt((result.release_date || result.first_air_date || '').split('-')[0]) || undefined,
      // Idioma original do título (ISO 639-1). Usado para rotular streams cujo
      // áudio vem multiplexado no vídeo, onde a língua não é legível no
      // manifesto — ver `annotateStreams` em scraper.js.
      originalLanguage: result.original_language || null,
    };
    cache.set(imdbId, { value, ts: Date.now() });
    return value;
  } catch {
    return null;
  }
}

module.exports = { convertImdbToTmdb };
