'use strict';
// Segue a cadeia de embeds até ao .m3u8, saltando de página em página.
//
// Ao contrário do diag_vidsrc.js, não assume a forma da cadeia: em cada passo
// procura o próximo URL a seguir (iframe, src=..., /prorcp/...) seja ele uma
// tag HTML ou uma atribuição em JavaScript. Faz tudo numa só corrida porque os
// tokens intermédios (?vs=...) expiram depressa.
//
// Uso: node diag_chain.js [urlInicial]
//      node diag_chain.js https://vidsrc.in/embed/tv/tt4655480/1-1
require('dotenv').config();
const axios = require('axios');

const START = process.argv[2] || 'https://vidsrc.in/embed/tv/tt4655480/1-1';
const MAX_HOPS = 5;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

function get(url, referer) {
  return axios.get(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(referer ? { Referer: referer, Origin: new URL(referer).origin } : {}),
    },
    timeout: 15000, maxRedirects: 5, validateStatus: () => true,
    responseType: 'text', transformResponse: x => x,
  });
}

const abs = (u, base) => {
  if (!u) return null;
  if (u.startsWith('//')) return 'https:' + u;
  try { return new URL(u, base).href; } catch { return null; }
};

// Ignora tracking/ads — senão a cadeia desvia-se para o histats e afins.
const NOISE = /histats|google|doubleclick|gstatic|cloudflareinsights|llvpn|\.gif|\.png|\.css|sbx\.js|jquery/i;

function findNext(body, base, visited) {
  const cands = [];
  const push = u => { const a = abs(u, base); if (a && !NOISE.test(a) && !visited.has(a)) cands.push(a); };

  // prorcp é sempre o passo seguinte quando existe
  for (const m of body.matchAll(/['"]([^'"]*\/prorcp\/[^'"]+)['"]/gi)) push(m[1]);
  // iframes declarados
  for (const m of body.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)) push(m[1]);
  // src="..." solto (inclui atribuições em JS)
  for (const m of body.matchAll(/\bsrc\s*=\s*["'](https?:\/\/[^"']+|\/\/[^"']+)["']/gi)) push(m[1]);

  // prorcp primeiro, depois hosts diferentes do actual (é para lá que se vai)
  const host = (() => { try { return new URL(base).hostname; } catch { return ''; } })();
  cands.sort((a, b) => {
    const score = u => (/\/prorcp\//i.test(u) ? 2 : 0) + (new URL(u).hostname !== host ? 1 : 0);
    return score(b) - score(a);
  });
  return cands[0] || null;
}

// Mostra pistas de onde está a fonte, em vez de despejar JS minificado.
function hints(body) {
  const patterns = [
    ['config/CFG',   /(?:window\.)?(?:CFG|config|PLAYER_CONFIG)\s*=\s*\{[^\n]{0,300}/gi],
    ['endpoints',    /["'](?:https?:\/\/[^"']+|\/)[^"']*(?:api|source|stream|play|get)[^"']*\.(?:php|json)[^"']*["']/gi],
    ['fetch/ajax',   /(?:fetch|\.get|\.post|open)\(\s*["'`][^"'`]{4,160}["'`]/gi],
    ['file/sources', /(?:file|sources|src|url)\s*:\s*["'][^"']{8,200}["']/gi],
    ['media',        /https?:\/\/[^"'\s\\]+\.(?:mp4|mkv|txt|key)[^"'\s\\]*/gi],
    ['decode',       /(?:atob|base64|decodeURIComponent|CryptoJS|AES)\s*[\(.][^\n]{0,100}/gi],
    ['hosts',        /https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/gi],
  ];
  for (const [label, re] of patterns) {
    const found = [...new Set([...body.matchAll(re)].map(m => m[0].trim()))]
      .filter(s => !NOISE.test(s)).slice(0, 8);
    if (found.length) {
      console.log(`      ${label}:`);
      for (const f of found) console.log(`        ${f.substring(0, 180)}`);
    }
  }
}

function findM3u8(body) {
  return body.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/)?.[0]
      || body.match(/file\s*:\s*["'](https?:\/\/[^"']+)["']/i)?.[1]
      || null;
}

(async () => {
  let url = START, referer = null;
  const visited = new Set();

  for (let hop = 1; hop <= MAX_HOPS; hop++) {
    visited.add(url);
    console.log(`\n[${hop}] ${url}`);
    const res = await get(url, referer);
    const body = typeof res.data === 'string' ? res.data : '';
    const cf = /Just a moment|challenge-platform|cf-turnstile|turnstile/i.test(body);
    console.log(`    status ${res.status} · ${body.length}b${cf ? '  ⚠ TURNSTILE/CLOUDFLARE' : ''}`);
    if (!body) break;

    const m3u8 = findM3u8(body);
    if (m3u8) {
      console.log(`\n★★★ m3u8 encontrado: ${m3u8}`);
      console.log(`    referer a usar: ${url}`);
      // Confirma que serve mesmo e vê as faixas de áudio
      const chk = await get(m3u8, url);
      console.log(`    fetch do m3u8: HTTP ${chk.status} · ${String(chk.data || '').length}b`);
      const audio = [...String(chk.data || '').matchAll(/#EXT-X-MEDIA:.*TYPE=AUDIO[^\n]*/gi)].map(m => m[0]);
      if (audio.length) {
        console.log('    faixas de áudio:');
        for (const a of audio) {
          console.log(`      ${a.match(/LANGUAGE="([^"]+)"/i)?.[1] || '?'}  ${a.match(/NAME="([^"]+)"/i)?.[1] || ''}${/DEFAULT=YES/i.test(a) ? '  (default)' : ''}`);
        }
      } else {
        console.log('    (sem faixas #EXT-X-MEDIA — áudio multiplexado)');
      }
      return;
    }

    // O player do cloudorchestranova guarda a configuração num window.CFG —
    // é lá que estão os endpoints (metaApi, sourceApi, ...) que devolvem o
    // stream. Vale a pena segui-los antes de desistir.
    const cfgRaw = body.match(/window\.CFG\s*=\s*(\{[\s\S]*?\})\s*[;<]/);
    if (cfgRaw) {
      let cfg = null;
      try { cfg = JSON.parse(cfgRaw[1]); } catch (e) { console.log(`    CFG não parseável: ${e.message}`); }
      if (cfg) {
        console.log('    window.CFG:');
        console.log(JSON.stringify(cfg, null, 2).replace(/^/gm, '      '));

        for (const [k, v] of Object.entries(cfg)) {
          // playerUrl vem relativo ('/embed/player/...') — resolver contra a
          // página actual, senão perde-se justamente o passo que interessa.
          if (typeof v !== 'string' || !/^(https?:\/\/|\/)/.test(v)) continue;
          const target = abs(v, url);
          if (!target) continue;
          console.log(`\n    → ${k}: ${target}`);
          const r = await get(target, url);
          const b = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
          const cf2 = /Just a moment|challenge-platform|cf-turnstile|turnstile/i.test(b);
          console.log(`      HTTP ${r.status} · ${b.length}b${cf2 ? '  ⚠ TURNSTILE' : ''}`);
          const m = findM3u8(b);
          if (m) {
            console.log(`      ★★★ m3u8: ${m}`);
            const chk = await get(m, target);
            const mb = String(chk.data || '');
            console.log(`      fetch do m3u8: HTTP ${chk.status} · ${mb.length}b`);
            const audio = [...mb.matchAll(/#EXT-X-MEDIA:.*TYPE=AUDIO[^\n]*/gi)].map(x => x[0]);
            if (audio.length) {
              console.log('      faixas de áudio:');
              for (const a of audio) {
                console.log(`        ${a.match(/LANGUAGE="([^"]+)"/i)?.[1] || '?'}  ${a.match(/NAME="([^"]+)"/i)?.[1] || ''}${/DEFAULT=YES/i.test(a) ? '  (default)' : ''}`);
              }
            } else {
              console.log('      (sem faixas #EXT-X-MEDIA — áudio multiplexado no vídeo)');
            }
          } else {
            // Bundles minificados não se leem em dump cru — guarda em ficheiro
            // e mostra só as pistas úteis (endpoints, ficheiros, decode).
            const path = `/tmp/chain_${k}.html`;
            require('fs').writeFileSync(path, b);
            console.log(`      guardado em ${path}`);
            hints(b);
          }
        }
        return;
      }
    }

    const next = findNext(body, url, visited);
    if (!next) {
      console.log('    sem próximo passo. Amostra:');
      console.log(body.substring(0, 1500).replace(/^/gm, '      '));
      return;
    }
    referer = url;
    url = next;
  }
  console.log('\nLimite de saltos atingido.');
})();
