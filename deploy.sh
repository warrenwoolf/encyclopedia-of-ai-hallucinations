#!/bin/bash
set -euo pipefail

# Target host: an SSH alias (see ~/.ssh/config). Defaults to the old Pi `randy`;
# point at the Oracle box with e.g.  DEPLOY_HOST=enaih ./deploy.sh
# That alias can route over a cloudflared tunnel (ProxyCommand cloudflared
# access ssh), so no public IP / open SSH port is required on the host.
DEPLOY_HOST="${DEPLOY_HOST:-randy}"

# Public origin, used to build the static-asset URLs we purge from Cloudflare
# and to derive the Cloudflare zone (last two labels of the host).
SITE_URL="${SITE_URL:-https://enaih.org}"

# Cloudflare cache-purge creds (local laptop files, NOT shipped to the host).
# The token needs Zone → Cache Purge (+ Zone Read, to resolve the zone id).
CF_ACCOUNT_ID_FILE="${CF_ACCOUNT_ID_FILE:-$HOME/Credentials/cloudflare-account-id.txt}"
CF_TOKEN_FILE="${CF_TOKEN_FILE:-$HOME/Credentials/cloudflare-ww-purge-token.txt}"

# NOTE: Cloudflare caches /static/* aggressively (see the cache note in CLAUDE.md).
# After deploying a static-asset change, purge these URLs at the edge (dashboard
# → Caching → Purge, or the API). Keep this list in sync with STATIC_FILES in
# src/server.ts:
#   /static/style.css  /static/theme.js  /static/browse.js  /static/turns.js
#   /static/google.js  /static/robots.txt  /static/logo.svg

echo "deploying to ${DEPLOY_HOST}..."
rsync -avz --delete \
  --exclude .git --exclude node_modules --exclude .env \
  --exclude backups --exclude .backup-par --exclude .spaces --exclude .backup-age-pub \
  ./ "${DEPLOY_HOST}:~/eah/"

ssh "${DEPLOY_HOST}" '
    set -euo pipefail
    cd ~/eah
    docker compose up -d --build
    docker compose exec eah bun scripts/migrate.ts
'

# --- Cloudflare edge-cache purge (runs locally; creds live on this machine) ---
# Cloudflare caches /static/* for ~4h (zone rule), so a changed CSS/JS file is
# live in the container immediately but stale at the edge until purged.
if [[ -r "$CF_ACCOUNT_ID_FILE" && -r "$CF_TOKEN_FILE" ]]; then
  cf_account="$(tr -d '[:space:]' < "$CF_ACCOUNT_ID_FILE")"
  cf_token="$(tr -d '[:space:]' < "$CF_TOKEN_FILE")"
  cf_host="${SITE_URL#*://}"; cf_host="${cf_host%%/*}"
  # registrable domain = last two dot-labels (eah.warrenwoolf.com -> warrenwoolf.com)
  cf_domain="$(echo "$cf_host" | rev | cut -d. -f1-2 | rev)"

  echo "resolving Cloudflare zone id for ${cf_domain}..."
  cf_zone="$(curl -sS --fail-with-body \
    "https://api.cloudflare.com/client/v4/zones?account.id=${cf_account}&name=${cf_domain}" \
    -H "Authorization: Bearer ${cf_token}" \
    | python3 -c 'import sys,json; r=json.load(sys.stdin).get("result") or []; print(r[0]["id"] if r else "")')"

  if [[ -n "$cf_zone" ]]; then
    echo "purging Cloudflare cache for static assets (zone ${cf_zone})..."
    curl -sS --fail-with-body -X POST \
      "https://api.cloudflare.com/client/v4/zones/${cf_zone}/purge_cache" \
      -H "Authorization: Bearer ${cf_token}" \
      -H 'Content-Type: application/json' \
      --data "{\"files\":[
        \"${SITE_URL}/static/style.css\",
        \"${SITE_URL}/static/theme.js\",
        \"${SITE_URL}/static/browse.js\",
        \"${SITE_URL}/static/turns.js\",
        \"${SITE_URL}/static/google.js\",
        \"${SITE_URL}/static/logo.svg\",
        \"${SITE_URL}/static/robots.txt\"
      ]}"
    echo
    echo "cache purged."
  else
    echo "WARNING: could not resolve a zone id for ${cf_domain} — skipping cache purge." >&2
  fi
else
  echo "WARNING: Cloudflare cred files not found — skipping cache purge." >&2
  echo "  expected: $CF_ACCOUNT_ID_FILE and $CF_TOKEN_FILE" >&2
fi
