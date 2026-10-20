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

// O título mostra a resolução que o leitor vai mesmo receber: o servidor corta
// as variantes acima de MAX_STREAM_HEIGHT (ver server.js).
function capQuality(q) {
  const max = parseInt(process.env.MAX_STREAM_HEIGHT ?? '0', 10) || 0;
  const h = parseInt(q, 10);
  return max && h > max ? `${max}p` : q;
}

function makeHlsProxyUrl(streamUrl, referer, maxH) {
  const token = sign({ u: streamUrl, r: referer, ...(maxH ? { m: maxH } : {}) });
  return `${SERVER_BASE}/hls/${token}.m3u8`;
}

// Ficheiro inteiro (.mp4 do Vidlink): não é HLS, vai pela rota /file, que
// reencaminha Range/Content-Range para o player poder saltar no tempo.
function makeFileProxyUrl(fileUrl, referer) {
  const token = sign({ u: fileUrl, r: referer });
  return `${SERVER_BASE}/file/${token}.mp4`;
}

// Manifesto DASH (.mpd, Vidlink): /dash reescreve-o para os segmentos também
// passarem por nós (a CDN exige Referer, que o Stremio não manda).
function makeDashProxyUrl(mpdUrl, referer, maxH) {
  const token = sign({ u: mpdUrl, r: referer, ...(maxH ? { m: maxH } : {}) });
  return `${SERVER_BASE}/dash/${token}.mpd`;
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
      // Cada fonte acima de 720p aparece duas vezes: na resolução máxima e numa
      // entrada "720p" (mesma fonte; o servidor só deixa no manifesto as
      // variantes ≤720, que arrancam muito mais depressa nestas CDNs). Só para
      // HLS/DASH pelo nosso proxy — um ficheiro inteiro não tem variantes.
      const ALT_H = parseInt(process.env.STREAM_ALT_HEIGHT ?? '720', 10) || 0;
      const expanded = result.streams.flatMap(s => {
        const h = parseInt(s.quality, 10);
        const capavel = ALT_H && s.proxyable !== false && s.kind !== 'file' && h > ALT_H;
        return capavel ? [s, { ...s, quality: `${ALT_H}p`, maxH: ALT_H, alt: true }] : [s];
      });
      const streams = expanded.map(s => {
        const streamUrl = s.proxyable === false
          ? s.url
          : s.kind === 'file'
            ? makeFileProxyUrl(s.url, s.referer || referer)
          : s.kind === 'dash'
            ? makeDashProxyUrl(s.url, s.referer || referer, s.maxH)
            : makeHlsProxyUrl(s.url, s.referer || referer, s.maxH);

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

        // Aviso só nas entradas que a medição de débito (stream_probe.js) diz que
        // vão parar para carregar — as boas ficam como estão, sem ruído. Os
        // lentos só vão para o fim da lista, não desaparecem: continua a poder
        // escolher-se um se for a única com a língua pretendida.
        // STREAM_SPEED_LABEL=off desliga o aviso.
        const k = s.alt ? null : s.probe?.klass;   // a medição foi feita à resolução máxima
        const speedInfo = process.env.STREAM_SPEED_LABEL === 'off' ? ''
          : k === 'lento' ? ' · 🐌 lenta'
          : k === 'erro'  ? ' · ✗ falhou'
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
          title: `${titlePrefix}${capQuality(s.quality)}${srcInfo}${audioInfo}${speedInfo}`,
          ...(subtitles.length ? { subtitles } : {}),
          // Experiência (Out/2026): o Stremio Android pára depois de ler o
          // manifesto, embora o ffmpeg e o Nuvio toquem os mesmos URLs com
          // vídeo e som. Nas entradas 720p pede-se ao Stremio que passe o
          // stream pelo servidor de streaming interno dele (notWebReady), para
          // comparar com as 1080p, que ficam como estavam.
          behaviorHints: (type === 'series' || s.alt) ? {
            ...(type === 'series' ? { bingeGroup: `streamimdb-${imdbId}${s.alt ? '-720' : ''}` } : {}),
            ...(s.alt && process.env.STREMIO_NOT_WEB_READY !== 'off' ? { notWebReady: true } : {}),
          } : undefined,
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
