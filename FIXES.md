# Security Audit — StreamIMDb Connector v1.4.1

Data: 2026-06-06

---

## CRÍTICO

### C1 — Proxy HLS aberto (SSRF)

**Ficheiro:** `server.js` — rotas `/hls/:encoded` e `/seg/:encoded`

O payload `{ u, r, b }` é base64url-encoded mas não autenticado.
Qualquer pessoa que saiba o esquema de codificação pode construir uma URL
arbitrária e forçar o servidor a fazer pedidos HTTP em nome próprio —
incluindo endereços internos da rede local (router, NAS, outros serviços no
Proxmox).

```
# Exemplo de abuso:
echo -n '{"u":"http://192.168.1.1/","r":""}' | base64 | curl http://addon/hls/<base64>.m3u8
```

**Risco:** SSRF — acesso a serviços internos (router, Proxmox API, NAS).

**Correção sugerida:** Assinar os payloads com HMAC-SHA256 e rejeitar
qualquer payload sem assinatura válida.

```js
const crypto = require('crypto');
const PROXY_SECRET = process.env.PROXY_SECRET || crypto.randomBytes(32).toString('hex');

function signPayload(obj) {
  const data = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const sig = crypto.createHmac('sha256', PROXY_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyPayload(token) {
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const expected = crypto.createHmac('sha256', PROXY_SECRET).update(data).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try { return JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { return null; }
}
```

Aplicar em `makeHlsProxyUrl` (addon.js) e nos handlers `/hls`/`/seg` (server.js).

---

## ALTO

### A1 — Endpoint `/health` público expõe dados sensíveis

**Ficheiro:** `server.js` linha 171

O endpoint `/health` é acessível sem autenticação e expõe:
- Uso de memória do processo
- Cache do scraper (inclui IMDb IDs de conteúdos a ser streamados)
- Estado do health check e configuração
- Uptime do servidor

**Correção sugerida:** Proteger com uma chave secreta ou restringir a
`localhost`.

```js
app.get('/health', (req, res) => {
  const token = req.headers['x-health-token'] || req.query.token;
  if (process.env.HEALTH_TOKEN && token !== process.env.HEALTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // ... resto do handler
});
```

Adicionar `HEALTH_TOKEN=<random>` ao `.env`.

---

### A2 — Sem rate limiting em nenhum endpoint

**Ficheiro:** `server.js`

Qualquer IP pode:
- Fazer pedidos ilimitados ao scraper (Puppeteer usa RAM e CPU elevados)
- Usar o proxy HLS para fazer download maciço via o servidor
- Esgotar o pool de concorrência do Puppeteer com pedidos simultâneos

O `MAX_QUEUE` do scraper não é por IP — protege contra sobrecarga interna
mas não contra abuso externo.

**Correção sugerida:** Instalar `express-rate-limit`.

```js
const rateLimit = require('express-rate-limit');

const streamLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minuto
  max: 30,               // 30 pedidos por IP por minuto
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/stream/', streamLimiter);

const proxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,              // segmentos HLS são frequentes
});
app.use('/hls/', proxyLimiter);
app.use('/seg/', proxyLimiter);
```

---

### A3 — Validação insuficiente dos IDs IMDb e parâmetros de série

**Ficheiro:** `scraper.js` linha 201, `addon.js` linha 34–38

Apenas se verifica `imdbId.startsWith('tt')`. Valores como `tt` (sem
números), `tt` com letras, ou season/episode negativos/não-numéricos passam
sem erro. Strings longas arbitrárias são aceites e propagadas para pedidos
externos.

**Correção sugerida:**

```js
// Em scraper.js ou addon.js
const IMDB_RE = /^tt\d{7,8}$/;
const NUM_RE  = /^\d{1,4}$/;

function validateArgs(imdbId, type, season, episode) {
  if (!IMDB_RE.test(imdbId)) throw new Error(`IMDb ID inválido: ${imdbId}`);
  if (type === 'series') {
    if (!NUM_RE.test(season))  throw new Error(`Season inválido: ${season}`);
    if (!NUM_RE.test(episode)) throw new Error(`Episode inválido: ${episode}`);
  }
}
```

---

## MÉDIO

### M1 — Email pessoal exposto no HTML da landing page

**Ficheiro:** `server.js` linha 134

```js
window.location.href = 'mailto:pflm.bet@gmail.com?subject=...'
```

O endereço de email está hardcoded no HTML servido publicamente. Bots de
harvesting de email indexam este tipo de endereços.

**Correção sugerida:** Mover para variável de ambiente e omitir o botão de
report se não estiver configurado, ou usar um formulário que envia
internamente sem expor o email.

```js
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || '';
// No HTML:
${CONTACT_EMAIL ? `
  <textarea id="msg" ...></textarea>
  <a id="report-btn" ...>Send Report</a>
  <script>
    document.getElementById('report-btn').addEventListener('click', function(e) {
      e.preventDefault();
      const msg = document.getElementById('msg').value.trim();
      if (!msg) { alert('Please describe the issue first.'); return; }
      window.location.href = 'mailto:${CONTACT_EMAIL}?subject=...';
    });
  </script>
` : ''}
```

---

### M2 — CORS demasiado permissivo (`*`) em endpoints sensíveis

**Ficheiro:** `server.js` linhas 149, 299, 380, 409

`Access-Control-Allow-Origin: *` está definido em `/version-check`,
`/hls`, `/seg` e `/health`. Isto permite que qualquer website no browser
do utilizador faça pedidos a estes endpoints e leia as respostas (incluindo
conteúdo do proxy e dados de saúde).

Para uso privado/doméstico, o CORS aberto é desnecessário.

**Correção sugerida:** Restringir ao domínio do Cloudflare Tunnel ou
apenas ao Stremio (que usa o CORS para os manifests, não para os
proxies).

```js
const ALLOWED_ORIGIN = process.env.SERVER_URL || '*';
// Nos endpoints proxy:
res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
```

---

### M3 — Ausência de headers de segurança HTTP na landing page

**Ficheiro:** `server.js` rota `GET /`

A página HTML não inclui headers de segurança básicos:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Content-Security-Policy`
- `Referrer-Policy: no-referrer`

**Correção sugerida:** Adicionar middleware global para headers de
segurança.

```js
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy',
    "default-src 'self'; script-src 'unsafe-inline'; img-src * data:; style-src 'unsafe-inline'");
  next();
});
```

---

### M4 — Crescimento ilimitado da cache de manifests HLS

**Ficheiro:** `scraper.js` linhas 17–28

`mfCache` cresce sem limite máximo — a limpeza só acontece em escrita.
`cache` (streams) também não tem limite de entradas.
Com muitos títulos únicos (ou abuso deliberado), a memória pode esgotar.

**Correção sugerida:** Adicionar limite máximo de entradas.

```js
const MF_CACHE_MAX = 100;

function setMfCache(url, body) {
  if (mfCache.size >= MF_CACHE_MAX) {
    // Remove a entrada mais antiga
    mfCache.delete(mfCache.keys().next().value);
  }
  mfCache.set(url, { body, ts: Date.now() });
  for (const [k, v] of mfCache) if (Date.now() - v.ts > MF_TTL) mfCache.delete(k);
}
```

---

## BAIXO

### B1 — Dependências com versões não pinadas

**Ficheiro:** `package.json`

Todas as dependências usam `^` (minor/patch updates automáticos). Uma
actualização automática de `puppeteer`, `@movie-web/providers` ou `axios`
pode introduzir regressões ou vulnerabilidades.

**Correção sugerida:** Após `npm install`, commitar o `package-lock.json`
e usar `npm ci` em vez de `npm install` no servidor. Considerar pinagem
exacta (`"puppeteer": "23.x.x"`) para dependências críticas.

---

### B2 — User-Agent fixo e desactualizado

**Ficheiro:** `scraper.js`, `alt_scraper.js`, `puppeteer_resolver.js`, `health.js`

O UA `Chrome/124` está hardcoded em múltiplos ficheiros. O Chrome está
actualmente na versão 136+. Um UA muito desactualizado pode ser
identificado como bot por alguns CDNs.

**Correção sugerida:** Centralizar num único módulo e actualizar
periodicamente.

```js
// utils.js
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
module.exports = { UA };
```

---

### B3 — Logs podem revelar URLs de stream com tokens

**Ficheiro:** `scraper.js` linha 158, `puppeteer_resolver.js` linha 172

URLs de stream (m3u8) com tokens de sessão são logadas em claro:
```
[puppeteer:streamimdb] ✓ m3u8: https://jejunejamboree.website/hls/abc123token.../master.m3u8...
```

Tokens de stream capturados nos logs ficam acessíveis a quem tiver acesso
aos logs do PM2.

**Correção sugerida:** Truncar ou anonimizar a parte do token na URL
antes de logar (manter apenas o domínio + path sem query strings ou
segmentos aleatórios).

---

## Sumário

| ID  | Severidade | Esforço | Estado |
|-----|-----------|---------|--------|
| C1  | Crítico   | Alto    | ✅ Resolvido (HMAC em proxy_token.js) |
| A1  | Alto      | Baixo   | Aberto |
| A2  | Alto      | Baixo   | Aberto |
| A3  | Alto      | Baixo   | Aberto |
| M1  | Médio     | Baixo   | Aberto |
| M2  | Médio     | Baixo   | Aberto |
| M3  | Médio     | Baixo   | Aberto |
| M4  | Médio     | Baixo   | Aberto |
| B1  | Baixo     | Baixo   | Aberto |
| B2  | Baixo     | Baixo   | Aberto |
| B3  | Baixo     | Baixo   | Aberto |

**Prioridade recomendada:** C1 → A1 → A2 → A3
