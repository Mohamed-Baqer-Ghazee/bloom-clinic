#!/usr/bin/env sh
# Run on the server, inside this folder:   sh deploy.sh
set -e

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker…"
  curl -fsSL https://get.docker.com | sh
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env, edit DOMAIN and BLOOM_ADMIN_PIN, then run this again."
  exit 1
fi

docker compose up -d --build
docker compose ps
echo
echo "Done. Open https://$(grep '^DOMAIN=' .env | cut -d= -f2)  (first HTTPS request may take ~30s while the certificate is issued)"
