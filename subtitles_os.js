'use strict';
// Legendas externas do OpenSubtitles, escolhidas pelo NOME DO RELEASE.
//
// Porquê: fontes como o VidSrc não trazem legendas nenhumas, e os addons de
// legendas genéricos servem a primeira legenda que encontram para o episódio —
// que quase nunca corresponde ao encode que está a tocar, daí a
// dessincronização. Aqui filtramos pelo release (ex.: "...1080p.WEB-DL...-SbR"),
// que é o que dá sincronia fiável.
//
// Usa a API pública `rest.opensubtitles.org` (sem chave). Se estiver em baixo
// ou mudar, tudo falha em silêncio e os streams ficam apenas sem legendas —
// nunca deixa de devolver o vídeo.
const axios = require('axios');

// A API exige um User-Agent identificável. `TemporaryUserAgent` é o valor
// tolerado para uso não registado; quem tiver um UA próprio define OS_UA.
const OS_UA   = process.env.OPENSUBTITLES_UA || 'TemporaryUserAgent';
const OS_BASE = 'https://rest.opensubtitles.org/search';
const ENABLED = process.env.OPENSUBTITLES !== 'off';
const LANGS   = (process.env.OPENSUBTITLES_LANGS || 'eng,por').split(',').map(s => s.trim()).filter(Boolean);
const TIMEOUT = parseInt(process.env.OPENSUBTITLES_TIMEOUT_MS) || 8000;
const MAX_PER_LANG = parseInt(process.env.OPENSUBTITLES_MAX) || 2;

const ISO3_TO_ISO1 = {
  eng: 'en', por: 'pt', pob: 'pt-BR', spa: 'es', fre: 'fr', ger: 'de', ita: 'it',
  dut: 'nl', rus: 'ru', ara: 'ar', tur: 'tr', pol: 'pl', rum: 'ro', jpn: 'ja',
  kor: 'ko', chi: 'zh', hin: 'hi', swe: 'sv', dan: 'da', nor: 'no', fin: 'fi',
};

// Divide um nome de release nos seus tokens significativos, ignorando
// pontuação e o ruído de S01E02/ano que todas as versões partilham.
const NOISE = /^(s\d+e\d+|\d{4}|the|and|of|a|mkv|mp4|avi)$/i;
function tokens(name) {
  return String(name || '')
    .split('/').pop()                    // caminho → só o ficheiro
    .replace(/\.[a-z0-9]{2,4}$/i, '')    // tira a extensão
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !NOISE.test(t));
}

// Quanto é que este candidato se parece com o release que temos?
// Pontua o que distingue versões: grupo, fonte (WEB-DL/BluRay), resolução,
// codec. Um nome idêntico dá pontuação máxima.
function score(candidate, target) {
  if (!target) return 0;
  const a = new Set(tokens(candidate));
  const b = tokens(target);
  if (!a.size || !b.length) return 0;
  const common = b.filter(t => a.has(t)).length;
  return common / b.length;
}

async function searchLang(imdbId, type, season, episode, lang) {
  // O endpoint quer o id sem o "tt".
  const id = String(imdbId).replace(/^tt/, '');
  const parts = type === 'series'
    ? [`episode-${episode}`, `imdbid-${id}`, `season-${season}`, `sublanguageid-${lang}`]
    : [`imdbid-${id}`, `sublanguageid-${lang}`];
  // Os segmentos têm de ir por ordem alfabética nesta API.
  const url = `${OS_BASE}/${parts.sort().join('/')}`;

  const res = await axios.get(url, {
    headers: { 'User-Agent': OS_UA, Accept: 'application/json' },
    timeout: TIMEOUT, validateStatus: () => true,
  });
  if (res.status !== 200 || !Array.isArray(res.data)) {
    console.log(`[os] ${lang}: HTTP ${res.status}`);
    return [];
  }
  return res.data;
}

// Devolve [{url, lang, name}] prontas a entrar no `subtitles` de um stream.
// `releaseName` é opcional: sem ele não há como distinguir versões, por isso
// cai-se no mais descarregado (o menos mau) em vez de arriscar às cegas.
async function fetchSubtitlesForRelease(imdbId, type, season, episode, releaseName) {
  if (!ENABLED) return [];

  const out = [];
  for (const lang of LANGS) {
    try {
      const results = await searchLang(imdbId, type, season, episode, lang);
      if (!results.length) continue;

      const ranked = results
        .map(r => ({
          r,
          // O release aparece ora no nome do ficheiro, ora no do "filme".
          match: Math.max(
            score(r.SubFileName, releaseName),
            score(r.MovieReleaseName, releaseName),
          ),
          downloads: parseInt(r.SubDownloadsCnt, 10) || 0,
        }))
        // Empates de correspondência desempatam pelos downloads (proxy de
        // qualidade), mas a correspondência de release manda sempre.
        .sort((x, y) => (y.match - x.match) || (y.downloads - x.downloads));

      const best = ranked.slice(0, MAX_PER_LANG);
      for (const { r, match } of best) {
        const link = r.SubDownloadLink || r.ZipDownloadLink;
        if (!link) continue;
        const iso1 = ISO3_TO_ISO1[(r.SubLanguageID || lang).toLowerCase()] || lang.slice(0, 2);
        out.push({
          url: link,                       // .gz — o proxy /sub descomprime
          lang: iso1,
          // A percentagem é honesta sobre o quão certa é a correspondência:
          // 100% = mesmo release, valores baixos = palpite.
          name: `OpenSubtitles ${Math.round(match * 100)}%`,
          matchScore: match,
        });
      }
      console.log(`[os] ${lang}: ${results.length} resultado(s), melhor match ${Math.round((ranked[0]?.match || 0) * 100)}%`);
    } catch (e) {
      console.log(`[os] ${lang} falhou: ${e.message}`);
    }
  }
  return out;
}

module.exports = { fetchSubtitlesForRelease };
