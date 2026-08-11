'use strict';
// Resolve streams do vidsrc através de um browser real.
//
// Porquê browser: a cadeia é
//   vidsrc.in/embed → vsembed.ru → cloudorchestranova.com/embed/player
// e o URL final do .m3u8 é descodificado em **WebAssembly** (vsdec.js) já
// dentro do player. Não há forma sã de replicar isso em axios — mas basta
// deixar a página correr e apanhar o .m3u8 quando ele passa na rede.
//
// Diferença importante para o antigo puppeteer_resolver (removido): esta
// cadeia **não tem Cloudflare Turnstile** em passo nenhum. Foi o loop
// infinito de challenges do streamimdb.me que tornava o outro inviável;
// aqui é só executar JS/WASM, o que funciona bem em headless.
//
// Browser partilhado, lazy (só arranca quando é preciso), com limite de
// concorrência e auto-fecho por inatividade para não segurar RAM à toa.

let puppeteer;
try {
  const extra = require('puppeteer-extra');
  extra.use(require('puppeteer-extra-plugin-stealth')());
  puppeteer = extra;
} catch {
  try { puppeteer = require('puppeteer'); } catch { puppeteer = null; }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

const NAV_TIMEOUT    = parseInt(process.env.VIDSRC_NAV_TIMEOUT_MS) || 30000;
const MAX_CONCURRENT = parseInt(process.env.VIDSRC_CONCURRENCY)    || 2;
const IDLE_CLOSE_MS  = parseInt(process.env.VIDSRC_IDLE_CLOSE_MS)  || 5 * 60 * 1000;
// Sem Turnstile para resolver, o headless normal chega e gasta menos.
const HEADLESS = process.env.VIDSRC_HEADLESS === 'false' ? false : 'new';
// VIDSRC_DEBUG=1 despeja pedidos de rede, frames e erros da página — é assim
// que se percebe em que ponto da cadeia o player encravou.
const DEBUG = process.env.VIDSRC_DEBUG === '1';

// Hosts de anúncios/tracking: bloqueados para a página carregar mais depressa
// e não abrir popunders.
// Inclui o disable-devtool: essa biblioteca detecta automação/devtools e pode
// abortar o player antes de ele pedir o m3u8. Bloqueá-la é o que nos deixa
// correr em headless.
const AD_RE = /histats|doubleclick|googlesyndication|googletagmanager|google-analytics|popunder|popads|popcash|propeller|onclick|llvpn|allowtohimselfew|edtoflyawayutbefo|disable-devtool/i;

// ── Browser partilhado ───────────────────────────────────────────────────────
let browserPromise = null;
let idleTimer = null;
let activePages = 0;

async function getBrowser() {
  if (!puppeteer) throw new Error('puppeteer não instalado (npm install)');
  if (browserPromise) {
    const b = await browserPromise;
    if (b.isConnected()) return b;
    browserPromise = null;
  }
  browserPromise = puppeteer.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--mute-audio', '--no-first-run', '--window-size=1280,720',
      ...(HEADLESS ? ['--disable-gpu'] : []),
    ],
  });
  const b = await browserPromise;
  b.on('disconnected', () => { browserPromise = null; });
  console.log(`[vidsrc] browser lançado (headless=${HEADLESS})`);
  return b;
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (activePages === 0 && browserPromise) {
      try { (await browserPromise).close(); console.log('[vidsrc] browser fechado (inatividade)'); }
      catch { /* já fechado */ }
      browserPromise = null;
    }
  }, IDLE_CLOSE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

// ── Semáforo ─────────────────────────────────────────────────────────────────
let running = 0;
const queue = [];
const acquire = () => running < MAX_CONCURRENT
  ? (running++, Promise.resolve())
  : new Promise(res => queue.push(res));
function release() {
  running--;
  const next = queue.shift();
  if (next) { running++; next(); }
}

// ── Resolução ────────────────────────────────────────────────────────────────
function embedUrl(imdbId, type, season, episode) {
  return type === 'series'
    ? `https://vidsrc.in/embed/tv/${imdbId}/${season}-${episode}`
    : `https://vidsrc.in/embed/movie/${imdbId}`;
}

// Os primeiros passos da cadeia são HTML simples — fazem-se com axios, que é
// muito mais barato e determinista que carregá-los no browser. O browser fica
// só para a última página (o player), onde o URL é descodificado em WASM.
//
// Além disso evita um problema real: a página do embed é uma *landing* com
// `autoStart:false` que só carrega o player depois de um clique — clicar em
// iframes aninhados é frágil, e ir direito ao playerUrl dispensa isso.
async function resolvePlayerUrl(imdbId, type, season, episode) {
  const axios = require('axios');
  const get = (url, referer) => axios.get(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(referer ? { Referer: referer, Origin: new URL(referer).origin } : {}),
    },
    timeout: 12000, maxRedirects: 5, validateStatus: () => true,
    responseType: 'text', transformResponse: x => x,
  });

  const step1 = embedUrl(imdbId, type, season, episode);
  const r1 = await get(step1);
  const b1 = String(r1.data || '');
  const vs = b1.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1];
  if (!vs) { console.log('[vidsrc] passo 1: sem iframe'); return null; }

  const step2 = new URL(vs, step1).href;
  const r2 = await get(step2, step1);
  const b2 = String(r2.data || '');
  // O iframe interno é escrito com src="https://cloudorchestranova.com/..."
  const cn = b2.match(/src=["'](https:\/\/[^"']*cloudorchestranova[^"']+)["']/i)?.[1]
          || b2.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1];
  if (!cn) { console.log('[vidsrc] passo 2: sem iframe do player'); return null; }

  const step3 = new URL(cn, step2).href;
  const r3 = await get(step3, step2);
  const b3 = String(r3.data || '');
  const cfgRaw = b3.match(/window\.CFG\s*=\s*(\{[\s\S]*?\})\s*[;<]/);
  if (!cfgRaw) { console.log('[vidsrc] passo 3: sem window.CFG'); return null; }

  let cfg;
  try { cfg = JSON.parse(cfgRaw[1]); }
  catch (e) { console.log(`[vidsrc] CFG inválido: ${e.message}`); return null; }
  if (!cfg.playerUrl) { console.log('[vidsrc] CFG sem playerUrl'); return null; }

  // Legendas próprias desta fonte (`default_subs` do metaApi). São as que
  // correspondem a ESTE encode — usar as de outra fonte dessincroniza, porque
  // são releases diferentes.
  let subtitles = [];
  if (cfg.metaApi) {
    try {
      const meta = await get(cfg.metaApi, step3);
      const data = typeof meta.data === 'string' ? JSON.parse(meta.data) : meta.data;
      subtitles = (data?.default_subs || [])
        .map(s => ({ url: s.url || s.file || s.src, lang: s.lang || s.language || s.label || null }))
        .filter(s => s.url);
      console.log(`[vidsrc] ${subtitles.length} legenda(s) próprias`);
    } catch (e) { console.log(`[vidsrc] metaApi falhou: ${e.message}`); }
  }

  return { url: new URL(cfg.playerUrl, step3).href, referer: step3, subtitles };
}

async function resolveVidsrc(imdbId, type, season, episode) {
  if (!puppeteer) { console.log('[vidsrc] puppeteer indisponível — a saltar'); return null; }

  await acquire();
  activePages++;
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 720 });

    // Promessa que resolve assim que um .m3u8 passar na rede.
    let done;
    const m3u8 = new Promise(res => { done = res; });

    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = req.url();
      if (DEBUG) console.log(`[vidsrc:req] ${req.resourceType().padEnd(10)} ${url.substring(0, 130)}`);
      if (AD_RE.test(url)) return req.abort().catch(() => {});
      if (/\.m3u8(\?|$)/i.test(url)) {
        done({ url, referer: req.frame()?.url() || page.url() });
        // deixa seguir: abortar aqui às vezes faz o player tentar outro caminho
      }
      req.continue().catch(() => {});
    });
    // Alguns players pedem o m3u8 via XHR cuja resposta é que traz o URL final.
    page.on('response', res => {
      const url = res.url();
      if (/\.m3u8(\?|$)/i.test(url)) done({ url, referer: page.url() });
    });
    if (DEBUG) {
      page.on('console', m => console.log(`[vidsrc:console] ${m.text().substring(0, 200)}`));
      page.on('pageerror', e => console.log(`[vidsrc:pageerror] ${e.message.substring(0, 200)}`));
      page.on('frameattached', f => console.log(`[vidsrc:frame+] ${f.url().substring(0, 130)}`));
      page.on('framenavigated', f => console.log(`[vidsrc:frame→] ${f.url().substring(0, 130)}`));
    }

    console.log(`[vidsrc] a resolver ${imdbId}${type === 'series' ? ` S${season}E${episode}` : ''}`);
    const player = await resolvePlayerUrl(imdbId, type, season, episode);
    if (!player) { console.log('[vidsrc] ✗ não cheguei ao playerUrl'); return null; }
    if (DEBUG) console.log(`[vidsrc:debug] playerUrl: ${player.url}`);

    // Vai direito ao player (o passo com o WASM), com o referer da página que
    // o gerou — sem ele o token ?vs= é rejeitado.
    await page.setExtraHTTPHeaders({ Referer: player.referer });
    page.goto(player.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});

    // Mesmo no player pode haver um botão de play a segurar o arranque.
    const clicker = setInterval(async () => {
      for (const frame of page.frames()) {
        for (const sel of ['#bigPlay', '.jw-bigplay', '#player', 'video']) {
          try { await frame.click(sel, { delay: 20 }); } catch { /* selector ausente nesta frame */ }
        }
      }
    }, 2000);

    const hit = await Promise.race([
      m3u8,
      new Promise(res => setTimeout(() => res(null), NAV_TIMEOUT)),
    ]);
    clearInterval(clicker);

    if (!hit) {
      console.log('[vidsrc] ✗ nenhum m3u8 capturado');
      if (DEBUG) {
        console.log('[vidsrc:debug] frames no fim:');
        for (const f of page.frames()) console.log(`    ${f.url().substring(0, 140)}`);
      }
      return null;
    }
    console.log(`[vidsrc] ✓ m3u8: ${hit.url.substring(0, 90)}...`);
    return [{
      url: hit.url,
      quality: 'Auto',
      // O nosso servidor tem o IP residencial bom, por isso serve via /hls
      // (mesma lógica das outras fontes na branch Server).
      proxyable: true,
      referer: hit.referer || 'https://cloudorchestranova.com/',
      source: 'VidSrc',
      subtitles: player.subtitles || [],
    }];
  } catch (e) {
    console.log(`[vidsrc] erro: ${e.message}`);
    return null;
  } finally {
    if (page) { try { await page.close(); } catch { /* já fechada */ } }
    activePages--;
    release();
    scheduleIdleClose();
  }
}

module.exports = { resolveVidsrc };
