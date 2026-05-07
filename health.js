'use strict';
const axios = require('axios');

const VAPLAYER_API_URL = process.env.VAPLAYER_API_URL || 'https://streamdata.vaplayer.ru/api.php';
const CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS) || 5 * 60 * 1000; // 5min
const ALERT_EMAIL = process.env.ALERT_EMAIL;
const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK;

let lastStatus = 'ok';
let downSince = null;
let alertSent = false;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function testAPI() {
  try {
    const res = await axios.get(VAPLAYER_API_URL, {
      params: { imdb: 'tt0076759', type: 'movie' },
      headers: {
        'User-Agent': UA,
        'Referer': 'https://brightpathsignals.com/embed/movie/tt0076759',
        'Origin': 'https://brightpathsignals.com',
        'X-Requested-With': 'XMLHttpRequest',
      },
      timeout: 8000,
    });

    if (res.status === 200 && res.data?.data?.stream_urls?.length > 0) {
      return { ok: true, message: 'API respondeu com streams' };
    }
    return { ok: false, message: `API status ${res.status}, sem streams` };
  } catch (e) {
    return { ok: false, message: `Erro: ${e.message}` };
  }
}

async function sendAlert(subject, body) {
  console.log(`[health] ALERTA: ${subject}`);

  if (ALERT_WEBHOOK) {
    try {
      await axios.post(ALERT_WEBHOOK, {
        text: `🚨 StreamIMDb Alert\n${subject}\n${body}`,
      }, { timeout: 5000 });
    } catch (e) {
      console.log(`[health] Erro ao enviar webhook: ${e.message}`);
    }
  }

  if (ALERT_EMAIL) {
    console.log(`[health] Email alertaria para: ${ALERT_EMAIL}`);
    // Implementação real requer nodemailer ou serviço externo
  }
}

async function healthCheck() {
  const result = await testAPI();

  if (result.ok) {
    // API está ok
    if (lastStatus === 'down') {
      console.log('[health] ✓ API RECUPERADA');
      await sendAlert('✓ StreamIMDb API Recuperada', `A API voltou a estar operacional após ${downSince ? Math.floor((Date.now() - downSince) / 1000) : '?'}s de downtime.`);
      downSince = null;
      alertSent = false;
    }
    lastStatus = 'ok';
  } else {
    // API está down
    if (lastStatus === 'ok') {
      console.log(`[health] ✗ API DOWN: ${result.message}`);
      downSince = Date.now();
      alertSent = false;
      lastStatus = 'down';
    }

    // Enviar alerta após 5 min de downtime se ainda não foi enviado
    const downtimeMs = Date.now() - downSince;
    if (!alertSent && downtimeMs > 5 * 60 * 1000) {
      await sendAlert('✗ StreamIMDb API Down', `API indisponível há ${Math.floor(downtimeMs / 1000)}s. Última mensagem: ${result.message}`);
      alertSent = true;
    }
  }
}

function getHealthStatus() {
  return {
    status: lastStatus,
    downSince,
    lastCheck: new Date().toISOString(),
    checkInterval: Math.floor(CHECK_INTERVAL / 1000),
  };
}

function startHealthChecks() {
  if (CHECK_INTERVAL === 0) {
    console.log('[health] Health checks desactivados (HEALTH_CHECK_INTERVAL_MS=0)');
    return null;
  }
  healthCheck(); // Primeira check imediatamente
  const intervalId = setInterval(healthCheck, CHECK_INTERVAL);
  console.log(`[health] Health checks iniciados a cada ${Math.floor(CHECK_INTERVAL / 1000)}s`);
  return intervalId;
}

module.exports = { startHealthChecks, getHealthStatus, healthCheck };
