#!/usr/bin/env bash
# Instala (ou remove) o auto-deploy no servidor. Corre UMA vez, como root:
#
#   cd /root/stremio-addon-streamimdb
#   git pull
#   sudo bash deploy/install-autodeploy.sh            # instalar
#   sudo bash deploy/install-autodeploy.sh --uninstall
#   sudo bash deploy/install-autodeploy.sh --status
#
# Usa um timer do systemd; se o systemd não existir (alguns contentores),
# cai para o cron.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO/deploy/autodeploy.sh"
INTERVALO="${AUTODEPLOY_INTERVAL_MIN:-5}"
UNIT_DIR=/etc/systemd/system
CRON=/etc/cron.d/stremio-autodeploy

[ "$(id -u)" = 0 ] || { echo "Corre como root (o PM2 está no utilizador root)."; exit 1; }

tem_systemd() { [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; }

if [ "${1:-}" = "--status" ]; then
  if tem_systemd && [ -f "$UNIT_DIR/stremio-autodeploy.timer" ]; then
    systemctl list-timers stremio-autodeploy.timer --no-pager || true
    echo; journalctl -u stremio-autodeploy.service -n 15 --no-pager 2>/dev/null || true
  elif [ -f "$CRON" ]; then
    echo "cron: $CRON"; tail -n 15 /var/log/stremio-autodeploy.log 2>/dev/null || true
  else
    echo "auto-deploy não está instalado."
  fi
  [ -e /var/lib/stremio-autodeploy/PAUSE ] && echo "⏸  PAUSADO (rm /var/lib/stremio-autodeploy/PAUSE para retomar)"
  exit 0
fi

if [ "${1:-}" = "--uninstall" ]; then
  if tem_systemd; then
    systemctl disable --now stremio-autodeploy.timer 2>/dev/null || true
    rm -f "$UNIT_DIR/stremio-autodeploy.timer" "$UNIT_DIR/stremio-autodeploy.service"
    systemctl daemon-reload
  fi
  rm -f "$CRON"
  echo "auto-deploy removido."
  exit 0
fi

# Pré-requisitos: falhar aqui, de forma clara, é melhor que falhar às 4 da manhã.
for c in git node npm pm2 curl flock; do
  command -v "$c" >/dev/null 2>&1 || { echo "falta o comando '$c' no PATH"; exit 1; }
done
[ -d "$REPO/.git" ] || { echo "$REPO não é um repositório git"; exit 1; }
[ -x "$SCRIPT" ] || chmod +x "$SCRIPT"

BRANCH="$(git -C "$REPO" symbolic-ref --short HEAD 2>/dev/null || true)"
echo "Repositório : $REPO"
echo "Branch      : ${BRANCH:-?}   (o auto-deploy só segue a branch em que o servidor está)"
echo "Intervalo   : ${INTERVALO} min"
[ "$BRANCH" = "Server" ] || echo "⚠️  O servidor não está na branch 'Server'. Define DEPLOY_BRANCH se for de propósito."

# O PATH do teu shell tem o pm2/node (pode ser nvm); o systemd/cron não o herdam.
ENVPATH="$PATH"

# Um teste a seco antes de agendar: o script tem de correr limpo aqui e agora.
mkdir -p /var/lib/stremio-autodeploy
echo; echo "Teste a seco..."
DEPLOY_BRANCH="${DEPLOY_BRANCH:-$BRANCH}" "$SCRIPT" && echo "ok (sem commits novos, ou deploy feito)"

if tem_systemd; then
  cat > "$UNIT_DIR/stremio-autodeploy.service" <<EOF
[Unit]
Description=Auto-deploy do StreamIMDb (git pull + pm2 restart + rollback)
After=network-online.target

[Service]
Type=oneshot
Environment=HOME=$HOME
Environment=PATH=$ENVPATH
Environment=REPO_DIR=$REPO
Environment=DEPLOY_BRANCH=${DEPLOY_BRANCH:-$BRANCH}
ExecStart=$SCRIPT
# Um deploy que encrave não pode bloquear os seguintes para sempre.
TimeoutStartSec=15min
EOF
  cat > "$UNIT_DIR/stremio-autodeploy.timer" <<EOF
[Unit]
Description=Verifica commits novos do StreamIMDb de ${INTERVALO} em ${INTERVALO} minutos

[Timer]
OnBootSec=2min
OnUnitActiveSec=${INTERVALO}min
RandomizedDelaySec=20

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now stremio-autodeploy.timer
  echo; echo "✓ instalado (systemd). Próxima execução:"
  systemctl list-timers stremio-autodeploy.timer --no-pager | head -3
else
  cat > "$CRON" <<EOF
# Auto-deploy do StreamIMDb
PATH=$ENVPATH
HOME=$HOME
REPO_DIR=$REPO
DEPLOY_BRANCH=${DEPLOY_BRANCH:-$BRANCH}
*/${INTERVALO} * * * * root $SCRIPT >> /var/log/stremio-autodeploy.log 2>&1
EOF
  chmod 644 "$CRON"
  echo; echo "✓ instalado (cron, sem systemd). Log: /var/log/stremio-autodeploy.log"
fi

cat <<EOF

Ver o que se passou:   sudo bash deploy/install-autodeploy.sh --status
Pausar (p.ex. a mexer): touch /var/lib/stremio-autodeploy/PAUSE
Retomar:                rm /var/lib/stremio-autodeploy/PAUSE
Remover:                sudo bash deploy/install-autodeploy.sh --uninstall
EOF
