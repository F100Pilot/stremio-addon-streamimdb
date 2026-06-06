'use strict';
const { makeProviders, makeStandardFetcher, targets } = require('@movie-web/providers');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function createFetcher() {
  return makeStandardFetcher(async (url, init) => {
    const response = await fetch(url, {
      ...init,
      headers: {
        ...init?.headers,
        'User-Agent': UA,
      },
    });
    return {
      ok: response.ok,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      text: () => response.text(),
      json: () => response.json(),
    };
  });
}

const providers = makeProviders({
  fetcher: createFetcher(),
  target: targets.NATIVE,
});

const TIMEOUT_MS = 15000;

async function searchStreams(tmdbId, type, season, episode) {
  const media = {
    type: type === 'series' ? 'show' : 'movie',
    tmdbId: String(tmdbId),
    releaseYear: undefined,
    title: undefined,
  };

  if (type === 'series') {
    media.seasonNumber = parseInt(season, 10);
    media.episodeNumber = parseInt(episode, 10);
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const output = await Promise.race([
      providers.runAll({ media }),
      new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('timeout'))))
    ]);

    clearTimeout(timeoutId);

    if (!output?.sources?.length) {
      console.log('[providers] Nenhuma fonte encontrada');
      return null;
    }

    const streams = output.sources.map(source => {
      let url = source.url || source.playlist;
      let quality = 'Auto';

      if (source.qualities) {
        const keys = Object.keys(source.qualities).filter(k => k !== 'unknown');
        if (keys.length > 0) {
          const bestKey = keys.sort((a, b) => parseInt(b) - parseInt(a))[0];
          url = source.qualities[bestKey]?.url;
          quality = bestKey;
        }
      }

      const headers = source.headers || source.preferredHeaders || {};

      return {
        url,
        quality,
        proxyable: false,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        captions: source.captions?.length > 0 ? source.captions : undefined,
      };
    }).filter(s => s.url);

    console.log(`[providers] ${streams.length} stream(s) encontrado(s)`);
    return streams;

  } catch (err) {
    console.log(`[providers] Erro: ${err.message}`);
    return null;
  }
}

async function convertImdbToTmdb(imdbId) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    console.log('[providers] TMDB_API_KEY não configurada');
    return null;
  }
  const url = `https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id&api_key=${apiKey}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    return data?.movie_results?.[0]?.id || data?.tv_results?.[0]?.id || null;
  } catch {
    return null;
  }
}

async function fetchFromProviders(imdbId, type, season, episode) {
  const tmdbId = await convertImdbToTmdb(imdbId);
  if (!tmdbId) {
    console.log('[providers] Falha ao converter IMDb → TMDB');
    return null;
  }
  return searchStreams(tmdbId, type, season, episode);
}

module.exports = { fetchFromProviders };