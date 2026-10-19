'use strict';
// A VixSrc passou a pôr nos playlists um domínio-isca que não existe
// (ex.: sc-u16-01.mistyreef77.boats → NXDOMAIN em qualquer DNS). O leitor do
// site troca-o pelo domínio real, que aparece na página embed
// (ex.: sc-u16-01.vix-content.net). O scraper aprende esse domínio com
// learnFromHtml() e fixUrl() faz a troca quando o host do playlist não resolve.
const dns = require('dns').promises;

let realDomain = process.env.VIXSRC_CDN_DOMAIN || null;   // ex.: vix-content.net
const resolves = new Map();   // host → { ok, ts }
const TTL = 10 * 60 * 1000;

function learnFromHtml(html) {
  const m = String(html || '').match(/\bsc-[a-z0-9-]+\.([a-z0-9-]+\.[a-z]{2,})\b/i);
  if (m && m[1] !== realDomain) {
    realDomain = m[1].toLowerCase();
    console.log(`[cdn] domínio real da VixSrc: ${realDomain}`);
  }
}

async function hostResolves(host) {
  const c = resolves.get(host);
  if (c && Date.now() - c.ts < TTL) return c.ok;
  let ok;
  try { await dns.lookup(host); ok = true; } catch (e) { ok = e.code !== 'ENOTFOUND'; }
  resolves.set(host, { ok, ts: Date.now() });
  return ok;
}

// Devolve o URL com o domínio real se o host for um "sc-xxx" que não resolve.
async function fixUrl(url) {
  if (!realDomain) return url;
  let u;
  try { u = new URL(url); } catch { return url; }
  const m = u.hostname.match(/^(sc-[a-z0-9-]+)\.(.+)$/i);
  if (!m || m[2].toLowerCase() === realDomain) return url;
  if (await hostResolves(u.hostname)) return url;
  u.hostname = `${m[1]}.${realDomain}`;
  return u.toString();
}

module.exports = { learnFromHtml, fixUrl, getRealDomain: () => realDomain };
