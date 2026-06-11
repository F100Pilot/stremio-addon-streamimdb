# StreamIMDb Connector v1.4.1

## Comandos
```
npm install
node server.js       # porta 7000 ou process.env.PORT
curl "http://localhost:7000/stream/movie/tt0076759.json"
```
Deploy: servidor caseiro (Proxmox, IP residencial) via PM2 + Cloudflare Tunnel.
Reiniciar: `pm2 restart stremio-addon --update-env`

## Stack
`stremio-addon-sdk` · `express` · `axios` · `nodemailer` · `@movie-web/providers`

## Estrutura
- `server.js` — express + `getRouter(addon)` + landing page + proxy HLS (`/hls`, `/seg`)
- `addon.js` — manifesto `org.local.streamimdb` + `defineStreamHandler`
- `scraper.js` — orquestra fontes (cache, dedup, protecção de sobrecarga)
- `alt_scraper.js` — tentativas axios (streamimdb.me iframe, multiembed)
- `providers.js` — fallback movie-web (requer `TMDB_API_KEY`)
- `datacenter_scraper.js` — fontes que funcionam de IPs de datacenter (VixSrc, Vidlink), só axios
- `health.js` — health checks periódicos + alertas
- `diag_proxy.js` — testa a cadeia HLS completa (master→variante→segmento) via domínio público
- `diag_subs.js` — despeja faixas de legendas (`#EXT-X-MEDIA:TYPE=SUBTITLES`) do master m3u8

## Fluxo do Scraper (ordem de tentativas em `fetchVideoSource`)
1. **datacenter_scraper** (VixSrc, Vidlink — só axios) — fonte principal.
2. **alt_scraper** (axios) — extrai iframe do streamimdb.me → CDN. Best-effort
   (mantido como fallback leve, sem garantia de funcionar).
3. **movie-web providers** — último recurso (lento, ~30s timeout).

> **Nota histórica:** o `puppeteer_resolver.js` (Chromium+Xvfb p/ passar o
> Cloudflare Turnstile do streamimdb.me) foi removido — essa fonte deixou de
> funcionar de forma fiável e o `datacenter_scraper` (VixSrc/Vidlink) cobre o
> essencial sem o custo de RAM/Xvfb e sem os falsos alertas de "Puppeteer
> bloqueado". Se for preciso reaver, está no histórico do git antes desta
> remoção.

## Proxy HLS (`server.js`)
- Stream `proxyable:true` → `addon.js` cria `/hls/{token}.m3u8` com `{u, r}` (r = referer da fonte)
- **Token assinado (HMAC-SHA256)** via `proxy_token.js` (`sign`/`verify`) — impede
  forjar URLs arbitrárias (SSRF, fix C1). Segredo em `PROXY_SECRET`.
- `/hls` busca o manifesto com `Referer` + `Origin` **derivado do referer** (`originFromReferer`)
  — compatível com a fonte antiga (brightpathsignals) e a nova (cloudorchestranova)
- Reescreve variantes/segmentos para passarem por `/hls` e `/seg`

### `proxyable: true` vs `false` — depende de QUEM tem o IP "bom"
A decisão não é fixa: depende de qual lado da ligação (servidor ou cliente Stremio)
tem o IP "bom" para a CDN da fonte (residencial vs. datacenter):
- **Branch `Server`** (Proxmox, IP residencial de casa) → `proxyable: true`.
  O nosso servidor tem o IP bom; faz sentido ele buscar a CDN e servir o
  cliente via `/hls`/`/seg` (o cliente pode estar nalgum lado pior — datacenter,
  VPN/Tailscale, hotel).
- **Branch `main`** (Vercel, IP de datacenter) → `proxyable: false` seria a
  escolha certa — o inverso: o cliente busca directo com o seu IP residencial.
`datacenter_scraper.js` (VixSrc/Vidlink) tem comentários a explicar isto junto
de cada `return`. Ao mudar de branch/deploy, confirmar que o valor corresponde
à arquitectura desse deploy.

### Reescrita do manifesto — tem de ser sensível ao contexto, não à extensão
`rewriteManifest` (em `server.js`) decide se um URI é uma sub-playlist (→ `/hls`)
ou um segmento/recurso binário (→ `/seg`) **olhando para a tag anterior**
(`#EXT-X-STREAM-INF`, `#EXT-X-I-FRAME`, `#EXT-X-MEDIA`, `#EXT-X-MAP`, `#EXT-X-KEY`/
`#EXT-X-SESSION-KEY`), nunca pela extensão do URL. **Bug histórico**: a versão
antiga decidia por `.includes('.m3u8')`, mas a CDN da VixSrc usa URLs por
query-string sem extensão (`?type=video&rendition=480p&token=...`) — as
variantes de vídeo eram encaminhadas (erradamente) para `/seg` como binário,
e o vídeo nunca arrancava.

### Streams encriptados (AES-128) — proxiar a chave `#EXT-X-KEY`
**Causa raiz do "vídeo preso a carregar" (resolvida, commit `1a3cdb9`)**: alguns
streams (VixSrc) vêm com segmentos cifrados:
```
#EXT-X-KEY:METHOD=AES-128,URI="/storage/enc.key",IV=0x43A6...
```
Sem tratar esta tag, o URI relativo (`/storage/enc.key`) era resolvido contra o
**nosso** domínio → 404 → o player nunca conseguia decifrar nada → ecrã
"a carregar" infinito, **sem nunca pedir segmentos** (zero entradas `[proxy/seg]`
nos logs, apesar do master/variantes via `/hls` responderem 200 OK — confirmado
com `diag_proxy.js`, que prova a cadeia master→variante→segmento OK até à CDN).

Fix (dois passos, têm de andar juntos):
1. `rewriteManifest` trata `#EXT-X-KEY`/`#EXT-X-SESSION-KEY` como qualquer outro
   `URI="..."` e encaminha-o por `/seg` (bytes crus da chave).
2. URIs relativos têm de ser resolvidos contra o **URL final pós-redirect**
   (a CDN real, ex. `sc-u3-01.vix-content.net`), não contra o URL original da
   API (`vixsrc.to`):
   ```js
   const effectiveUrl = upstream.request?.res?.responseUrl || upstream.request?.responseURL || manifestUrl;
   const base = effectiveUrl.substring(0, effectiveUrl.lastIndexOf('/') + 1);
   ```
   Sem isto, mesmo com a tag tratada, `/storage/enc.key` resolvia contra o host
   errado.

Diagnóstico útil: `node diag_proxy.js [stremio-path]` segue a cadeia completa
(master → variante → 1º segmento) através do domínio público e reporta o status
de cada passo — isola se o problema está no proxy/CDN ou no player/cliente.

### Faixa de áudio por defeito — forçar inglês (Stremio Android)
A VixSrc é uma fonte **italiana**: marca o áudio italiano como `DEFAULT=YES`,
`AUTOSELECT=YES` e o inglês como `DEFAULT=NO`. No PC e no Nuvio dava para trocar,
mas o **Stremio Android (ExoPlayer)** arrancava em italiano e a troca manual para
inglês "não fazia nada".

`rewriteManifest` corrige isto em dois passos (ambos necessários — o `DEFAULT`
sozinho não chegou para o Stremio Android):
1. **Marca o inglês como `DEFAULT=YES`/`AUTOSELECT=YES`** e as outras faixas do
   mesmo `GROUP-ID` como `DEFAULT=NO` (`audioIsEnglish` + `setFlag`). Só toca em
   grupos que **têm** faixa inglesa (pré-passagem `groupsWithEn`) — grupos sem
   inglês mantêm o default original (não ficam sem default nenhum).
2. **Reordena as `#EXT-X-MEDIA:TYPE=AUDIO` para o inglês ficar listado em 1º.**
   O Stremio Android ignora o `DEFAULT` e escolhe a **primeira** faixa listada —
   foi este passo que resolveu. Sort estável (V8) mantém a ordem relativa das
   restantes faixas.

Diagnóstico: `node diag_subs.js [tmdbId] [s] [e]` despeja as faixas `TYPE=AUDIO`/
`TYPE=SUBTITLES` e o `#EXT-X-STREAM-INF` do master; comparar com o que o nosso
proxy serve (curl ao `/hls/...`) confirma se a reescrita aplicou bem.

## Legendas (subtitles)
- Manifesto declara `resources: ['stream', 'subtitles']`; `addon.js` define
  `defineSubtitlesHandler` que chama `fetchSubtitles` (em `scraper.js`, reaproveita
  a cache de `fetchVideoSource` — a resolução do stream é que popula `subtitles`).
- **Captura na fonte**:
  - `datacenter_scraper.js` (VixSrc) — extrai legendas do HTML do embed
    (`extractSubsFromHtml`, vários formatos JSON) e, em fallback, do master m3u8.
    **Cuidado**: o player guarda também `thumbnailsUrl` (storyboard de preview)
    como ficheiro `.vtt` — filtrado por `NOT_A_SUB_RE` (thumbnail/storyboard/
    sprite/preview/seek/chapters) para não aparecer como legenda.
- **Normalização de idioma**: `normalizeLang` mapeia nomes/códigos (3 letras
  ISO 639-2 `ISO3`, nomes completos `LANG_MAP`, ou tenta adivinhar do URL via
  `guessLangFromUrl`) para códigos ISO 639-1 que o Stremio entende.
- **Proxy `/sub/:encoded.vtt`** (`server.js`): algumas fontes (VixSrc) devolvem
  o URI da legenda como **playlist m3u8** (`?type=subtitle&rendition=3-eng&token=...`),
  não um `.vtt` directo — o proxy detecta `#EXTM3U` na resposta e resolve para o
  segmento real; também converte SRT→VTT (`srtToVtt`, ajusta vírgulas de
  timestamp para pontos e adiciona o cabeçalho `WEBVTT`).
- Diagnóstico: `node diag_subs.js` despeja as faixas `#EXT-X-MEDIA:TYPE=SUBTITLES`
  do master m3u8 da fonte, útil para ver o formato real dos URIs de legendas.

## Env Vars
| Variável | Default |
|---|---|
| `TMDB_API_KEY` | — (obrigatório para movie-web providers) |
| `PROXY_SECRET` | aleatório por processo (definir em .env p/ persistir tokens) |
| `VAPLAYER_API_URL` | `https://streamdata.vaplayer.ru/api.php` |
| `CACHE_TTL_MS` | `300000` (5min) |
| `MAX_QUEUE` | `8` |
| `MAX_SEG_RETRIES` | `1` (retries on 502/403) |
| `HEALTH_CHECK_INTERVAL_MS` | `300000` (5min) |
| `ALERT_WEBHOOK` | — (Slack/Discord) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — (alertas Telegram) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `ALERT_EMAIL` | — (alertas email) |
| `SERVER_URL` | base pública (Cloudflare Tunnel) p/ os URLs do proxy |

## Padrões
- CommonJS (`require`). `try/catch` em todos os handlers. Séries: `tt1234567:1:2` → split.

## Branches
- **`Server`** — produção do servidor caseiro (Proxmox, IP residencial; é a
  que o Proxmox faz pull). `proxyable: true`.
- **`main`** — produção do Vercel (deploy serverless, só axios).
  `proxyable: false` seria o correcto aqui (ver secção "Proxy HLS").
- `Experimental` — histórico anterior (Render)
- `backup/working-v1` — backup estável com Puppeteer (versão antiga, anterior à remoção)

## Notas
- bingeGroup activo — ecrã "próximo episódio" requer clique.
