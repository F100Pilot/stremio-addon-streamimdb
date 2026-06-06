'use strict';
const axios = require('axios');
const { onCircuitBreaker } = require('./puppeteer_resolver');
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

// Test title: Star Wars (1977) — safe, widely available
const TEST_IMDB = 'tt0076759';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let lastStatus = 'ok';
let downSince  = null;
let alertSent  = false;
let lastMsg    = '';
let lastCheckAt = null;

// ── Tests ─────────────────────────────────────────────────────────────────────

// Fast test: axios extracts the rcp iframe from streamimdb.me — no browser needed.
// If this fails it means the embed page itself is down or the iframe disappeared.
async function testStreamImdbEmbed() {
  const url = `https://streamimdb.me/embed/${TEST_IMDB}/`;
  try {
    const res = await axios.get(url, {
      timeout: 12000,
      headers: { 'User-Agent': UA },
      validateStatus: () => true,
    });
    if (res.status >= 500) return { ok: false, message: `streamimdb.me HTTP ${res.status}` };
    const body = typeof res.data === 'string' ? res.data : '';
    const m = body.match(/id="player_iframe"[^>]+src="([^"]+)"/)
           || body.match(/<iframe[^>]+src="([^"]+)"[^>]*allowfullscreen/i);
    if (!m) return { ok: false, message: 'streamimdb.me: iframe do player não encontrado no embed' };
    return { ok: true, message: `streamimdb.me OK — iframe: ${m[1].substring(0, 60)}…` };
  } catch (e) {
    return { ok: false, message: `streamimdb.me: ${e.message}` };
  }
}

async function testAPI() {
  return testStreamImdbEmbed();
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
      console.log('[health] ✓ FONTE RECUPERADA');
      await sendAlert(
        '✅ <b>StreamIMDb — Fonte Recuperada</b>',
        `A fonte voltou a estar operacional após ${downSecs}s de downtime.\n<i>${result.message}</i>`,
      );
      downSince  = null;
      alertSent  = false;
    }
    lastStatus = 'ok';
  } else {
    if (lastStatus === 'ok') {
      console.log(`[health] ✗ FONTE DOWN: ${result.message}`);
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
    checkInterval: Math.floor(CHECK_INTERVAL / 1000),
    telegram: TG_TOKEN ? 'configurado' : 'não configurado',
    email: getMailer() ? 'configurado' : 'não configurado',
  };
}

// Alerta imediato quando o circuit breaker do Puppeteer abre
onCircuitBreaker((pauseMin) => {
  sendAlert(
    '⚠️ <b>StreamIMDb — Puppeteer bloqueado</b>',
    `O Cloudflare Turnstile deixou de auto-resolver.\nCircuit breaker activo por ${pauseMin} min.\n<i>Os streams podem estar indisponíveis durante este período.</i>`,
  ).catch(() => {});
});

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
