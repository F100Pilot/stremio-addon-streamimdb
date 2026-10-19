'use strict';
// Envia um aviso pelos canais já configurados no .env (Telegram, webhook, email
// SMTP) — os mesmos que o health check usa. Chamado pelo autodeploy.sh.
//
// Uso: node deploy/notify.js "<assunto>" "<corpo>"
//
// Nunca falha: um aviso que não sai não pode estragar nem atrasar um deploy.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

(async () => {
  try {
    const { sendAlert } = require('../health');
    const [, , assunto = 'StreamIMDb', corpo = ''] = process.argv;
    await sendAlert(assunto, corpo);
  } catch (e) {
    console.error('[notify] não foi possível avisar:', e.message);
  }
  process.exit(0);
})();
