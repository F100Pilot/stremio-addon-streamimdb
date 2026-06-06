'use strict';
const crypto = require('crypto');

// PROXY_SECRET deve ser definido em .env. Se não estiver, gera um aleatório
// por processo — URLs geradas numa sessão são inválidas após reiniciar,
// o que é aceitável (Stremio re-resolve o stream).
const SECRET = process.env.PROXY_SECRET || crypto.randomBytes(32).toString('hex');

function sign(obj) {
  const data = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verify(token) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const data = token.slice(0, dot);
  const sig  = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  try {
    // timingSafeEqual requires equal-length buffers
    const sigBuf = Buffer.from(sig,      'base64url');
    const expBuf = Buffer.from(expected, 'base64url');
    if (sigBuf.length !== expBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    return JSON.parse(Buffer.from(data, 'base64url').toString());
  } catch {
    return null;
  }
}

module.exports = { sign, verify };
