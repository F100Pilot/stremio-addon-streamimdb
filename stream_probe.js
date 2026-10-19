'use strict';
// Mede, POR TÍTULO, se cada stream vai tocar sem parar — e ordena em função disso.
//
// Porquê existe: a VixSrc só serve 720p e, em Out/2026, a CDN dela entregava ao
// servidor bem menos do que a variante precisa. Nenhuma verificação "a fonte
// responde?" apanha isso (a API respondia 200 o tempo todo). O que interessa é
// se os segmentos chegam mais depressa do que são consumidos.
//
// O que se mede é o FACTOR DE TEMPO REAL: segundos de vídeo descarregados por
// segundo decorrido, a puxar segmentos em sequência como faz um player.
//   >= 1.5  ok        folga para o player acumular buffer
//   1.0-1.5 marginal  chega, mas qualquer soluço esvazia o buffer
//   <  1.0  lento     vai parar para carregar
//
// Porque vários segmentos e não um só: com ficheiros pequenos o tempo é
// dominado pela latência de abrir a ligação e não pela largura de banda — a
// medição de um único segmento de 240 KB deu 0.4 Mbps e quase nos fez culpar a
// CDN quando os outros players tocavam bem. Aqui a latência entra no cálculo
// (é o que um player sequencial sente), diluída por vários segmentos.
//
// O que NÃO mede: o caminho servidor → túnel → cliente. Mede CDN → servidor,
// que é o troço que o proxy tem de atravessar. Um stream marcado "ok" aqui
// pode ainda engasgar se o upload de casa for o gargalo (ver diag_entrega.js).
//
// Tudo falha em silêncio: a medição é um extra e nunca pode impedir um stream
// de ser devolvido.
const axios = require('axios');

const ENABLED     = process.env.STREAM_PROBE !== 'off';
const SEGMENTS    = Math.max(1, parseInt(process.env.STREAM_PROBE_SEGMENTS, 10) || 3);
const BUDGET_MS   = parseInt(process.env.STREAM_PROBE_BUDGET_MS, 10) || 4000;
const MAX_BYTES   = parseInt(process.env.STREAM_PROBE_MAX_BYTES, 10) || 4 * 1024 * 1024;
const PREFER_LANG = (process.env.STREAM_PREFER_LANG ?? 'en').trim().toLowerCase();

const FACTOR_OK       = 1.5;
const FACTOR_MARGINAL = 1.0;

// Mesmo UA do proxy /seg: se a CDN trata de forma diferente um UA, queremos
// medir o que o proxy vai de facto sentir, não o que um UA "bonzinho" sente.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Parsing HLS ──────────────────────────────────────────────────────────────
const abs = (u, base) => { try { return new URL(u, base).href; } catch { return u; } };

// Variantes do master, da melhor para a pior (altura, depois bandwidth).
function parseMaster(body, base) {
  const lines = body.split('\n').map(l => l.trim());
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXT-X-STREAM-INF/i.test(lines[i])) continue;
    const uri = lines[i + 1];
    if (!uri || uri.startsWith('#')) continue;
    out.push({
      url: abs(uri, base),
      bandwidth: parseInt(lines[i].match(/[^-]BANDWIDTH=(\d+)/i)?.[1] || '0', 10),
      height:    parseInt(lines[i].match(/RESOLUTION=\d+x(\d+)/i)?.[1] || '0', 10),
    });
  }
  return out.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
}

// Primeiros `n` segmentos de uma media playlist, com a duração (#EXTINF).
// O init segment (#EXT-X-MAP) fica de fora: não é vídeo a consumir.
function parseSegments(body, base, n) {
  const segs = [];
  let dur = null;
  for (const raw of body.split('\n')) {
    const l = raw.trim();
    if (l.startsWith('#EXTINF:')) { dur = parseFloat(l.slice(8)) || null; continue; }
    if (!l || l.startsWith('#')) continue;
    if (dur) segs.push({ url: abs(l, base), dur });
    dur = null;
    if (segs.length >= n) break;
  }
  return segs;
}

// ── Rede ─────────────────────────────────────────────────────────────────────
function headersFor(referer) {
  const h = { 'User-Agent': UA };
  if (referer) {
    h.Referer = referer;
    try { h.Origin = new URL(referer).origin; } catch { /* referer inválido: segue sem Origin */ }
  }
  return h;
}

async function getText(url, referer, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { status: 0, body: '', reason: 'sem tempo' };
  try {
    const res = await axios.get(url, {
      headers: headersFor(referer), timeout: remaining, responseType: 'text',
      maxRedirects: 5, validateStatus: () => true, transformResponse: x => x,
    });
    return { status: res.status, body: typeof res.data === 'string' ? res.data : '' };
  } catch (e) {
    return { status: 0, body: '', reason: e.code || e.message };
  }
}

// Descarrega um segmento até ao fim, ao tecto de bytes, ou ao deadline —
// o que vier primeiro. Devolve quanto chegou e quanto isso vale em segundos
// de vídeo (fração do segmento × duração).
async function downloadSegment(seg, referer, deadline, expectedBytes) {
  const t0 = Date.now();
  const remaining = deadline - t0;
  if (remaining <= 0) return { bytes: 0, frac: 0, ms: 0, status: 0 };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), remaining);
  let bytes = 0, total = null, done = false, status = 0, ttfb = null;
  try {
    const res = await axios.get(seg.url, {
      headers: headersFor(referer), responseType: 'stream', signal: ctl.signal,
      timeout: remaining, maxRedirects: 5, validateStatus: () => true,
    });
    status = res.status;
    if (status >= 400) { res.data.destroy(); return { bytes: 0, frac: 0, ms: Date.now() - t0, status }; }
    total = parseInt(res.headers['content-length'], 10) || null;

    await new Promise(resolve => {
      res.data.on('data', c => {
        if (ttfb === null) ttfb = Date.now() - t0;
        bytes += c.length;
        if (bytes >= MAX_BYTES) res.data.destroy(); // dados de sobra para medir
      });
      res.data.on('end', () => { done = true; resolve(); });
      res.data.on('error', resolve);   // abort por deadline
      res.data.on('close', resolve);
    });
  } catch { /* abort antes dos headers, ou erro de rede: fica com o que há */ }
  finally { clearTimeout(timer); }

  // Fração do segmento que chegou. Sem Content-Length estima-se pelo que a
  // variante anuncia (bandwidth × duração), para um corte a meio valer algo.
  const denom = total || expectedBytes || 0;
  const frac = done ? 1 : (denom ? Math.min(1, bytes / denom) : 0);
  return { bytes, frac, ms: Date.now() - t0, status, ttfb };
}

// ── Medição de um stream ─────────────────────────────────────────────────────
function classify(factor) {
  if (factor >= FACTOR_OK) return 'ok';
  if (factor >= FACTOR_MARGINAL) return 'marginal';
  return 'lento';
}

async function probeOne(s) {
  const t0 = Date.now();
  const deadline = t0 + BUDGET_MS;
  const referer = s.referer || '';
  const falha = (reason) => ({ klass: 'erro', factor: 0, mbps: 0, reason, ms: Date.now() - t0 });

  const m = await getText(s.url, referer, deadline);
  if (m.status !== 200) return falha(`master ${m.status ? `HTTP ${m.status}` : (m.reason || 'sem resposta')}`);

  // Master com variantes → mede-se a de topo, que é a que o player tentará
  // primeiro. Sem variantes, o próprio URL já é a media playlist.
  let mediaBody = m.body, mediaUrl = s.url, bandwidth = 0;
  const variants = parseMaster(m.body, s.url);
  if (variants.length) {
    const top = variants[0];
    bandwidth = top.bandwidth;
    const v = await getText(top.url, referer, deadline);
    if (v.status !== 200) return falha(`variante ${v.status ? `HTTP ${v.status}` : (v.reason || 'sem resposta')}`);
    mediaBody = v.body; mediaUrl = top.url;
  }

  const segs = parseSegments(mediaBody, mediaUrl, SEGMENTS);
  if (!segs.length) return { klass: null, factor: null, reason: 'sem segmentos na playlist', ms: Date.now() - t0 };

  // Segmentos em sequência, como um player. O relógio começa no 1.º segmento:
  // as playlists acima não contam, o player já as teria quando precisa de vídeo.
  const tSeg = Date.now();
  let mediaSec = 0, bytes = 0, ttfb = null, httpErr = 0;
  for (const seg of segs) {
    const expected = bandwidth ? Math.round((bandwidth * seg.dur) / 8) : 0;
    const r = await downloadSegment(seg, referer, deadline, expected);
    if (r.status >= 400) { httpErr = r.status; break; }
    mediaSec += seg.dur * r.frac;
    bytes += r.bytes;
    if (ttfb === null && r.ttfb != null) ttfb = r.ttfb;
    if (r.frac < 1) break; // cortado pelo deadline: não vale a pena insistir
  }
  if (httpErr) return falha(`segmento HTTP ${httpErr}`);

  const secs = Math.max((Date.now() - tSeg) / 1000, 0.001);
  const factor = mediaSec / secs;
  return {
    klass: classify(factor), factor,
    mbps: (bytes * 8) / secs / 1e6, ttfbMs: ttfb,
    segs: segs.length, ms: Date.now() - t0,
    reason: bytes === 0 ? `sem dados em ${BUDGET_MS}ms` : undefined,
  };
}

// ── Estatísticas por fonte e por título ──────────────────────────────────────
const WINDOW_MS = 60 * 60 * 1000;  // só conta o que é recente
const MAX_SAMPLES = 20;
const MIN_SAMPLES = 5;             // abaixo disto não se conclui nada
const SLOW_ENTER = 1.0, SLOW_EXIT = 1.2; // histerese: evita oscilar à volta do limiar

const bySource = new Map();        // source → { samples: [{ts, factor, klass}], slow }
const recent = [];                 // últimos N títulos medidos

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function record(source, label, p) {
  const key = source || 'desconhecida';
  const st = bySource.get(key) || { samples: [], slow: false, errors: 0 };
  const ts = Date.now();

  if (p.klass === 'erro') st.errors++;
  else if (p.klass) st.samples.push({ ts, factor: p.factor, klass: p.klass });

  st.samples = st.samples.filter(x => ts - x.ts < WINDOW_MS).slice(-MAX_SAMPLES);
  if (st.samples.length >= MIN_SAMPLES) {
    const med = median(st.samples.map(x => x.factor));
    if (!st.slow && med < SLOW_ENTER) st.slow = true;
    else if (st.slow && med >= SLOW_EXIT) st.slow = false;
  }
  bySource.set(key, st);

  recent.push({
    title: label, source: key, klass: p.klass, factor: p.factor == null ? null : +p.factor.toFixed(2),
    mbps: p.mbps == null ? null : +p.mbps.toFixed(2), reason: p.reason, at: new Date(ts).toISOString(),
  });
  if (recent.length > 20) recent.shift();
}

// Para o /health.
function probeStats() {
  const now = Date.now();
  const sources = {};
  for (const [name, st] of bySource) {
    const live = st.samples.filter(x => now - x.ts < WINDOW_MS);
    const med = median(live.map(x => x.factor));
    sources[name] = {
      samples: live.length, errors: st.errors,
      medianFactor: med == null ? null : +med.toFixed(2),
      slow: st.slow && live.length >= MIN_SAMPLES,
    };
  }
  return { enabled: ENABLED, segments: SEGMENTS, budgetMs: BUDGET_MS, sources, recent: [...recent].reverse() };
}

// Fontes que o health check deve tratar como degradadas.
function slowSources() {
  const out = [];
  const now = Date.now();
  for (const [name, st] of bySource) {
    const live = st.samples.filter(x => now - x.ts < WINDOW_MS);
    if (st.slow && live.length >= MIN_SAMPLES) {
      out.push({ source: name, medianFactor: +median(live.map(x => x.factor)).toFixed(2), samples: live.length });
    }
  }
  return out;
}

// ── API pública ──────────────────────────────────────────────────────────────
// Mede todos os streams em paralelo e anota `s.probe` NO PRÓPRIO OBJECTO. É
// intencional: os mesmos objectos vivem na cache de 5 min, por isso uma medição
// que acabe depois de a resposta já ter saído continua a servir os pedidos
// seguintes (que reordenam na leitura).
//
// Nunca rejeita e resolve sempre dentro do orçamento + folga.
function probeStreams(streams, label = '') {
  if (!ENABLED || !streams || !streams.length) return Promise.resolve();

  const jobs = streams.filter(s => s && s.url && !s.probe).map(async s => {
    try {
      s.probe = await probeOne(s);
    } catch (e) {
      s.probe = { klass: null, factor: null, reason: e.message };
    }
    try { record(s.source, label, s.probe); } catch { /* estatística é um extra */ }
  });

  // Rede de segurança: mesmo que algo fique preso, não seguramos o chamador.
  return Promise.race([
    Promise.all(jobs),
    new Promise(r => { const t = setTimeout(r, BUDGET_MS + 1500); if (t.unref) t.unref(); }),
  ]).then(() => undefined);
}

// Ordem de preferência. Devolve um array NOVO (não mexe na cache).
//   1.º  estado medido: ok > sem medição > marginal > lento > erro
//   2.º  língua de áudio preferida (STREAM_PREFER_LANG, por omissão 'en')
//   3.º  factor medido, maior primeiro
//   4.º  ordem original (sort estável)
// Uma medição não pode esconder nada: só reordena. Os lentos continuam na
// lista, com o título a dizer porquê, para se poder escolher na mesma.
const TIER = { ok: 3, none: 2, marginal: 1, lento: 0, erro: -1 };
function orderStreams(streams) {
  if (!ENABLED || !streams) return streams;
  const rank = s => TIER[s.probe?.klass || 'none'] ?? TIER.none;
  const lang = s => (PREFER_LANG && (s.audioLangs || []).includes(PREFER_LANG)) ? 0 : 1;
  return streams
    .map((s, i) => ({ s, i }))
    .sort((a, b) =>
      (rank(b.s) - rank(a.s)) ||
      (lang(a.s) - lang(b.s)) ||
      ((b.s.probe?.factor || 0) - (a.s.probe?.factor || 0)) ||
      (a.i - b.i))
    .map(x => x.s);
}

module.exports = {
  probeStreams, orderStreams, probeStats, slowSources,
  // Expostos para teste:
  _internals: { parseMaster, parseSegments, classify, probeOne, median },
};
