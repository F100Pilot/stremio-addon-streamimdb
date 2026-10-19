'use strict';
// Compara a lista de segmentos que a VixSrc dá ao node (axios) e ao curl,
// e lista TODOS os hosts distintos da variante 720p.
const axios = require('axios'); const { execSync } = require('child_process');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const B = 'https://vixsrc.to', id = process.argv[2] || '11';
const H = { 'User-Agent': UA, Referer: B + '/', Origin: B };
const hosts = t => [...new Set(String(t).split('\n').filter(l => /^https?:/.test(l)).map(l => new URL(l.trim()).host))];
(async () => {
  const a = await axios.get(`${B}/api/movie/${id}`, { headers: H });
  const e = (await axios.get(B + a.data.src, { headers: H, responseType: 'text' })).data;
  const tk = e.match(/token["']\s*:\s*["']([^"']+)/)[1], ex = e.match(/expires["']\s*:\s*["']([^"']+)/)[1];
  const master = `${B}/playlist/${id === '11' ? '741555' : e.match(/playlist\/(\d+)/)[1]}?token=${tk}&expires=${ex}&h=1&lang=en`;
  const m = (await axios.get(master, { headers: H, responseType: 'text' })).data;
  const v = String(m).split('\n').find(l => /^https?:/.test(l)).trim();
  console.log('variante:', v.slice(0, 110));
  const vn = (await axios.get(v, { headers: H, responseType: 'text' })).data;
  console.log('axios → hosts:', hosts(vn), '· linhas http:', String(vn).split('\n').filter(l => /^http/.test(l)).length);
  console.log('   1.ª linha:', String(vn).split('\n').find(l => /^http/.test(l)).slice(0, 140));
  for (const extra of ['', '--http2', '-H "Accept: */*" -H "Accept-Language: en-US,en;q=0.9" -H "Sec-Fetch-Dest: empty" -H "Sec-Fetch-Mode: cors" -H "Sec-Fetch-Site: same-origin"']) {
    try {
      const out = execSync(`curl -s --max-time 20 ${extra} -A "${UA}" -e "${B}/" -H "Origin: ${B}" "${v}"`).toString();
      console.log(`curl ${extra.slice(0, 20) || '(simples)'} → hosts:`, hosts(out), out.length ? '' : '(vazio)');
    } catch (x) { console.log('curl falhou:', x.message.split('\n')[0]); }
  }
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
