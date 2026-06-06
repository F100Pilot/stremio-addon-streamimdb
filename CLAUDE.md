# StreamIMDb Connector v1.4.1

## Comandos
```
npm install          # inclui puppeteer (descarrega Chromium ~300MB)
apt install -y xvfb  # display virtual p/ Chrome headful (passa Turnstile)
node server.js       # porta 7000 ou process.env.PORT
curl "http://localhost:7000/stream/movie/tt0076759.json"
```
Deploy: servidor caseiro (Proxmox, IP residencial) via PM2 + Cloudflare Tunnel.
Reiniciar: `pm2 restart stremio-addon --update-env`

**Xvfb (obrigatório):** o Turnstile detecta Chrome headless, por isso corremos
headful (`PPT_HEADLESS=false`) sob um display virtual:
```
pm2 start "Xvfb :99 -screen 0 1280x720x24 -ac" --name xvfb
# .env: DISPLAY=:99 e PPT_HEADLESS=false
pm2 restart stremio-addon --update-env && pm2 save
```

## Stack
`stremio-addon-sdk` · `express` · `axios` · `puppeteer-extra` (+stealth) ·
`xvfb` · `nodemailer` · `@movie-web/providers`

## Estrutura
- `server.js` — express + `getRouter(addon)` + landing page + proxy HLS (`/hls`, `/seg`)
- `addon.js` — manifesto `org.local.streamimdb` + `defineStreamHandler`
- `scraper.js` — orquestra fontes (cache, dedup, protecção de sobrecarga)
- `puppeteer_resolver.js` — resolve via browser real (passa Cloudflare Turnstile); lista `PROVIDERS` com fallback
- `alt_scraper.js` — tentativas axios (streamimdb.me iframe, multiembed)
- `providers.js` — fallback movie-web (requer `TMDB_API_KEY`)
- `health.js` — health checks periódicos + alertas

## Fluxo do Scraper (ordem de tentativas em `fetchVideoSource`)
1. **vaplayer** (`doFetch`) — API `streamdata.vaplayer.ru` (MORTA, 404 — mantida caso volte)
2. **alt_scraper** (axios) — extrai iframe do streamimdb.me → CDN. Falha sozinho por causa do Turnstile.
3. **puppeteer_resolver** — fonte principal funcional. Ver abaixo.
4. **movie-web providers** — último recurso (lento, ~30s timeout).

## Fluxo do Puppeteer (a parte que funciona)
O provider `streamimdb.me` → CDN `cloudorchestranova.com` adicionou **Cloudflare Turnstile**
no passo `/prorcp`, que axios não consegue passar. O resolver:
1. axios busca o embed do streamimdb.me → extrai o `src` da `#player_iframe` (URL `rcp`)
2. Lança Chromium via **puppeteer-extra + stealth**, **headful** sob Xvfb
   (browser **partilhado**, lazy, auto-fecho por inatividade)
3. `page.goto(embedUrl)` **interceptado** → serve HTML limpo só com a iframe `rcp`
   (origin = `streamimdb.me` correcta, sem os scripts de anúncio/anti-bot que apagavam a página)
4. Clica `#pl_but` → carrega `/prorcp` → **Turnstile auto-resolve** → `POST /rcp_verify`
5. Intercepta o `.m3u8` capturado na rede (ex.: `jejunejamboree.website/.../master.m3u8`)
6. Devolve `{ url, quality:'Auto', proxyable:true, referer:'https://cloudorchestranova.com/' }`

Concorrência limitada (`PPT_CONCURRENCY`), cache de 5min evita re-resolver o mesmo título.

**Headless é detectado.** O Turnstile entra num loop de challenges infinito em
headless (mesmo com stealth), mas auto-resolve em headful. Daí `PPT_HEADLESS=false`
+ Xvfb. Diagnóstico: `PPT_HEADLESS=false xvfb-run -a node diag_ppt.js`.

**Circuit breaker:** após `PPT_CB_THRESHOLD` falhas seguidas, o resolver pausa
por `PPT_CB_COOLDOWN_MS` (devolve null sem lançar browser nem tocar no Cloudflare).
Evita martelar o CDN e degradar a reputação do IP. Estado visível em `/health`.

**Redundância de fontes:** `PROVIDERS` em `puppeteer_resolver.js` é uma lista tentada em sequência.
Cada entrada tem `mode`:
- `extract` — axios busca embed → extrai a iframe do player → carrega-a em página limpa na origin
  do provider (evita anti-bot/ads). É o caminho comprovado do `streamimdb.me`.
- `direct` — carrega o embed directamente no browser (stealth + bloqueio de ads).
Para adicionar/remover fontes, edita só a lista `PROVIDERS`. As alternativas (vidsrc.net, 2embed)
são best-effort — confirmar que estão vivas antes de confiar nelas.

## Proxy HLS (`server.js`)
- Stream `proxyable:true` → `addon.js` cria `/hls/{token}.m3u8` com `{u, r}` (r = referer da fonte)
- **Token assinado (HMAC-SHA256)** via `proxy_token.js` (`sign`/`verify`) — impede
  forjar URLs arbitrárias (SSRF, fix C1). Segredo em `PROXY_SECRET`.
- `/hls` busca o manifesto com `Referer` + `Origin` **derivado do referer** (`originFromReferer`)
  — compatível com a fonte antiga (brightpathsignals) e a nova (cloudorchestranova)
- Reescreve variantes/segmentos para passarem por `/hls` e `/seg`

## Env Vars
| Variável | Default |
|---|---|
| `TMDB_API_KEY` | — (obrigatório para movie-web providers) |
| `PROXY_SECRET` | aleatório por processo (definir em .env p/ persistir tokens) |
| `PPT_HEADLESS` | `new` — **definir `false`** p/ headful sob Xvfb |
| `DISPLAY` | — (ex.: `:99`, requer Xvfb a correr) |
| `VAPLAYER_API_URL` | `https://streamdata.vaplayer.ru/api.php` |
| `CACHE_TTL_MS` | `300000` (5min) |
| `MAX_QUEUE` | `8` |
| `MAX_SEG_RETRIES` | `1` (retries on 502/403) |
| `PPT_CONCURRENCY` | `2` (resoluções Puppeteer em paralelo) |
| `PPT_NAV_TIMEOUT_MS` | `45000` |
| `PPT_PROVIDER_MS` | `22000` (tempo máx. por provider antes de passar ao seguinte) |
| `PPT_IDLE_CLOSE_MS` | `300000` (fecha browser após inatividade) |
| `PPT_CB_THRESHOLD` | `3` (falhas seguidas antes do circuit breaker) |
| `PPT_CB_COOLDOWN_MS` | `600000` (10min de pausa do circuit breaker) |
| `HEALTH_CHECK_INTERVAL_MS` | `300000` (5min) |
| `ALERT_WEBHOOK` | — (Slack/Discord) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — (alertas Telegram) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `ALERT_EMAIL` | — (alertas email) |
| `SERVER_URL` | base pública (Cloudflare Tunnel) p/ os URLs do proxy |

## Padrões
- CommonJS (`require`). `try/catch` em todos os handlers. Séries: `tt1234567:1:2` → split.

## Branches
- `Server` — branch de produção do servidor caseiro (a que o Proxmox faz pull)
- `main` / `Experimental` — histórico anterior (Render)
- `backup/working-v1` — backup estável com Puppeteer (versão antiga)

## Notas
- **Turnstile só passa em IP residencial** — em IPs de datacenter (Render) o Puppeteer falharia.
- Primeira resolução de um título demora ~10-20s (lança browser + Turnstile); seguintes vêm da cache.
- Browser partilhado + pool de concorrência mantém RAM controlada (~200-400MB) mesmo com vários utilizadores.
- bingeGroup activo — ecrã "próximo episódio" requer clique.
