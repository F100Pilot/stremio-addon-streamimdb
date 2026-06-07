'use strict';
// Fontes que funcionam a partir de IPs de datacenter (Vercel) — só axios,
// sem browser/Puppeteer. Ao contrário do streamimdb.me/Cloudflare Turnstile,
// estas não bloqueiam pedidos server-side.
//
// 1. VixSrc (vixsrc.to)  — extrai master m3u8 via token da página embed
// 2. Vidlink (vidlink.pro) — API que devolve playlist directa
//
// Ambas usam TMDB id, por isso convertemos IMDb → TMDB primeiro.
const axios = require('axios');
const { convertImdbToTmdb } = require('./providers');

const TIMEOUT = 10000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

// ── Legendas ─────────────────────────────────────────────────────────────────
const LANG_MAP = {
  english: 'en', portuguese: 'pt', 'portuguese (brazil)': 'pt-BR', 'brazilian portuguese': 'pt-BR',
  brazilian: 'pt-BR', spanish: 'es', 'spanish (latin america)': 'es-419', french: 'fr',
  german: 'de', italian: 'it', dutch: 'nl', russian: 'ru', arabic: 'ar', turkish: 'tr',
  polish: 'pl', romanian: 'ro', japanese: 'ja', korean: 'ko', chinese: 'zh', hindi: 'hi',
};
function normalizeLang(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (LANG_MAP[s]) return LANG_MAP[s];
  if (/^[a-z]{2}(-[a-z0-9]{2,4})?$/i.test(s)) return s;
  for (const [name, code] of Object.entries(LANG_MAP)) if (s.includes(name)) return code;
  return s || null;
}

// Extrai legendas do HTML embed do VixSrc. O player guarda-as num array JSON
// (ex.: "subtitles":[{"url":"...","lang":"English"}] ou playerjs tracks).
// Scan abrangente + log p/ diagnóstico do formato real.
// VTTs que NÃO são legendas (miniaturas/storyboard de pré-visualização).
const NOT_A_SUB_RE = /thumbnail|storyboard|sprite|preview|seek|chapters?/i;

function extractSubsFromHtml(html, baseUrl) {
  const subs = new Map();
  if (!html) return [];
  const add = (rawUrl, lang) => {
    let abs; try { abs = new URL(rawUrl.replace(/\\\//g, '/'), baseUrl).href; } catch { abs = rawUrl; }
    if (NOT_A_SUB_RE.test(abs)) return; // ignora thumbnails/storyboard .vtt
    if (!subs.has(abs)) subs.set(abs, { url: abs, lang: normalizeLang(lang) });
  };

  // 1. Objectos JSON com url + lang/label/language (vários formatos).
  const objRe = /\{[^{}]*?["']?(?:url|file|src)["']?\s*:\s*["']([^"']+\.(?:vtt|srt)[^"']*)["'][^{}]*?\}/gi;
  let m;
  while ((m = objRe.exec(html))) {
    const lang = m[0].match(/["']?(?:lang|language|label|name|srclang)["']?\s*:\s*["']([^"']+)["']/i)?.[1];
    add(m[1], lang);
  }

  // 2. Fallback: quaisquer URLs .vtt/.srt soltas no HTML.
  const urlRe = /["'(]((?:https?:)?\/\/[^"'()\s]+\.(?:vtt|srt)(?:\?[^"'()\s]*)?)["')]/gi;
  while ((m = urlRe.exec(html))) add(m[1], null);

  const out = [...subs.values()];
  if (out.length) console.log(`[dc:vixsrc] ${out.length} legenda(s) extraída(s) do embed`);
  return out;
}

// Busca o master m3u8 e extrai faixas #EXT-X-MEDIA:TYPE=SUBTITLES → [{url, lang}].
async function subsFromMaster(masterUrl, referer) {
  try {
    const res = await axios.get(masterUrl, {
      headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) },
      timeout: TIMEOUT, responseType: 'text', maxRedirects: 5, validateStatus: s => s < 500,
    });
    const body = typeof res.data === 'string' ? res.data : '';
    if (!body.includes('#EXT-X-MEDIA')) return [];
    const out = [];
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!/^#EXT-X-MEDIA:.*TYPE=SUBTITLES/i.test(t)) continue;
      const uri = t.match(/URI="([^"]+)"/)?.[1];
      if (!uri) continue;
      const lang = t.match(/LANGUAGE="([^"]+)"/i)?.[1] || t.match(/NAME="([^"]+)"/i)?.[1];
      let abs; try { abs = new URL(uri, masterUrl).href; } catch { abs = uri; }
      out.push({ url: abs, lang: normalizeLang(lang) });
    }
    if (out.length) console.log(`[dc:vixsrc] ${out.length} legenda(s) no master m3u8`);
    return out;
  } catch (e) { console.log('[dc:vixsrc] subsFromMaster erro:', e.message); return []; }
}

// ── VixSrc ─────────────────────────────────────────────────────────────────
const VIX_BASE = 'https://vixsrc.to';
const VIX_HEADERS = {
  'User-Agent': UA,
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': VIX_BASE,
  'Origin': VIX_BASE,
};

async function tryVixsrc(tmdbId, type, season, episode) {
  const apiUrl = type === 'series'
    ? `${VIX_BASE}/api/tv/${tmdbId}/${season}/${episode}`
    : `${VIX_BASE}/api/movie/${tmdbId}`;

  try {
    // Passo 1: API → { src: "/embed/..." }
    const api = await axios.get(apiUrl, { headers: VIX_HEADERS, timeout: TIMEOUT, validateStatus: s => s < 500 });
    if (api.status !== 200 || !api.data || !api.data.src) {
      console.log('[dc:vixsrc] sem src na API');
      return null;
    }

    // Passo 2: página embed (HTML)
    const embed = await axios.get(VIX_BASE + api.data.src, {
      headers: { ...VIX_HEADERS, Accept: 'text/html,application/xhtml+xml,*/*' },
      timeout: TIMEOUT, responseType: 'text', validateStatus: s => s < 500,
    });
    if (embed.status !== 200) { console.log('[dc:vixsrc] embed HTTP', embed.status); return null; }
    const html = typeof embed.data === 'string' ? embed.data : '';

    // Passo 3: extrair token, expires, playlist
    const token    = html.match(/token["']\s*:\s*["']([^"']+)/)?.[1];
    const expires  = html.match(/expires["']\s*:\s*["']([^"']+)/)?.[1];
    const playlist = html.match(/url\s*:\s*["']([^"']+)/)?.[1];
    if (!token || !expires || !playlist) { console.log('[dc:vixsrc] token/playlist não encontrados'); return null; }
    if (parseInt(expires, 10) * 1000 - 60000 < Date.now()) { console.log('[dc:vixsrc] token expirado'); return null; }

    // Passo 4: master URL
    const sep = playlist.includes('?') ? '&' : '?';
    const masterUrl = `${playlist}${sep}token=${token}&expires=${expires}&h=1`;
    console.log(`[dc:vixsrc] ✓ master: ${masterUrl.substring(0, 70)}...`);

    // Legendas: tenta o HTML embed e, se nada, o master m3u8 (#EXT-X-MEDIA).
    let subtitles = extractSubsFromHtml(html, VIX_BASE);
    if (!subtitles.length) subtitles = await subsFromMaster(masterUrl, VIX_BASE + '/');
    subtitles = subtitles.map(s => ({ ...s, referer: VIX_BASE + '/' }));
    if (!subtitles.length) console.log('[dc:vixsrc] sem legendas (nem embed nem master) — fonte pode não ter');

    // proxyable:false — entregamos o URL directo da CDN. O nosso proxy corre
    // num IP de datacenter do Vercel, que a CDN bloqueia com 403 (mesmo anti-bot
    // que bloqueia a API). O cliente Stremio corre no IP residencial do
    // utilizador, que tem mais probabilidade de passar.
    return [{ url: masterUrl, quality: 'Auto', proxyable: false, referer: apiUrl, subtitles }];
  } catch (e) {
    console.log(`[dc:vixsrc] erro: ${e.message}`);
    return null;
  }
}

// ── Vidlink ────────────────────────────────────────────────────────────────
const VIDLINK_REF = 'https://vidlink.pro';

async function tryVidlink(tmdbId, type, season, episode) {
  try {
    // Passo 1: encriptar o TMDB id
    const enc = await axios.get(
      `https://enc-dec.app/api/enc-vidlink?text=${encodeURIComponent(String(tmdbId))}`,
      { timeout: 8000, validateStatus: s => s < 500 },
    );
    const encoded = enc.data && enc.data.result;
    if (!encoded) { console.log('[dc:vidlink] encriptação sem resultado'); return null; }

    // Passo 2: API de stream
    const apiUrl = type === 'series'
      ? `${VIDLINK_REF}/api/b/tv/${encoded}/${season}/${episode}?multiLang=0`
      : `${VIDLINK_REF}/api/b/movie/${encoded}?multiLang=0`;
    const res = await axios.get(apiUrl, {
      headers: { 'User-Agent': UA, Referer: VIDLINK_REF },
      timeout: 8000, validateStatus: s => s < 500,
    });
    const playlist = res.data && res.data.stream && res.data.stream.playlist;
    if (!playlist) { console.log('[dc:vidlink] sem playlist'); return null; }

    console.log(`[dc:vidlink] ✓ playlist: ${playlist.substring(0, 70)}...`);
    // proxyable:false — ver nota em tryVixsrc: a CDN bloqueia o IP de
    // datacenter do nosso proxy; o cliente (IP residencial) tenta directo.
    return [{ url: playlist, quality: 'Auto', proxyable: false, referer: VIDLINK_REF + '/' }];
  } catch (e) {
    console.log(`[dc:vidlink] erro: ${e.message}`);
    return null;
  }
}

// ── Orquestração ─────────────────────────────────────────────────────────────
async function fetchFromDatacenterSources(imdbId, type, season, episode) {
  const tmdb = await convertImdbToTmdb(imdbId);
  if (!tmdb) { console.log('[dc] falha ao converter IMDb → TMDB (TMDB_API_KEY?)'); return null; }
  const tmdbId = tmdb.id;
  console.log(`[dc] IMDb ${imdbId} → TMDB ${tmdbId}`);

  const vix = await tryVixsrc(tmdbId, type, season, episode);
  if (vix && vix.length) return vix;

  const vid = await tryVidlink(tmdbId, type, season, episode);
  if (vid && vid.length) return vid;

  return null;
}

module.exports = { fetchFromDatacenterSources };
