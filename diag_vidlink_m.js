'use strict';
// Extrai do leitor do Vidlink a função que reescreve os URLs requiresProxy
// (para o proxy "surge.flooderrr.store"/"/sacdn"), para replicarmos o formato.
const axios = require('axios');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const REF = 'https://vidlink.pro';
(async () => {
  const page = await axios.get(`${REF}/tv/1421/9/13`, { headers: { 'User-Agent': UA, Referer: REF + '/' }, responseType: 'text' });
  const scripts = [...String(page.data).matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => new URL(m[1], REF).href);
  for (const s of scripts) {
    const js = String((await axios.get(s, { headers: { 'User-Agent': UA, Referer: REF + '/' }, responseType: 'text' })).data);
    if (!js.includes('requiresProxy')) continue;
    console.log('script:', s, `(${js.length} bytes)`);
    // o módulo inteiro à volta de requiresProxy: do início do módulo webpack até ao fim do uso
    const i = js.indexOf('requiresProxy');
    const start = Math.max(0, js.lastIndexOf('function(e,t,n)', i) > 0 ? js.lastIndexOf('function(e,t,n)', i) : i - 6000);
    const end = Math.min(js.length, js.indexOf('requiresProxy', js.lastIndexOf('requiresProxy')) + 1500);
    console.log(js.slice(start, end));
    // e todas as ocorrências de domínios/strings de proxy no ficheiro
    console.log('\n--- strings com domínio/proxy ---');
    for (const m of js.matchAll(/"[^"]*(?:https?:\/\/|\.store|\.xyz|\.site|\.workers\.dev|\/sacdn|\/proxy|\/mp)[^"]*"/g)) console.log(m[0]);
  }
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
