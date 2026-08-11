'use strict';
// Teste autónomo de fontes por browser. Não depende de nada do repo além do
// node_modules (puppeteer) — dá para correr sem git pull nem npm install.
//
// Uso, a partir de /root/stremio-addon-streamimdb:
//   node teste_fontes.js                          # 2embed.skin + multiembed, Chicago Med S1E1
//   node teste_fontes.js tt0076759 movie          # um filme
//   node teste_fontes.js tt4655480 series 1 1     # episódio à escolha
//   DEBUG=1 node teste_fontes.js                  # mostra a rede e as frames

let puppeteer;
try {
  const extra = require('puppeteer-extra');
  extra.use(require('puppeteer-extra-plugin-stealth')());
  puppeteer = extra;
} catch {
  puppeteer = require('puppeteer'); // sem stealth, serve na mesma para medir
}

const [, , IMDB = 'tt4655480', TYPE = 'series', S = '1', E = '1'] = process.argv;
const DEBUG = process.env.DEBUG === '1';
const POR_FONTE_MS = parseInt(process.env.POR_FONTE_MS) || 25000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const AD_RE = /histats|doubleclick|googlesyndication|googletagmanager|google-analytics|popunder|popads|popcash|propeller|onclick|llvpn|disable-devtool/i;

const FONTES = [
  {
    nome: '2embed.skin',
    url: TYPE === 'series'
      ? `https://www.2embed.skin/embedtv/${IMDB}&s=${S}&e=${E}`
      : `https://www.2embed.skin/embed/${IMDB}`,
  },
  {
    nome: 'multiembed',
    url: TYPE === 'series'
      ? `https://multiembed.mov/?video_id=${IMDB}&s=${S}&e=${E}`
      : `https://multiembed.mov/?video_id=${IMDB}`,
  },
];

async function testar(browser, fonte) {
  const page = await browser.newPage();
  const rede = [];          // tudo o que passou, para o veredicto
  let m3u8 = null, resolveM3u8;
  const espera = new Promise(r => { resolveM3u8 = r; });

  try {
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 720 });
    await page.setRequestInterception(true);

    page.on('request', req => {
      const u = req.url();
      rede.push(u);
      if (DEBUG) console.log(`    [req] ${req.resourceType().padEnd(9)} ${u.substring(0, 120)}`);
      if (AD_RE.test(u)) return req.abort().catch(() => {});
      if (/\.m3u8(\?|$)/i.test(u) && !m3u8) { m3u8 = u; resolveM3u8(u); }
      req.continue().catch(() => {});
    });
    page.on('response', res => {
      const u = res.url();
      if (/\.m3u8(\?|$)/i.test(u) && !m3u8) { m3u8 = u; resolveM3u8(u); }
    });
    if (DEBUG) {
      page.on('framenavigated', f => console.log(`    [frame] ${f.url().substring(0, 120)}`));
      page.on('pageerror', e => console.log(`    [erro] ${e.message.substring(0, 120)}`));
    }

    const resp = await page.goto(fonte.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      .catch(e => { console.log(`    navegação falhou: ${e.message}`); return null; });

    const status = resp ? resp.status() : null;
    const html = await page.content().catch(() => '');

    // Clica no play em ciclo, em todas as frames: quase todos estes players
    // seguram o arranque atrás de um botão.
    const clicker = setInterval(async () => {
      for (const f of page.frames()) {
        for (const sel of ['#bigPlay', '.jw-bigplay', '#pl_but', '#player', '.play', 'button', 'video']) {
          try { await f.click(sel, { delay: 20 }); } catch { /* selector ausente */ }
        }
      }
    }, 2000);

    await Promise.race([espera, new Promise(r => setTimeout(r, POR_FONTE_MS))]);
    clearInterval(clicker);

    const frames = page.frames().map(f => f.url()).filter(u => u && u !== 'about:blank');
    return { status, m3u8, html, frames, rede };
  } finally {
    await page.close().catch(() => {});
  }
}

// Distingue "landing de anúncios sem player" de "player que não pediu o m3u8".
// A diferença importa: só o segundo caso tem hipótese com ajustes ao resolver.
function veredicto(r) {
  if (r.m3u8) return { txt: '✓ ENTREGA m3u8', detalhe: r.m3u8.substring(0, 100) };
  if (r.status === null) return { txt: '✗ inalcançável', detalhe: 'nem sequer carregou (DNS/rede/bloqueio)' };
  if (r.status >= 400) return { txt: '✗ morto', detalhe: `HTTP ${r.status}` };

  const temVideo = /<video|jwplayer|videojs|playerjs|hls\.js|clappr/i.test(r.html);
  const temIframe = r.frames.length > 1;
  const pedidos = r.rede.length;

  if (!temVideo && !temIframe) {
    return { txt: '✗ sem player', detalhe: `HTTP ${r.status}, ${pedidos} pedidos, nem <video> nem iframe — provável landing/anúncios` };
  }
  return {
    txt: '~ player sem m3u8',
    detalhe: `HTTP ${r.status}, ${pedidos} pedidos, ${r.frames.length} frame(s)${temVideo ? ', tem player' : ''} — carrega mas não pediu m3u8`,
  };
}

(async () => {
  console.log(`\nTeste de fontes — ${IMDB} ${TYPE}${TYPE === 'series' ? ` S${S}E${E}` : ''}`);
  console.log(`Timeout por fonte: ${POR_FONTE_MS / 1000}s\n`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled', '--mute-audio', '--disable-gpu'],
  });

  const out = [];
  for (const f of FONTES) {
    console.log(`── ${f.nome}`);
    console.log(`   ${f.url}`);
    const t0 = Date.now();
    let r;
    try { r = await testar(browser, f); }
    catch (e) { r = { status: null, m3u8: null, html: '', frames: [], rede: [], erro: e.message }; }
    const v = veredicto(r);
    const ms = Date.now() - t0;
    console.log(`   ${v.txt}  (${(ms / 1000).toFixed(1)}s)`);
    console.log(`   ${v.detalhe}\n`);
    out.push({ nome: f.nome, ...v, m3u8: r.m3u8 });
  }

  await browser.close();

  console.log('───────────────────────────────────────────────');
  for (const o of out) console.log(`  ${o.nome.padEnd(14)} ${o.txt}`);
  console.log('───────────────────────────────────────────────');

  const boas = out.filter(o => o.m3u8).map(o => o.nome);
  if (boas.length) {
    console.log(`\nAcrescenta ao BROWSER_PROVIDERS do .env: ${boas.join(',')}`);
  } else {
    console.log('\nNenhuma entregou m3u8.');
    console.log('  "sem player"        = landing/anúncios, fonte morta, não vale insistir');
    console.log('  "player sem m3u8"   = carrega mas não arranca; repete com DEBUG=1');
  }
  console.log('');
  process.exit(0);
})();
