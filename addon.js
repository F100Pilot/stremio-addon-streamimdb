'use strict';
const { addonBuilder } = require('stremio-addon-sdk');
const { fetchVideoSource } = require('./scraper');
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
  version: '1.5.0',
  name: 'StreamIMDb Connector',
  description: 'Stream movies and series via streamimdb.me natively inside Stremio.',
  logo: 'https://raw.githubusercontent.com/F100Pilot/stremio-addon-streamimdb/main/icon.png',
  types: ['movie', 'series'],
  catalogs: [],
  resources: ['stream'],
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

        // Idiomas de ÁUDIO (faixas do master m3u8, anotadas em scraper.js).
        // É esta a informação que interessa para escolher o stream — a VixSrc
        // é italiana e há títulos que só traz em ita/ger. Vazio quando o áudio
        // vem multiplexado no vídeo: aí a língua não é determinável sem
        // descarregar segmentos, e é preferível não mostrar rótulo nenhum a
        // mostrar um que pode estar errado.
        // O asterisco marca idioma inferido do TMDB (áudio multiplexado, sem
        // faixas legíveis no manifesto) — distingue-o de um valor lido.
        const audio = (s.audioLangs || []).map(l => l.toUpperCase());
        const audioInfo = audio.length
          ? ` · 🔊 ${audio.join('/')}${s.audioInferred ? '*' : ''}`
          : '';

        const titlePrefix = type === 'series' ? `S${season}E${episode} · ` : '';
        // A fonte vai no título porque cada uma traz faixas diferentes — assim
        // dá para escolher a certa na lista do Stremio.
        const srcInfo = s.source ? ` · ${s.source}` : '';

        // Legendas ligadas a ESTE stream. Cada fonte é um encode diferente, e
        // as legendas de uma não sincronizam com o vídeo da outra — por isso
        // vão aqui e não no recurso global `subtitles`, que não sabe qual dos
        // streams está a tocar e servia sempre as mesmas.
        const seen = new Set();
        const subtitles = (s.subtitles || []).map((t, i) => {
          const lang = t.lang || 'und';
          // O `id` é o que o Stremio mostra na lista de legendas. Nas externas
          // inclui a % de correspondência ao release, para se perceber à
          // partida quais têm hipótese de estar em sincronia.
          let id = t.name ? `${lang} · ${t.name}` : `${lang}-${i}`;
          while (seen.has(id)) id = `${id}_`;
          seen.add(id);
          // As legendas externas não precisam (nem devem levar) o referer da
          // CDN de vídeo — vêm de outro sítio.
          const ref = t.name ? null : (t.referer || s.referer || referer);
          return { id, lang, url: makeSubProxyUrl(t.url, ref) };
        });

        return {
          url:   streamUrl,
          name:  'StreamIMDb',
          title: `${titlePrefix}${s.quality}${srcInfo}${audioInfo}`,
          ...(subtitles.length ? { subtitles } : {}),
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
