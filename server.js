'use strict';
require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const http    = require('http');
const https   = require('https');
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./addon');
const { getStatus, fetchVideoSource, invalidateCache, cacheKey, getMfCache } = require('./scraper');
const { startHealthChecks, getHealthStatus } = require('./health');

const httpAgent  = new http.Agent({  keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

const START_TIME = Date.now();
startHealthChecks();

const PORT = process.env.PORT || 7000;
const SERVER_BASE = (
  process.env.RENDER_EXTERNAL_URL ||
  process.env.SERVER_URL ||
  `http://localhost:${PORT}`
).replace(/\/$/, '');

const app = express();

app.use(getRouter(addonInterface));

app.get('/', (req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>StreamIMDb Connector</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f0f13; color: #e0e0e0;
      min-height: 100vh; display: flex; flex-direction: column;
      align-items: center; justify-content: center; padding: 24px;
    }
    .card {
      background: #1a1a24; border: 1px solid #2a2a3a; border-radius: 16px;
      padding: 40px; max-width: 520px; width: 100%;
      box-shadow: 0 8px 40px rgba(0,0,0,0.4);
    }
    .logo { width: 72px; height: 72px; border-radius: 16px; margin-bottom: 20px; }
    h1 { font-size: 1.6rem; font-weight: 700; color: #fff; margin-bottom: 6px; }
    .version { font-size: 0.8rem; color: #666; margin-bottom: 12px; }
    p { color: #999; font-size: 0.95rem; line-height: 1.5; margin-bottom: 28px; }
    .btn {
      display: flex; align-items: center; justify-content: center; gap: 8px;
      padding: 12px 22px; border-radius: 10px; font-size: 0.95rem; font-weight: 600;
      text-decoration: none; border: none; cursor: pointer;
      width: 100%; margin-bottom: 12px; transition: opacity 0.2s;
    }
    .btn:hover { opacity: 0.85; }
    .btn-install { background: #7b3fe4; color: #fff; }
    .btn-donate  { background: #003087; color: #fff; }
    .divider { border: none; border-top: 1px solid #2a2a3a; margin: 24px 0; }
    .label { font-size: 0.9rem; font-weight: 600; color: #ccc; margin-bottom: 12px; }
    textarea {
      width: 100%; background: #0f0f13; border: 1px solid #2a2a3a;
      border-radius: 10px; color: #e0e0e0; padding: 12px; font-size: 0.9rem;
      resize: vertical; min-height: 90px; font-family: inherit; margin-bottom: 10px;
    }
    textarea:focus { outline: none; border-color: #7b3fe4; }
    .btn-report { background: #2a2a3a; color: #ccc; font-size: 0.9rem; }
    .tip {
      background: #12121a; border: 1px solid #2a2a3a; border-radius: 10px;
      padding: 12px 14px; font-size: 0.82rem; color: #888; line-height: 1.5; margin-top: 4px;
    }
    .tip strong { color: #bbb; }
    .footer { margin-top: 24px; font-size: 0.75rem; color: #444; text-align: center; }
    .footer a { color: #666; text-decoration: none; }
    .update-banner {
      display: none; align-items: center; gap: 10px;
      background: #1a2e1a; border: 1px solid #2d5a2d; border-radius: 10px;
      padding: 12px 16px; margin-bottom: 16px; font-size: 0.88rem; color: #7ec87e;
    }
    .update-banner a { color: #a8e6a8; font-weight: 600; text-decoration: none; }
    .update-banner a:hover { text-decoration: underline; }
    .update-dot { width: 8px; height: 8px; border-radius: 50%; background: #4caf50; flex-shrink: 0; animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  </style>
</head>
<body>
  <div class="card">
    <div class="update-banner" id="update-banner">
      <span class="update-dot"></span>
      <span>New version available: <a id="update-link" href="#" target="_blank"></a> &mdash; <a href="#">reinstall to update</a></span>
    </div>
    <img class="logo" src="https://raw.githubusercontent.com/F100Pilot/stremio-addon-streamimdb/main/icon.png" alt="icon">
    <h1>StreamIMDb Connector</h1>
    <div class="version">v1.3.0 &nbsp;·&nbsp; Movies &amp; Series</div>
    <p>Stream movies and series natively inside Stremio — no browser required.</p>
    <a class="btn btn-install" id="install-btn" href="#">&#9654; Install in Stremio</a>
    <a class="btn btn-donate" href="https://paypal.me/F100Pilot" target="_blank">&#9829; Donate via PayPal</a>
    <hr class="divider">
    <div class="label">Android tip</div>
    <div class="tip">If streams don't play on Android, go to <strong>Stremio → Settings → Player</strong> and switch to <strong>VLC</strong>. ExoPlayer (default) may fail with HLS proxy streams.</div>
    <hr class="divider">
    <div class="label">Report an issue</div>
    <textarea id="msg" placeholder="Describe the issue (e.g. movie title, what happened)..."></textarea>
    <a id="report-btn" class="btn btn-report" href="#">&#9993; Send Report</a>
  </div>
  <div class="footer">
    <a href="/manifest.json">manifest.json</a> &nbsp;·&nbsp;
    <a href="https://github.com/F100Pilot/stremio-addon-streamimdb" target="_blank">GitHub</a>
  </div>
  <script>
    document.getElementById('install-btn').href = 'stremio://' + window.location.host + '/manifest.json';
    fetch('/version-check').then(function(r){ return r.json(); }).then(function(d) {
      if (d.outdated && d.latest) {
        var banner = document.getElementById('update-banner');
        var link   = document.getElementById('update-link');
        link.textContent = 'v' + d.latest;
        link.href = d.url || 'https://github.com/F100Pilot/stremio-addon-streamimdb/releases';
        banner.querySelector('a:last-child').href = 'stremio://' + window.location.host + '/manifest.json';
        banner.style.display = 'flex';
      }
    }).catch(function(){});
    document.getElementById('report-btn').addEventListener('click', function(e) {
      e.preventDefault();
      const msg = document.getElementById('msg').value.trim();
      if (!msg) { alert('Please describe the issue first.'); return; }
      window.location.href = 'mailto:pflm.bet@gmail.com?subject=' + encodeURIComponent('StreamIMDb Report') + '&body=' + encodeURIComponent(msg);
    });
  </script>
</body>
</html>`);
});

// ── Version check ───────────────────────────────────────────────────────────
const CURRENT_VERSION = '1.2.0';
const GH_RELEASES_URL = 'https://api.github.com/repos/F100Pilot/stremio-addon-streamimdb/releases/latest';
let _versionCache = null;
let _versionCacheTs = 0;
const VERSION_CACHE_TTL = 60 * 60 * 1000; // 1h

app.get('/version-check', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const now = Date.now();
    if (!_versionCache || now - _versionCacheTs > VERSION_CACHE_TTL) {
      const ghRes = await axios.get(GH_RELEASES_URL, {
        headers: { 'User-Agent': 'stremio-addon-streamimdb', Accept: 'application/vnd.github+json' },
        timeout: 5000,
      });
      _versionCache = {
        latest: (ghRes.data.tag_name || '').replace(/^v/, ''),
        url: ghRes.data.html_url || 'https://github.com/F100Pilot/stremio-addon-streamimdb/releases',
      };
      _versionCacheTs = now;
    }
    const isOutdated = _versionCache.latest && _versionCache.latest !== CURRENT_VERSION;
    res.json({ current: CURRENT_VERSION, latest: _versionCache.latest, outdated: isOutdated, url: _versionCache.url });
  } catch {
    res.json({ current: CURRENT_VERSION, latest: null, outdated: false, url: null });
  }
});
// ─────────────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    version: '1.3.0',
    uptimeSeconds: Math.floor((Date.now() - START_TIME) / 1000),
    scraper: getStatus(),
    health: getHealthStatus(),
    memory: {
      heapUsedMB: (mem.heapUsed / 1024 / 1024).toFixed(1),
      heapTotalMB: (mem.heapTotal / 1024 / 1024).toFixed(1),
      rssMB: (mem.rss / 1024 / 1024).toFixed(1),
    },
  });
});

// ── HLS proxy ────────────────────────────────────────────────────────────────
// Stremio fetches HLS manifests and segments through these routes so that
// the CDN always receives the required Referer/Origin headers.

const PROXY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function decodeProxy(encoded) {
  try { return JSON.parse(Buffer.from(encoded, 'base64url').toString()); }
  catch { return null; }
}

function parseRefererMeta(referer) {
  if (!referer) return null;
  const tv = referer.match(/\/embed\/tv\/(tt\d+)\/(\d+)\/(\d+)/);
  if (tv) return { imdbId: tv[1], type: 'series', season: tv[2], episode: tv[3] };
  const mv = referer.match(/\/embed\/movie\/(tt\d+)/);
  if (mv) return { imdbId: mv[1], type: 'movie', season: null, episode: null };
  return null;
}

function fetchManifest(url, referer) {
  return axios.get(url, {
    headers: {
      'User-Agent': PROXY_UA,
      ...(referer ? { Referer: referer, Origin: 'https://brightpathsignals.com' } : {}),
    },
    timeout: 10000, responseType: 'text', maxRedirects: 5,
    validateStatus: s => s < 500,
    httpAgent, httpsAgent,
  });
}

// ── Segment retry: fresh base URL cache ──────────────────────────────────────
const FRESH_BASE_TTL = 60 * 1000; // 60s
const freshBases = new Map();

async function refreshBase(imdbId, type, season, episode, referer) {
  const key = cacheKey(imdbId, type, season, episode);

  // Cleanup stale entries if cache grows too large
  if (freshBases.size > 50) {
    const now = Date.now();
    for (const [k, v] of freshBases) {
      if (now - v.timestamp > FRESH_BASE_TTL) freshBases.delete(k);
    }
  }

  // Check fresh base cache
  const cached = freshBases.get(key);
  if (cached && Date.now() - cached.timestamp < FRESH_BASE_TTL) {
    console.log(`[proxy/seg] freshBase cache hit: ${key}`);
    return cached.base;
  }

  // Invalidate scraper cache and get fresh stream URL
  invalidateCache(imdbId, type, season, episode);
  const fresh = await fetchVideoSource(imdbId, type, season, episode);
  const streamUrl = fresh?.streams?.[0]?.url;
  if (!streamUrl) return null;

  // Fetch the manifest to determine the base
  let manifestUrl = streamUrl;
  let manifestRes;
  try {
    manifestRes = await fetchManifest(manifestUrl, referer);
  } catch { return null; }

  if (manifestRes.status !== 200) return null;

  const body = typeof manifestRes.data === 'string' ? manifestRes.data : '';

  // If it's a master playlist, fetch the best variant sub-playlist
  if (body.includes('#EXT-X-STREAM-INF:')) {
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
      const urlLine = lines[i + 1]?.trim();
      if (!urlLine || urlLine.startsWith('#')) continue;
      let variantUrl; try { variantUrl = new URL(urlLine, manifestUrl).href; } catch { variantUrl = urlLine; }
      try {
        const variantRes = await fetchManifest(variantUrl, referer);
        if (variantRes.status === 200) {
          const newBase = variantUrl.substring(0, variantUrl.lastIndexOf('/') + 1);
          freshBases.set(key, { base: newBase, timestamp: Date.now() });
          console.log(`[proxy/seg] freshBase refreshed (variant): ${key}`);
          return newBase;
        }
      } catch { /* try next variant */ }
    }
    return null;
  }

  // Media playlist — base is the directory of the manifest URL
  const newBase = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);
  freshBases.set(key, { base: newBase, timestamp: Date.now() });
  console.log(`[proxy/seg] freshBase refreshed (media): ${key}`);
  return newBase;
}
// ─────────────────────────────────────────────────────────────────────────────

// Proxy an HLS manifest (.m3u8): fetches with Referer, rewrites URIs back through us.
// On upstream failure (5xx/timeout) tries one cache-invalidating refresh via the scraper.
app.all('/hls/:encoded.m3u8', async (req, res) => {
  if (req.method === 'HEAD' || req.method === 'OPTIONS') {
    res.set('Content-Type', 'application/x-mpegURL');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Range, Content-Type');
    return res.status(200).end();
  }
  const data = decodeProxy(req.params.encoded);
  if (!data?.u) return res.status(400).send('Bad request');

  let manifestUrl = data.u;
  let upstream = null;

  const cachedBody = getMfCache(manifestUrl);
  if (cachedBody) {
    console.log('[proxy/hls] manifest servido do mfCache');
    const base = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);
    const ref  = data.r || '';
    const body = cachedBody.split('\n').map(line => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      let abs; try { abs = new URL(t, manifestUrl).href; } catch { abs = t; }
      const enc = Buffer.from(JSON.stringify({ u: abs, r: ref, b: base })).toString('base64url');
      return abs.includes('.m3u8')
        ? `${SERVER_BASE}/hls/${enc}.m3u8`
        : `${SERVER_BASE}/seg/${enc}.ts`;
    }).join('\n');
    res.set('Content-Type', 'application/x-mpegURL');
    res.set('Cache-Control', 'no-cache');
    res.set('Access-Control-Allow-Origin', '*');
    return res.send(body);
  }

  try {
    upstream = await fetchManifest(manifestUrl, data.r);
  } catch (err) {
    console.error('[proxy/hls] upstream falhou:', err.message);
    const meta = parseRefererMeta(data.r);
    if (meta) {
      invalidateCache(meta.imdbId, meta.type, meta.season, meta.episode);
      try {
        const fresh = await fetchVideoSource(meta.imdbId, meta.type, meta.season, meta.episode);
        const url = fresh?.streams?.[0]?.url;
        if (url && url !== manifestUrl) {
          console.log('[proxy/hls] refresh ok — novo URL adquirido');
          manifestUrl = url;
          upstream = await fetchManifest(manifestUrl, data.r).catch(e => {
            console.error('[proxy/hls] refresh upstream falhou:', e.message);
            return null;
          });
        }
      } catch (e) {
        console.error('[proxy/hls] refresh erro:', e.message);
      }
    }
    if (!upstream) return res.status(502).send('Proxy error');
  }

  if (upstream.status !== 200) return res.status(upstream.status).send('CDN error');

  const base = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);
  const ref  = data.r || '';
  const body = upstream.data.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    let abs; try { abs = new URL(t, manifestUrl).href; } catch { abs = t; }
    const enc = Buffer.from(JSON.stringify({ u: abs, r: ref, b: base })).toString('base64url');
    return abs.includes('.m3u8')
      ? `${SERVER_BASE}/hls/${enc}.m3u8`
      : `${SERVER_BASE}/seg/${enc}.ts`;
  }).join('\n');

  res.set('Content-Type', 'application/x-mpegURL');
  res.set('Cache-Control', 'no-cache');
  res.set('Access-Control-Allow-Origin', '*');
  res.send(body);
});

// Proxy an HLS segment (.ts / .aac / etc.): streams bytes from CDN with Referer.
// On upstream failure (5xx/timeout/403), tries one refresh via scraper to get a
// fresh CDN base URL and retries the segment with the new token.
app.all('/seg/:encoded.ts', async (req, res) => {
  if (req.method === 'HEAD' || req.method === 'OPTIONS') {
    res.set('Content-Type', 'video/MP2T');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Range, Content-Type');
    res.set('Accept-Ranges', 'bytes');
    return res.status(200).end();
  }
  const data = decodeProxy(req.params.encoded);
  if (!data?.u) return res.status(400).send('Bad request');

  const MAX_SEG_RETRIES = parseInt(process.env.MAX_SEG_RETRIES) || 1;
  let segmentUrl = data.u;
  const referer  = data.r || '';
  const oldBase  = data.b || '';

  for (let attempt = 0; attempt <= MAX_SEG_RETRIES; attempt++) {
    try {
      const upstream = await axios.get(segmentUrl, {
        headers: {
          'User-Agent': PROXY_UA,
          ...(referer ? { Referer: referer, Origin: 'https://brightpathsignals.com' } : {}),
          ...(req.headers.range ? { Range: req.headers.range } : {}),
        },
        timeout: 30000, responseType: 'stream', maxRedirects: 5,
        httpAgent, httpsAgent,
      });
      res.status(upstream.status);
      ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control'].forEach(h => {
        if (upstream.headers[h]) res.set(h, upstream.headers[h]);
      });
      if (!upstream.headers['accept-ranges']) res.set('Accept-Ranges', 'bytes');
      res.set('Access-Control-Allow-Origin', '*');

      let closed = false;
      req.on('close', () => { closed = true; upstream.data.destroy(); });
      upstream.data.on('error', (e) => {
        if (closed) return;
        console.error('[proxy/seg] upstream stream error:', e.message);
        if (!res.headersSent) res.status(502).end();
        else res.end();
      });
      upstream.data.pipe(res);
      return; // success
    } catch (err) {
      const status = err.response?.status;
      const retryable = !status || status === 403 || status >= 502;
      console.error(`[proxy/seg] attempt ${attempt + 1}/${MAX_SEG_RETRIES + 1} failed (${status || 'network'}): ${err.message}`);

      if (attempt < MAX_SEG_RETRIES && retryable && oldBase && segmentUrl.startsWith(oldBase)) {
        const meta = parseRefererMeta(referer);
        if (meta) {
          try {
            const newBase = await refreshBase(meta.imdbId, meta.type, meta.season, meta.episode, referer);
            if (newBase && newBase !== oldBase) {
              const relativePath = segmentUrl.slice(oldBase.length);
              segmentUrl = newBase + relativePath;
              console.log(`[proxy/seg] retry ${attempt + 1} with refreshed base`);
              continue;
            }
          } catch (e) {
            console.error('[proxy/seg] refreshBase failed:', e.message);
          }
        }
      }

      if (!res.headersSent) res.status(502).send('Proxy error');
      return;
    }
  }
});
// ─────────────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`Add-on disponível em http://localhost:${PORT}/manifest.json`);
  console.log(`HTTP addon accessible at: http://127.0.0.1:${PORT}/manifest.json`);
});

// Cloudflare Tunnel reuses upstream TCP connections. Node's default 5s
// keepAliveTimeout can cause connection resets and a visible first-request delay.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
