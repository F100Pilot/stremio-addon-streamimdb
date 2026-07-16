# Deploy do StreamIMDb Connector no Vercel (ou plataforma idêntica)

Este tutorial explica como pôr o addon a correr num serviço serverless
gratuito como o **Vercel**. Aplica-se também, com pequenas diferenças, a
Netlify, Railway, Render e Fly.io (ver secção final).

> **Nota importante sobre IPs de datacenter:** algumas fontes (VixSrc, vidsrc.cc,
> 2embed, multiembed) bloqueiam pedidos vindos de IPs de datacenter com 403.
> No Vercel só funcionam as fontes que aceitam datacenter (actualmente o
> **Vidlink**) e, opcionalmente, o **relay para um servidor caseiro**
> (`UPSTREAM_URL`). É por isso que a branch `main` (Vercel) usa
> `proxyable: false` — o cliente Stremio busca o stream directo com o IP
> residencial dele.

## 1. Pré-requisitos

- Conta no [vercel.com](https://vercel.com) (o plano gratuito Hobby chega)
- O repositório no GitHub (fork ou o teu próprio)
- Uma **TMDB API key** gratuita: [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api)

## 2. Ficheiros necessários (já existem na branch `main`)

O Vercel corre funções serverless, não um servidor persistente. Dois ficheiros
fazem a adaptação:

**`vercel.json`** — encaminha todos os pedidos para a função:
```json
{
  "version": 2,
  "rewrites": [
    { "source": "/(.*)", "destination": "/api/index" }
  ]
}
```

**`api/index.js`** — exporta a app Express:
```js
'use strict';
module.exports = require('../server');
```

E no fim de `server.js`, o `app.listen` só corre fora do Vercel
(a plataforma define `process.env.VERCEL` automaticamente):
```js
if (!process.env.VERCEL) {
  app.listen(PORT, ...);
}
module.exports = app;
```

> Se fores fazer deploy a partir da branch `Server`, confirma que estes três
> pontos existem — a `main` já os tem todos.

## 3. Criar o projecto no Vercel

1. Entra em [vercel.com/new](https://vercel.com/new)
2. **Import Git Repository** → escolhe `stremio-addon-streamimdb`
3. Em **Branch**, escolhe `main` (a branch preparada para serverless)
4. Framework Preset: **Other** (não escolhas Next.js etc.)
5. Build settings: deixa tudo por defeito (não há build; o `npm install` é automático)
6. Clica **Deploy**

## 4. Variáveis de ambiente

Em **Project Settings → Environment Variables**, adiciona:

| Variável | Valor | Obrigatória? |
|---|---|---|
| `TMDB_API_KEY` | a tua chave TMDB | **Sim** (conversão IMDb→TMDB) |
| `PROXY_SECRET` | string aleatória (`openssl rand -hex 32`) | Recomendada |
| `SERVER_URL` | `https://<o-teu-projecto>.vercel.app` | Recomendada |
| `UPSTREAM_URL` | URL público do teu servidor caseiro (Cloudflare Tunnel) | Opcional — relay de último recurso |
| `ALERT_WEBHOOK` / `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | p/ alertas | Opcional |

Depois de alterar env vars: **Deployments → ⋯ → Redeploy**.

## 5. Testar

```bash
# manifesto
curl https://<projecto>.vercel.app/manifest.json

# um filme (Star Wars 1977)
curl https://<projecto>.vercel.app/stream/movie/tt0076759.json

# saúde e diagnóstico das fontes a partir do IP do Vercel
curl https://<projecto>.vercel.app/health
curl https://<projecto>.vercel.app/diag/sources
```

Se `/diag/sources` mostrar `looksUsable: true` numa fonte, ela funciona a
partir do datacenter do Vercel.

## 6. Instalar no Stremio

Abre `https://<projecto>.vercel.app` no browser e clica **Install in Stremio**,
ou cola directamente no Stremio (Add-ons → paste URL):

```
https://<projecto>.vercel.app/manifest.json
```

## 7. Limites do plano gratuito do Vercel a ter em conta

- **Timeout de função:** 10s no Hobby por defeito (configurável até 60s em
  `vercel.json` com `"functions": { "api/index.js": { "maxDuration": 60 } }`).
  Resoluções lentas (movie-web ~30s, upstream relay ~25s) podem estourar o
  limite por defeito — vale a pena subir o `maxDuration`.
- **Sem estado persistente:** a cache em memória (`scraper.js`) só vive
  enquanto a instância da função estiver quente. Funciona, mas os cache hits
  são menos frequentes do que num servidor sempre ligado.
- **Sem Puppeteer/Chromium:** não é viável em serverless (tamanho e timeout).
  A `main` já não depende disso.
- **Largura de banda:** se usares `proxyable: true` (proxy /hls no Vercel),
  todo o vídeo passa pela função — rebenta rapidamente os limites do plano
  gratuito. Mantém `proxyable: false` no Vercel.

## 8. Alternativas ao Vercel

| Plataforma | Diferenças |
|---|---|
| **Railway / Render / Fly.io** | Correm o `node server.js` como servidor normal (não serverless) — não precisas de `api/index.js` nem `vercel.json`, basta definir o start command `npm start` e as mesmas env vars. Timeouts deixam de ser problema; free tier do Render adormece após inactividade. |
| **Netlify** | Semelhante ao Vercel mas as functions usam outro formato — seria preciso adaptar (`netlify.toml` + wrapper). Não recomendado sem trabalho extra. |
| **VPS (Hetzner, Oracle Free, etc.)** | Igual ao servidor caseiro: `git clone`, `npm install`, PM2. Mas é IP de datacenter — as mesmas fontes bloqueadas do Vercel. |

Em **qualquer** opção de datacenter, a limitação de fundo é a mesma: as fontes
que bloqueiam datacenter continuam bloqueadas. O combo mais robusto é
**Vercel (frontend sempre disponível) + `UPSTREAM_URL` a apontar para o
servidor caseiro** (IP residencial), que é exactamente a arquitectura actual.
