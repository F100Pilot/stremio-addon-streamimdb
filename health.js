'use strict';
const axios = require('axios');
let nodemailer;
try { nodemailer = require('nodemailer'); } catch { nodemailer = null; }

const CHECK_INTERVAL   = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS) || 5 * 60 * 1000;
const ALERT_WEBHOOK    = process.env.ALERT_WEBHOOK;
const TG_TOKEN         = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT          = process.env.TELEGRAM_CHAT_ID;

// Email (SMTP). Para Gmail: SMTP_USER = a tua conta, SMTP_PASS = App Password.
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT) || 465;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const ALERT_EMAIL = process.env.ALERT_EMAIL; // destinatário (default: SMTP_USER)

let mailer = null;
function getMailer() {
  if (!nodemailer || !SMTP_USER || !SMTP_PASS) return null;
  if (!mailer) {
    mailer = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return mailer;
}

// Título de teste: Star Wars (1977). Existe em qualquer fonte, e é filme —
// evita depender de uma temporada/episódio que possa sair do catálogo.
const TEST_IMDB = 'tt0076759';
const TEST_TMDB = 11;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

let lastStatus = 'ok';
let downSince  = null;
let alertSent  = false;
let lastMsg    = '';
let lastCheckAt = null;
let lastDetail = {};

// ── Tests ─────────────────────────────────────────────────────────────────────

// Fonte 1: VixSrc. Barato — basta a API responder com `src`.
async function testVixsrc() {
  try {
    const res = await axios.get(`https://vixsrc.to/api/movie/${TEST_TMDB}`, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/javascript, */*; q=0.01',
        Referer: 'https://vixsrc.to', Origin: 'https://vixsrc.to',
      },
      timeout: 8000, validateStatus: () => true,
    });
    if (res.status !== 200) return { ok: false, message: `VixSrc HTTP ${res.status}` };
    if (!res.data || !res.data.src) return { ok: false, message: 'VixSrc sem src na resposta' };
    return { ok: true, message: 'VixSrc OK' };
  } catch (e) {
    return { ok: false, message: `VixSrc: ${e.message}` };
  }
}

// Fonte 2: cadeia do vidsrc.in, até ao passo ANTES do browser.
//
// Lançar o Chromium de 5 em 5 minutos seria caro de mais para uma verificação
// periódica. Em vez disso segue-se a cadeia com axios — vidsrc.in → vsembed →
// cloudorchestranova — e confirma-se que a página do player traz o
// `window.CFG` com `playerUrl`. Se isso lá está, o que falta é só o browser
// executar o WASM; se não está, a cadeia partiu e o resolver vai falhar.
async function testVidsrcChain() {
  const get = (url, referer) => axios.get(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,*/*',
      ...(referer ? { Referer: referer, Origin: new URL(referer).origin } : {}),
    },
    timeout: 10000, maxRedirects: 5, validateStatus: () => true,
    responseType: 'text', transformResponse: x => x,
  });

  try {
    const step1 = `https://vidsrc.in/embed/movie/${TEST_IMDB}`;
    const r1 = await get(step1);
    const b1 = String(r1.data || '');
    const vs = b1.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1];
    if (!vs) return { ok: false, message: 'vidsrc.in: sem iframe no embed' };

    const step2 = new URL(vs, step1).href;
    const b2 = String((await get(step2, step1)).data || '');
    const cn = b2.match(/src=["'](https:\/\/[^"']*cloudorchestranova[^"']+)["']/i)?.[1]
            || b2.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1];
    if (!cn) return { ok: false, message: 'vidsrc.in: sem iframe do player (passo 2)' };

    const step3 = new URL(cn, step2).href;
    const b3 = String((await get(step3, step2)).data || '');
    if (/Just a moment|challenge-platform|cf-turnstile/i.test(b3)) {
      return { ok: false, message: 'vidsrc.in: Cloudflare/Turnstile no player' };
    }
    if (!/window\.CFG\s*=/.test(b3) || !/playerUrl/.test(b3)) {
      return { ok: false, message: 'vidsrc.in: player sem window.CFG/playerUrl' };
    }
    return { ok: true, message: 'vidsrc.in OK (cadeia até ao player)' };
  } catch (e) {
    return { ok: false, message: `vidsrc.in: ${e.message}` };
  }
}

// O serviço está de pé se PELO MENOS UMA fonte responder. Com só uma viva
// fica "degradado": ainda serve, mas sem rede de segurança — e é justamente
// aí que interessa ser avisado, antes de ficar sem nada.
async function testAPI() {
  const [vix, vid] = await Promise.all([testVixsrc(), testVidsrcChain()]);
  lastDetail = { vixsrc: vix.message, 'vidsrc.in': vid.message };

  const vivas = [vix.ok && 'VixSrc', vid.ok && 'vidsrc.in'].filter(Boolean);
  if (vivas.length === 2) return { ok: true, message: 'ambas as fontes OK' };
  if (vivas.length === 1) {
    const morta = vix.ok ? vid.message : vix.message;
    return { ok: true, degraded: true, message: `degradado — só ${vivas[0]} viva. Falha: ${morta}` };
  }
  return { ok: false, message: `ambas em baixo. ${vix.message} | ${vid.message}` };
}

// ── Alerting ──────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
      { chat_id: TG_CHAT, text, parse_mode: 'HTML' },
      { timeout: 8000 },
    );
    console.log('[health] Telegram enviado');
  } catch (e) {
    console.log(`[health] Telegram erro: ${e.message}`);
  }
}

async function sendWebhook(text) {
  if (!ALERT_WEBHOOK) return;
  try {
    await axios.post(ALERT_WEBHOOK, { text }, { timeout: 5000 });
  } catch (e) {
    console.log(`[health] Webhook erro: ${e.message}`);
  }
}

async function sendEmail(subject, htmlBody) {
  const transport = getMailer();
  if (!transport) return;
  const to = ALERT_EMAIL || SMTP_USER;
  try {
    // Remove tags HTML simples para o subject do email
    const cleanSubject = subject.replace(/<[^>]+>/g, '');
    await transport.sendMail({
      from: `"StreamIMDb Monitor" <${SMTP_USER}>`,
      to,
      subject: cleanSubject,
      html: htmlBody,
    });
    console.log(`[health] Email enviado para ${to}`);
  } catch (e) {
    console.log(`[health] Email erro: ${e.message}`);
  }
}

async function sendAlert(subject, body) {
  console.log(`[health] ALERTA: ${subject}`);
  const full = `${subject}\n${body}`;
  const html = `<div style="font-family:sans-serif">${subject}<br>${body.replace(/\n/g, '<br>')}</div>`;
  await Promise.all([
    sendTelegram(full),
    sendWebhook(full),
    sendEmail(subject, html),
  ]);
}

// ── Health loop ───────────────────────────────────────────────────────────────

async function healthCheck() {
  lastCheckAt = new Date().toISOString();
  const result = await testAPI();
  lastMsg = result.message;

  if (result.ok) {
    if (lastStatus === 'down') {
      const downSecs = downSince ? Math.floor((Date.now() - downSince) / 1000) : '?';
      console.log('[health] ✓ FONTES RECUPERADAS');
      await sendAlert(
        '✅ <b>StreamIMDb — Fontes Recuperadas</b>',
        `O serviço voltou a estar operacional após ${downSecs}s.\n<i>${result.message}</i>`,
      );
      downSince  = null;
      alertSent  = false;
    }

    // "Degradado" = uma fonte viva, outra em baixo. Ainda serve streams, mas
    // sem alternativa se a que resta cair. Avisa uma única vez na transição,
    // para não repetir o mesmo alerta de 5 em 5 minutos.
    if (result.degraded) {
      if (lastStatus !== 'degraded') {
        console.log(`[health] ⚠ DEGRADADO: ${result.message}`);
        await sendAlert(
          '⚠️ <b>StreamIMDb — Fonte em baixo</b>',
          `${result.message}\n<i>O serviço continua a funcionar, mas sem redundância.</i>`,
        );
      }
      lastStatus = 'degraded';
    } else {
      if (lastStatus === 'degraded') {
        console.log('[health] ✓ redundância reposta');
        await sendAlert('✅ <b>StreamIMDb — Redundância reposta</b>', result.message);
      }
      lastStatus = 'ok';
    }
  } else {
    if (lastStatus !== 'down') {
      console.log(`[health] ✗ FONTES EM BAIXO: ${result.message}`);
      downSince  = Date.now();
      alertSent  = false;
      lastStatus = 'down';
    }

    const downtimeMs = Date.now() - (downSince || Date.now());
    if (!alertSent && downtimeMs > 5 * 60 * 1000) {
      await sendAlert(
        '🚨 <b>StreamIMDb — Fonte Indisponível</b>',
        `Fonte inacessível há ${Math.floor(downtimeMs / 1000)}s.\n<i>${result.message}</i>`,
      );
      alertSent = true;
    }
  }
}

function getHealthStatus() {
  return {
    status: lastStatus,
    downSince,
    lastCheck: lastCheckAt,
    lastMessage: lastMsg,
    sources: lastDetail,
    checkInterval: Math.floor(CHECK_INTERVAL / 1000),
    telegram: TG_TOKEN ? 'configurado' : 'não configurado',
    email: getMailer() ? 'configurado' : 'não configurado',
  };
}

function startHealthChecks() {
  if (CHECK_INTERVAL === 0) {
    console.log('[health] Health checks desactivados (HEALTH_CHECK_INTERVAL_MS=0)');
    return null;
  }
  healthCheck();
  const id = setInterval(healthCheck, CHECK_INTERVAL);
  console.log(`[health] Health checks iniciados a cada ${Math.floor(CHECK_INTERVAL / 1000)}s (Telegram: ${TG_TOKEN ? 'sim' : 'não'}, Email: ${getMailer() ? 'sim' : 'não'})`);
  return id;
}

module.exports = { startHealthChecks, getHealthStatus, healthCheck };
