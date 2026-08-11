# StreamIMDb Connector v1.4.1

## Comandos
```
npm install          # puppeteer é optionalDependency (Chromium ~300MB)
node server.js       # porta 7000 ou process.env.PORT
curl "http://localhost:7000/stream/movie/tt0076759.json"
```
Deploy: servidor caseiro (Proxmox, IP residencial) via PM2 + Cloudflare Tunnel.
Reiniciar: `pm2 restart stremio-addon --update-env`

**O Xvfb já não é preciso.** Era necessário para correr o Chrome headful e
passar o Cloudflare Turnstile do `streamimdb.me`. Essa fonte foi removida; as
cadeias actuais (vidsrc & cia) não têm Turnstile e resolvem bem em headless.
Se o PM2 ainda arranca `bash -c "xvfb-run -a node server.js"`, simplifica para
`node server.js`.

No Vercel não há Chromium: o `browser_resolver` é um no-op silencioso e o
fluxo cai no upstream relay. Convém `PUPPETEER_SKIP_DOWNLOAD=true` no build
para não descarregar 300MB que lá não servem para nada.

## Stack
`stremio-addon-sdk` · `express` · `axios` · `nodemailer`
· `puppeteer-extra` (+stealth) — **opcional**, só onde há Chromium

## Estrutura
- `server.js` — express + `getRouter(addon)` + landing page + proxy HLS (`/hls`, `/seg`)
- `addon.js` — manifesto `org.local.streamimdb` + `defineStreamHandler`
- `scraper.js` — orquestra fontes (cache, dedup, protecção de sobrecarga)
- `datacenter_scraper.js` — VixSrc + Vidlink (só axios, funciona em datacenter)
- `browser_resolver.js` — resolve via browser real; lista `PROVIDERS` tentada em sequência
- `tmdb.js` — conversão IMDb → TMDB (com cache); usada pelas fontes que indexam por TMDB
- `upstream_relay.js` — encaminha para outro deployment do addon (servidor caseiro)
- `health.js` — health checks periódicos + alertas

## Fluxo do Scraper (ordem de tentativas em `fetchVideoSource`)
1. **datacenter_scraper** (axios) — VixSrc e Vidlink. Rápido, sem browser.
2. **browser_resolver** — precisa de Chromium; no Vercel é saltado em silêncio.
3. **upstream relay** — `UPSTREAM_URL` aponta ao servidor caseiro. No-op sem a var.

**Fontes removidas** (ver secção própria): `alt_scraper.js` (streamimdb.me,
morto pelo Turnstile) e `providers.js` (movie-web, 11 providers todos mortos).

## Fluxo do Browser (`browser_resolver.js`)
Nestas cadeias o URL final do `.m3u8` é descodificado em **WebAssembly** já
dentro do player — não há caminho axios que o replique. A solução é deixar a
página correr e apanhar o `.m3u8` quando passa na rede.

Ao contrário do antigo `puppeteer_resolver`, **nenhum destes passos tem
Cloudflare Turnstile**. Era o loop infinito de challenges que obrigava a
headful + Xvfb; sem ele, headless chega e gasta menos.

Cada entrada de `PROVIDERS` tem um `mode`:
- `chain` — axios segue os iframes (até `MAX_HOPS`) até encontrar
  `window.CFG.playerUrl`, e só entrega ao browser a última página (a do WASM).
  Mais barato e determinista do que carregar a cadeia toda no Chromium, e evita
  ter de clicar em iframes aninhados. É o caminho comprovado do `vidsrc.in`.
  Se o CFG tiver `metaApi`, lê de lá as legendas próprias da fonte e o nome do
  release — as legendas desta fonte estão em sincronia com ESTE encode.
- `direct` — carrega o embed directamente no browser, bloqueia anúncios e clica
  no play em ciclo (em todas as frames) até o m3u8 aparecer.

Browser partilhado e lazy, semáforo (`BROWSER_CONCURRENCY`), auto-fecho por
inatividade e circuit breaker após `BROWSER_CB_THRESHOLD` falhas seguidas.
Estado em `getStatus()`.

**Só o `vidsrc.in` está comprovado.** As restantes fontes da lista vieram da
sonda `diag_newsrc.js`, que só mede se o site responde a um GET — o que não é o
mesmo que entregar vídeo. Para saber quais prestam:
```
node diag_browser_sources.js                       # filme por defeito
node diag_browser_sources.js tt4655480 series 1 1  # episódio
BROWSER_DEBUG=1 node diag_browser_sources.js       # rede, frames e erros
```
Corre isto **no servidor caseiro**: de um datacenter as CDNs bloqueiam o IP e
tudo parece morto. No fim o script imprime a linha `BROWSER_PROVIDERS=...` com
as fontes que entregaram m3u8 — mete-a no `.env` para podar a lista.

Nota para quem mexer no diag: o `browser_resolver` lê as variáveis de ambiente
no `require`, não a cada chamada. Defini-las depois do require não tem efeito.

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
| `TMDB_API_KEY` | — (obrigatório: VixSrc, Vidlink e as fontes `id:'tmdb'` do browser) |
| `TMDB_CACHE_TTL_MS` | `3600000` (1h de cache da conversão IMDb → TMDB) |
| `PROXY_SECRET` | aleatório por processo (definir em .env p/ persistir tokens) |
| `VIXSRC_LANG` | `en` (língua pedida à VixSrc no URL do playlist) |
| `CACHE_TTL_MS` | `300000` (5min) |
| `MAX_QUEUE` | `8` |
| `MAX_SEG_RETRIES` | `1` (retries on 502/403) |
| `BROWSER_PROVIDERS` | — lista/ordem de fontes (ex.: `vidsrc.in,embed.su`); vazio = todas |
| `BROWSER_HEADLESS` | `new` (`false` só se precisares de ver o browser) |
| `BROWSER_CONCURRENCY` | `2` (resoluções em paralelo) |
| `BROWSER_NAV_TIMEOUT_MS` | `30000` |
| `BROWSER_PROVIDER_MS` | `25000` (tempo máx. por fonte antes de passar à seguinte) |
| `BROWSER_IDLE_CLOSE_MS` | `300000` (fecha browser após inatividade) |
| `BROWSER_CB_THRESHOLD` | `5` (falhas seguidas antes do circuit breaker) |
| `BROWSER_CB_COOLDOWN_MS` | `600000` (10min de pausa do circuit breaker) |
| `BROWSER_PROXYABLE` | `true` (servir via `/hls`; `false` entrega o URL directo) |
| `BROWSER_DEBUG` | — `1` despeja rede, frames e erros da página |
| `HEALTH_CHECK_INTERVAL_MS` | `300000` (5min) |
| `ALERT_WEBHOOK` | — (Slack/Discord) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — (alertas Telegram) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `ALERT_EMAIL` | — (alertas email) |
| `SERVER_URL` | base pública (Cloudflare Tunnel) p/ os URLs do proxy |
| `UPSTREAM_URL` | — relay p/ outro deployment do addon (ex.: servidor caseiro) como último recurso |
| `UPSTREAM_TIMEOUT_MS` | `25000` (timeout do relay; 1ª resolução no upstream pode demorar) |

## Upstream relay (Vercel → servidor caseiro)
A VixSrc passou a devolver **403 logo na API** a IPs de datacenter (confirmado
pelo health check no Vercel: `API DOWN: VixSrc status 403, sem src`), deixando
o deploy do Vercel sem fontes. `upstream_relay.js` acrescenta um último recurso:
com `UPSTREAM_URL` definido (ex.: o domínio público do servidor caseiro via
Cloudflare Tunnel), o Vercel pede `GET {UPSTREAM_URL}/stream/{type}/{id}.json`
e entrega os streams do upstream **directos ao cliente** (`proxyable:false` —
os URLs já passam pelo proxy `/hls` do upstream, que tem o IP residencial bom).
Sem a var, é um no-op. O health check também testa o upstream antes de declarar
DOWN (estado "degradado" = VixSrc 403 mas relay OK).

## Fontes removidas
- **`alt_scraper.js`** (streamimdb.me + multiembed.mov) — o `streamimdb.me` pôs
  Cloudflare Turnstile no passo `/prorcp` e axios não passa por lá. Nunca foi
  visto a resolver nada. O fallback `externalUrl` do `addon.js`, que mandava as
  pessoas para o embed do streamimdb.me, passou a apontar ao `vidsrc.in`.
- **`providers.js`** (movie-web) — os 11 providers estavam todos mortos e ainda
  assim eram chamados, com ~30s de timeout, em cada pedido sem stream. O
  `convertImdbToTmdb` que vivia aqui mudou-se para `tmdb.js`, porque o
  `datacenter_scraper` e o `browser_resolver` precisam dele.
- `@movie-web/providers` saiu das dependências.

Se alguma delas ressuscitar, o histórico tem o código: `git show <commit>^:alt_scraper.js`.

## Padrões
- CommonJS (`require`). `try/catch` em todos os handlers. Séries: `tt1234567:1:2` → split.

## Branches
- `Server` — branch de produção do servidor caseiro (a que o Proxmox faz pull)
- `main` / `Experimental` — histórico anterior (Render)
- `backup/working-v1` — backup estável com Puppeteer (versão antiga)

## Notas
- **As CDNs bloqueiam IPs de datacenter.** A VixSrc devolve 403 logo na API a
  partir do Vercel. Qualquer sonda a fontes tem de correr no servidor caseiro
  para dar resultados que signifiquem alguma coisa.
- Primeira resolução de um título demora ~10-20s (lança browser); seguintes vêm da cache.
- Browser partilhado + pool de concorrência mantém RAM controlada (~200-400MB) mesmo com vários utilizadores.
- bingeGroup activo — ecrã "próximo episódio" requer clique.
