#!/usr/bin/env bash
# One-command install / update of easySales on a fresh EC2 instance (Amazon Linux 2023 or Ubuntu).
# Run on the instance:   bash deploy/ec2/setup.sh        (or automatically from user-data.sh at launch)
# Safe to run again: it never overwrites server/.env and only rebuilds and restarts the stack.
# NONINTERACTIVE=1 starts right away with generated secrets; add your API keys to server/.env later.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(pwd)

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

# ---------- Docker, Compose and swap ----------
if ! command -v docker >/dev/null; then
    say "Installing Docker"
    if command -v dnf >/dev/null; then
        sudo dnf install -y docker git
    else
        sudo apt-get update -y && sudo apt-get install -y docker.io git
    fi
    sudo systemctl enable --now docker
    sudo usermod -aG docker "$(id -un)"
fi
if ! sudo docker compose version >/dev/null 2>&1; then
    say "Installing the Docker Compose plugin"
    sudo mkdir -p /usr/local/lib/docker/cli-plugins
    sudo curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" -o /usr/local/lib/docker/cli-plugins/docker-compose
    sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
fi
if ! swapon --show | grep -q .; then
    say "Adding 2 GB swap (the build needs it on a small instance)"
    sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# ---------- domain: <ip>.sslip.io unless you bring your own ----------
DEPLOY_ENV="$ROOT/deploy/ec2/.env"
if [ ! -f "$DEPLOY_ENV" ]; then
    TOKEN=$(curl -fsS -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
    IP=$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)
    DOMAIN="${DOMAIN:-${IP//./-}.sslip.io}"
    printf 'DOMAIN=%s\nPREVIEW_DOMAIN=preview.%s\n' "$DOMAIN" "$DOMAIN" > "$DEPLOY_ENV"
    say "Domain: https://$DOMAIN (edit deploy/ec2/.env to use your own)"
fi
# shellcheck disable=SC1090
. "$DEPLOY_ENV"

# ---------- server/.env with fresh secrets (created once, never overwritten) ----------
APP_ENV="$ROOT/server/.env"
setkv() { # replace KEY=... in place, or append it
    if grep -q "^$1=" "$APP_ENV"; then sed -i "s|^$1=.*|$1=$2|" "$APP_ENV"; else echo "$1=$2" >> "$APP_ENV"; fi
}
if [ ! -f "$APP_ENV" ]; then
    say "Creating server/.env with new secrets"
    cp "$ROOT/server/.env.example" "$APP_ENV"
    chmod 600 "$APP_ENV"
    setkv NODE_ENV production
    setkv FRONTEND_URL "https://$DOMAIN"
    setkv CORS_ORIGIN "https://$DOMAIN"
    setkv PUBLIC_API_URL "https://$DOMAIN"
    setkv PREVIEW_BASE_URL "https://$PREVIEW_DOMAIN"
    setkv ACCESS_TOKEN_SECRET "$(openssl rand -hex 32)"
    setkv REFRESH_TOKEN_SECRET "$(openssl rand -hex 32)"
    setkv ENCRYPTION_KEY "$(openssl rand -hex 32)"
    setkv BILLING_WEBHOOK_SECRET "$(openssl rand -hex 24)"
    setkv RUN_WORKER false
    [ -n "${ADMIN_EMAIL:-}" ] && setkv ADMIN_EMAILS "$ADMIN_EMAIL"
    NEEDS_EDIT=1
fi

if [ "${NEEDS_EDIT:-0}" = 1 ] && [ "${NONINTERACTIVE:-0}" != 1 ]; then
    cat <<EOF

server/.env is ready with fresh secrets. Before starting, fill in (nano server/.env):
  LLM_API_KEY, LLM_BASE_URL, LLM_MODEL_SMART, LLM_MODEL_FAST   (the AI agents)
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SENDING_USER, SEND_MAIL=true   (sign-up and password emails)
  ADMIN_EMAILS   (your email, for the Operations page)
  TAVILY_API_KEY   (optional web search)
Then run this script again.
EOF
    exit 0
fi

# certificate contact (and ZeroSSL fallback): the first operator email
ACME_EMAIL=$(grep -E '^ADMIN_EMAILS=' "$APP_ENV" | cut -d= -f2- | cut -d, -f1 | tr -d ' "')
if [ -z "$ACME_EMAIL" ]; then echo "Set ADMIN_EMAILS (your email) in server/.env, then run this script again."; exit 1; fi
# kept in the compose env file: sudo does not pass exported variables through
sed -i '/^ACME_EMAIL=/d' "$DEPLOY_ENV" && echo "ACME_EMAIL=$ACME_EMAIL" >> "$DEPLOY_ENV"

# ---------- build and start ----------
say "Building and starting (first build takes a few minutes)"
sudo docker compose -f deploy/ec2/docker-compose.yml --env-file "$DEPLOY_ENV" up -d --build
sudo docker image prune -f >/dev/null

say "Waiting for HTTPS"
for _ in $(seq 1 60); do
    if curl -fsS "https://$DOMAIN/api/health" >/dev/null 2>&1; then
        say "Live at https://$DOMAIN"
        if ! grep -qE '^LLM_API_KEY=.+' "$APP_ENV" || ! grep -qE '^SMTP_PASS=.+' "$APP_ENV"; then
            echo "Next: add LLM_API_KEY and the SMTP_* settings to $APP_ENV, then run: sudo bash $ROOT/deploy/ec2/setup.sh"
        fi
        exit 0
    fi
    sleep 5
done
echo "Not answering on https://$DOMAIN yet. Check: sudo docker compose -f deploy/ec2/docker-compose.yml logs caddy api"
exit 1
