'use strict';
const { addonBuilder } = require('stremio-addon-sdk');
const { fetchVideoSource } = require('./scraper');
const { sign } = require('./proxy_token');

const BRIGHTPATH_BASE = 'https://brightpathsignals.com/embed';
const PORT = process.env.PORT || 7000;
const SERVER_BASE = (
  process.env.RENDER_EXTERNAL_URL ||
  process.env.SERVER_URL ||
  (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`) ||
  `http://localhost:${PORT}`
).replace(/\/$/, '');

const manifest = {
  id: 'org.local.streamimdb',
  version: '1.4.1',
  name: 'StreamIMDb Connector',
  description: 'Stream movies and series via streamimdb.me natively inside Stremio.',
  logo: 'https://raw.githubusercontent.com/F100Pilot/stremio-addon-streamimdb/main/icon.png',
  types: ['movie', 'series'],
  catalogs: [],
  resources: ['stream'],
  idPrefixes: ['tt']
};

const builder = new addonBuilder(manifest);

function makeHlsProxyUrl(streamUrl, referer, meta) {
  const token = sign({ u: streamUrl, r: referer, m: meta });
  return `${SERVER_BASE}/hls/${token}.m3u8`;
}

builder.defineStreamHandler(async (args) => {
  try {
    const parts = args.id.split(':');
    const imdbId = parts[0];
    const type = parts.length > 1 ? 'series' : 'movie';
    const season = parts[1] || null;
    const episode = parts[2] || null;

    const referer = type === 'series'
      ? `${BRIGHTPATH_BASE}/tv/${imdbId}/${season}/${episode}`
      : `${BRIGHTPATH_BASE}/movie/${imdbId}`;

    // Último recurso: abrir o embed no browser do utilizador. Apontava para o
    // streamimdb.me, que morreu com o Cloudflare Turnstile — mandava as pessoas
    // para uma página que já não dá vídeo. O vidsrc.in é a fonte principal do
    // browser_resolver e funciona num browser normal.
    const fallbackUrl = type === 'series'
      ? `https://vidsrc.in/embed/tv/${imdbId}/${season}-${episode}`
      : `https://vidsrc.in/embed/movie/${imdbId}`;

    let result = null;
    try {
      result = await fetchVideoSource(imdbId, type, season, episode);
    } catch (scraperErr) {
      console.error(`[handler] Erro no scraper: ${scraperErr.message}`);
    }
    // Sem retry cego aqui: re-executaria toda a cadeia e amplificava a carga.
    // A dedup/cache do scraper trata dos casos transitórios.

    if (result && result.type === 'direct') {
      const meta = { imdbId, type, season, episode };
      const streams = result.streams.map(s => {
        const streamUrl = s.proxyable === false
          ? s.url
          : makeHlsProxyUrl(s.url, s.referer || referer, meta);
        return {
          url:   streamUrl,
          name:  'StreamIMDb',
          title: type === 'series' ? `S${season}E${episode} · ${s.quality}` : s.quality,
          behaviorHints: type === 'series' ? { bingeGroup: `streamimdb-${imdbId}` } : undefined,
        };
      });
      return { streams };
    }

    return {
      streams: [{
        externalUrl: fallbackUrl,
        name:  'StreamIMDb',
        title: 'No stream available',
      }]
    };
  } catch (err) {
    console.error(`[handler] Erro inesperado: ${err.message}`);
    return { streams: [] };
  }
});

module.exports = builder.getInterface();
