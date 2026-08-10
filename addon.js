'use strict';
const { addonBuilder } = require('stremio-addon-sdk');
const { fetchVideoSource, fetchSubtitles } = require('./scraper');
const { sign } = require('./proxy_token');

const BRIGHTPATH_BASE = 'https://brightpathsignals.com/embed';
const PORT = process.env.PORT || 7000;
const SERVER_BASE = (
  process.env.RENDER_EXTERNAL_URL ||
  process.env.SERVER_URL ||
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
  resources: ['stream', 'subtitles'],
  idPrefixes: ['tt']
};

const builder = new addonBuilder(manifest);

function makeHlsProxyUrl(streamUrl, referer) {
  const token = sign({ u: streamUrl, r: referer });
  return `${SERVER_BASE}/hls/${token}.m3u8`;
}

function makeSubProxyUrl(subUrl, referer) {
  const token = sign({ u: subUrl, r: referer });
  return `${SERVER_BASE}/sub/${token}.vtt`;
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

    const fallbackUrl = type === 'series'
      ? `https://streamimdb.me/embed/${imdbId}/${season}/${episode}/`
      : `https://streamimdb.me/embed/${imdbId}/`;

    let result = null;
    try {
      result = await fetchVideoSource(imdbId, type, season, episode);
    } catch (scraperErr) {
      console.error(`[handler] Erro no scraper: ${scraperErr.message}`);
    }
    // Sem retry cego aqui: re-executaria toda a cadeia e amplificava a carga.
    // A dedup/cache do scraper trata dos casos transitórios.

    if (result && result.type === 'direct') {
      const streams = result.streams.map(s => {
        const streamUrl = s.proxyable === false
          ? s.url
          : makeHlsProxyUrl(s.url, s.referer || referer);

        // Indica disponibilidade de legendas PT/EN (idiomas que mais interessam).
        const langs = (s.subtitles || []).map(t => (t.lang || '').toLowerCase());
        const subFlags = [];
        if (langs.some(l => l.startsWith('pt'))) subFlags.push('PT');
        if (langs.some(l => l.startsWith('en'))) subFlags.push('EN');
        const subInfo = subFlags.length ? ` · 🔤 ${subFlags.join('/')}` : '';

        const titlePrefix = type === 'series' ? `S${season}E${episode} · ` : '';
        // A fonte vai no título porque cada uma traz faixas de áudio
        // diferentes (a VixSrc é italiana e há títulos sem inglês) — assim
        // dá para escolher a certa na lista do Stremio.
        const srcInfo = s.source ? ` · ${s.source}` : '';
        return {
          url:   streamUrl,
          name:  'StreamIMDb',
          title: `${titlePrefix}${s.quality}${srcInfo}${subInfo}`,
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

builder.defineSubtitlesHandler(async (args) => {
  try {
    const parts = args.id.split(':');
    const imdbId = parts[0];
    const type = parts.length > 1 ? 'series' : 'movie';
    const season = parts[1] || null;
    const episode = parts[2] || null;

    const referer = type === 'series'
      ? `${BRIGHTPATH_BASE}/tv/${imdbId}/${season}/${episode}`
      : `${BRIGHTPATH_BASE}/movie/${imdbId}`;

    const subs = await fetchSubtitles(imdbId, type, season, episode);
    if (!subs || !subs.length) return { subtitles: [] };

    const seen = new Set();
    const subtitles = subs.map((s, i) => {
      // 'lang' tem de ser um código de idioma válido (ISO 639-1/2) — o Stremio
      // usa-o para mostrar a bandeira/nome. Usar texto livre (ex.: o NAME="3-eng"
      // bruto do m3u8) faz o Stremio rejeitar a faixa ("erro no track"/"no tracks").
      const lang = s.lang || 'und';
      let id = `${lang}-${i}`;
      while (seen.has(id)) id = `${id}_`;
      seen.add(id);
      return { id, lang, url: makeSubProxyUrl(s.url, s.referer || referer) };
    });
    console.log(`[handler] ${subtitles.length} legenda(s) para ${args.id}`);
    return { subtitles };
  } catch (err) {
    console.error(`[handler/subs] Erro: ${err.message}`);
    return { subtitles: [] };
  }
});

module.exports = builder.getInterface();
