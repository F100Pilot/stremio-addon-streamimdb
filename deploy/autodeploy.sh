#!/usr/bin/env bash
# Auto-deploy do StreamIMDb: vê se há commits novos na branch, actualiza,
# reinicia o PM2, confirma que arrancou bem e, se não arrancou, volta atrás.
#
# Corre de 5 em 5 minutos (systemd timer ou cron — ver install-autodeploy.sh).
# É o SERVIDOR que vai buscar as alterações: não há porta aberta nem endpoint
# de deploy exposto à internet.
#
# Pausar:   touch /var/lib/stremio-autodeploy/PAUSE    (ou .no-autodeploy no repo)
# Retomar:  rm /var/lib/stremio-autodeploy/PAUSE
#
# Tudo configurável por variáveis de ambiente (os testes usam-nas):
#   REPO_DIR  DEPLOY_BRANCH  PM2_NAME  HEALTH_URL  HEALTH_WAIT_S  STATE_DIR
#   LOCK_FILE  NOTIFY_BIN

# Tudo dentro de main() e a chamada na última linha: o bash lê o script aos
# bocados, e o `git merge` actualiza ESTE ficheiro a meio da execução.
#
# Na prática o `git` não escreve por cima: apaga e cria outro ficheiro, e o
# bash em execução continua a ler o antigo (verificado com um descritor aberto
# durante o merge). Por isso isto é defesa em profundidade: se algum dia algo
# escrever por cima do ficheiro (um `cp`, um editor), com a função inteira já em
# memória a execução também não é afectada. Não custa nada e evita um bug
# horrível de diagnosticar.
main() {
  set -uo pipefail

  local REPO="${REPO_DIR:-/root/stremio-addon-streamimdb}"
  local BRANCH="${DEPLOY_BRANCH:-Server}"
  local APP="${PM2_NAME:-stremio-addon}"
  local HEALTH_URL="${HEALTH_URL:-http://localhost:7000/health}"
  local HEALTH_WAIT="${HEALTH_WAIT_S:-45}"
  local STATE="${STATE_DIR:-/var/lib/stremio-autodeploy}"
  local LOCK="${LOCK_FILE:-/var/lock/stremio-autodeploy.lock}"

  log() { echo "[$(date '+%F %T')] $*"; }

  notify() {
    # Os avisos são um extra: nunca podem fazer o deploy falhar.
    if [ -n "${NOTIFY_BIN:-}" ]; then
      "$NOTIFY_BIN" "$1" "${2:-}" || true
    elif [ -f "$REPO/deploy/notify.js" ]; then
      timeout 30 node "$REPO/deploy/notify.js" "$1" "${2:-}" >/dev/null 2>&1 || true
    fi
  }

  mkdir -p "$STATE" || { log "não consegui criar $STATE"; return 1; }

  # Uma execução de cada vez (o timer pode disparar enquanto uma ainda corre).
  exec 9>"$LOCK"
  flock -n 9 || return 0

  if [ -e "$STATE/PAUSE" ] || [ -e "$REPO/.no-autodeploy" ]; then return 0; fi

  cd "$REPO" 2>/dev/null || { log "repositório não encontrado: $REPO"; return 1; }

  # Sem rede? Tenta no próximo ciclo, em silêncio (a ligação de casa cai e
  # isto correria de 5 em 5 minutos a encher o log).
  timeout 90 git fetch --quiet origin "$BRANCH" 2>/dev/null || return 0

  local LOCAL REMOTE
  LOCAL=$(git rev-parse HEAD) || return 1
  REMOTE=$(git rev-parse "origin/$BRANCH") || return 1
  [ "$LOCAL" = "$REMOTE" ] && return 0

  # Já tentámos este commit e falhou: não repetir até chegar outro.
  if [ "$(cat "$STATE/failed" 2>/dev/null)" = "$REMOTE" ]; then return 0; fi

  # `recusa` avisa UMA vez por commit remoto (não de 5 em 5 minutos).
  recusa() {
    if [ "$(cat "$STATE/refused" 2>/dev/null)" != "$REMOTE" ]; then
      echo "$REMOTE" > "$STATE/refused"
      log "RECUSADO: $1"
      notify "⚠️ <b>StreamIMDb — deploy automático recusado</b>" "$1"
    fi
    return 1
  }

  local CURRENT
  CURRENT=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")
  if [ "$CURRENT" != "$BRANCH" ]; then
    recusa "o servidor está na branch '${CURRENT:-desligada}', não em '$BRANCH'"; return 1
  fi

  # Só avança em linha recta. Se o servidor tem commits que o remoto não tem,
  # um merge automático decidia por ti — melhor parar e avisar.
  if ! git merge-base --is-ancestor "$LOCAL" "$REMOTE"; then
    recusa "o servidor divergiu de origin/$BRANCH (tem commits locais que não estão no remoto)"; return 1
  fi

  # Alterações tuas no servidor (um hotfix à mão, por exemplo): não as atropelar.
  # O node_modules fica de fora — está versionado no git e o `npm install` mexe-lhe.
  local SUJO
  SUJO=$(git status --porcelain --untracked-files=no -- . ':(exclude)node_modules' | head -5)
  if [ -n "$SUJO" ]; then
    recusa "há alterações locais não commitadas no servidor: $(echo "$SUJO" | tr '\n' ' ')"; return 1
  fi

  local PREV="$LOCAL" ASSUNTO
  ASSUNTO=$(git log -1 --format=%s "origin/$BRANCH")
  log "novo commit: ${PREV:0:7} → ${REMOTE:0:7} — $ASSUNTO"

  local NEED_NPM=0

  if ! git merge --ff-only --quiet "origin/$BRANCH" 2>"$STATE/merge.err"; then
    # O node_modules versionado e alterado pelo npm pode impedir o merge. É
    # dado derivado: restaura-se e reinstala-se depois.
    if git diff --quiet -- node_modules; then
      log "merge falhou: $(tr '\n' ' ' < "$STATE/merge.err")"
      echo "$REMOTE" > "$STATE/failed"
      notify "❌ <b>StreamIMDb — deploy falhou</b>" "O merge de ${REMOTE:0:7} falhou. Nada foi alterado."
      return 1
    fi
    log "node_modules versionado e modificado — a restaurar e a repetir o merge"
    git checkout -- node_modules && git merge --ff-only --quiet "origin/$BRANCH" 2>"$STATE/merge.err" || {
      log "merge falhou mesmo depois de restaurar o node_modules"
      echo "$REMOTE" > "$STATE/failed"
      notify "❌ <b>StreamIMDb — deploy falhou</b>" "O merge de ${REMOTE:0:7} falhou. Nada foi alterado."
      return 1
    }
    NEED_NPM=1
  fi

  if git diff --name-only "$PREV" HEAD | grep -qE '^(package\.json|package-lock\.json)$'; then
    NEED_NPM=1
  fi

  # Volta ao commit anterior e põe tudo como estava. $1 = motivo,
  # $2 = 1 se já reiniciámos a app (então é preciso reiniciar de novo).
  voltar_atras() {
    local motivo="$1" reiniciou="${2:-0}"
    log "ROLLBACK: $motivo"
    echo "$REMOTE" > "$STATE/failed"
    git reset --hard --quiet "$PREV"
    if [ "$NEED_NPM" = 1 ]; then npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || true; fi
    if [ "$reiniciou" = 1 ]; then
      pm2 restart "$APP" --update-env >/dev/null 2>&1 || true
      if esperar_saude; then log "rollback concluído: a voltar a ${PREV:0:7}, serviço saudável"
      else log "ATENÇÃO: rollback feito mas o serviço continua sem responder"; fi
    fi
    notify "❌ <b>StreamIMDb — deploy revertido</b>" \
      "${REMOTE:0:7} ($ASSUNTO) não passou: $motivo. Voltei a ${PREV:0:7}. Este commit não será tentado outra vez."
    return 1
  }

  esperar_saude() {
    local t=0
    while [ "$t" -lt "$HEALTH_WAIT" ]; do
      curl -fsS -m 3 -o /dev/null "$HEALTH_URL" 2>/dev/null && return 0
      sleep 2; t=$((t + 2))
    done
    return 1
  }

  # 1) Sintaxe de todos os .js (excepto node_modules). Apanha um commit
  #    partido ANTES de reiniciar — assim o serviço nem chega a cair.
  local f erro=""
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    node --check "$f" 2>/dev/null || { erro="erro de sintaxe em $f"; break; }
  done < <(git ls-files -- '*.js' ':(exclude)node_modules' ':(exclude)node_modules/**')
  [ -n "$erro" ] && { voltar_atras "$erro" 0; return 1; }

  # 2) Dependências, só se o package.json mudou
  if [ "$NEED_NPM" = 1 ]; then
    log "package.json mudou — npm install"
    npm install --omit=dev --no-audit --no-fund >"$STATE/npm.log" 2>&1 \
      || { voltar_atras "npm install falhou (ver $STATE/npm.log)" 0; return 1; }
  fi

  # 3) Reiniciar e esperar que responda
  pm2 restart "$APP" --update-env >/dev/null 2>&1 \
    || { voltar_atras "pm2 restart falhou" 1; return 1; }

  if ! esperar_saude; then
    voltar_atras "o serviço não respondeu em ${HEALTH_WAIT}s depois de reiniciar" 1
    return 1
  fi

  rm -f "$STATE/failed" "$STATE/refused"
  log "deploy concluído: ${REMOTE:0:7} — $ASSUNTO"
  notify "✅ <b>StreamIMDb — actualizado</b>" "${PREV:0:7} → ${REMOTE:0:7}: $ASSUNTO"
  return 0
}

main "$@"; exit $?
