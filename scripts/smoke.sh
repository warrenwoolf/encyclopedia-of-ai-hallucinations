#!/usr/bin/env bash
#
# Local smoke-test harness for ENAIH.
#
# Spins up a *throwaway* MariaDB in Docker, runs the real migrations, seeds a
# handful of users + submissions, and boots the actual server — so you can poke
# the live site (browse filters, dashboards, admin) on this machine without a
# real database or any production creds. Everything lives in a disposable
# container + a gitignored .env.smoke; `down` removes all of it.
#
# Usage:
#   scripts/smoke.sh up        # start DB, migrate, seed, boot server; print URLs + cookies
#   scripts/smoke.sh down      # stop server, remove container + .env.smoke
#   scripts/smoke.sh reset     # down, then up (fresh DB)
#   scripts/smoke.sh cookies   # re-mint + print session cookies for the seed users
#   scripts/smoke.sh sql '...' # run SQL against the smoke DB
#   scripts/smoke.sh logs      # tail the server log
#   scripts/smoke.sh status    # show what's running
#
# Knobs (env): EAH_SMOKE_DB_PORT (3307), EAH_SMOKE_APP_PORT (8099),
#              EAH_SMOKE_CONTAINER (eah-smoke), EAH_SMOKE_DB_IMAGE (mariadb:11).
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="${EAH_SMOKE_CONTAINER:-eah-smoke}"
DB_IMAGE="${EAH_SMOKE_DB_IMAGE:-mariadb:11}"
DB_PORT="${EAH_SMOKE_DB_PORT:-3307}"
APP_PORT="${EAH_SMOKE_APP_PORT:-8099}"
DB_PASS="changeme"
ENV_FILE="$ROOT/.env.smoke"
PIDFILE="/tmp/eah-smoke-server.pid"
LOGFILE="/tmp/eah-smoke-server.log"
SEED_PASSWORD="smoke-pass-1234"

say()  { printf '\033[36m[smoke]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[smoke] %s\033[0m\n' "$*" >&2; exit 1; }

dbq() { docker exec -i "$CONTAINER" mariadb -ueah -p"$DB_PASS" eah "$@"; }

require_tools() {
  for t in docker bun openssl xxd; do
    command -v "$t" >/dev/null 2>&1 || die "missing required tool: $t"
  done
}

write_env() {
  cat > "$ENV_FILE" <<EOF
PORT=$APP_PORT
DB_HOST=127.0.0.1
DB_PORT=$DB_PORT
DB_USER=eah
DB_PASSWORD=$DB_PASS
DB_NAME=eah
SESSION_SECRET=smoke0000000000000000000000000000000000000000000000000000000000
IN_DEVELOPMENT=true
PUBLIC_BASE_URL=http://localhost:$APP_PORT
# Leave Discord/Resend unset — those modules no-op without creds.
EOF
}

start_db() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    docker start "$CONTAINER" >/dev/null
  else
    say "starting MariaDB container ($DB_IMAGE) on :$DB_PORT"
    docker run -d --name "$CONTAINER" \
      -e MARIADB_ROOT_PASSWORD=root \
      -e MARIADB_DATABASE=eah \
      -e MARIADB_USER=eah \
      -e MARIADB_PASSWORD="$DB_PASS" \
      -p "$DB_PORT:3306" "$DB_IMAGE" >/dev/null
  fi
  say "waiting for MariaDB…"
  for _ in $(seq 1 60); do
    if dbq -e "SELECT 1" >/dev/null 2>&1; then say "MariaDB ready"; return 0; fi
    sleep 1
  done
  die "MariaDB did not become ready in time"
}

# Insert a session for a username and echo "username  eah_session=<token>".
mint_cookie() {
  local username="$1"
  local token hash
  token="$(openssl rand -hex 32)"
  hash="$(printf '%s' "$token" | openssl dgst -sha256 -binary | xxd -p -c 256)"
  dbq -e "INSERT INTO user_sessions (token_hash, user_id, expires_at)
          SELECT UNHEX('$hash'), id, DATE_ADD(NOW(), INTERVAL 7 DAY)
          FROM users WHERE username='$username';"
  printf '  %-7s eah_session=%s\n' "$username" "$token"
}

seed() {
  say "seeding users + submissions"
  local phash
  phash="$(bun -e "console.log(await Bun.password.hash(process.argv[1]))" "$SEED_PASSWORD")"
  # Build the seed SQL in a tmp file so the argon2 hash's $ chars pass through
  # untouched (the heredoc expands $phash once; its contents aren't re-expanded).
  local sqlfile
  sqlfile="$(mktemp)"
  cat > "$sqlfile" <<SQL
INSERT INTO users (username,email,email_verified,password_hash,is_admin,is_owner,created_at)
VALUES
 ('owner','owner@smoke.test',1,'$phash',1,1,NOW()),
 ('staff','staff@smoke.test',1,'$phash',1,0,NOW()),
 ('user','user@smoke.test',1,'$phash',0,0,NOW())
ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash), is_admin=VALUES(is_admin), is_owner=VALUES(is_owner);

# Tiered sample data (public_id is CHAR(10), so keep slugs ≤10 chars and unique).
# Canonical (reviewed+reproduced, carry A-numbers) plus one of each lower tier.
INSERT IGNORE INTO submissions
 (public_id,eah_number,title,prompt,output,ai_model,category,status,repro_status,entry_status,transcript_mode,source_url,summary,tracking_hash,submitted_at,owner_user_id)
VALUES
 ('smokepub01',900001,'Strawberry R-count','how many r in strawberry','two','GPT-5','tokenization','reviewed','reproduced','active','single',NULL,NULL,UNHEX(SHA2('s1',256)),NOW(),NULL),
 ('smokepub02',900002,'Invented citation','cite a paper on X','Smith et al. 2019 (does not exist)','Claude','fabricated-citation','reviewed','reproduced','active','single',NULL,NULL,UNHEX(SHA2('s2',256)),NOW(),NULL),
 ('smokepub03',900003,'Seahorse loop','is there a seahorse emoji','spirals forever','GPT-5','spiraling','reviewed','reproduced','patched','single',NULL,NULL,UNHEX(SHA2('s3',256)),NOW(),NULL),
 ('smokerev01',NULL,'Reviewed not reproduced','p','o','GPT-5','tokenization','reviewed','pending','active','single',NULL,NULL,UNHEX(SHA2('s6',256)),NOW(),NULL),
 ('smokefail1',NULL,'Failed to reproduce','p','o','Claude','spiraling','reviewed','failed','active','single',NULL,NULL,UNHEX(SHA2('s7',256)),NOW(),NULL),
 ('smokeunrv1',NULL,'Unreviewed public sighting','p','o','GPT-5','other','unreviewed','pending','active','single',NULL,NULL,UNHEX(SHA2('s8',256)),NOW(),NULL),
 ('smokelink1',NULL,'Reddit AI fail','','','GPT-5','other','unreviewed','pending','active','link','https://www.reddit.com/r/test/comments/abc','model insisted 9.11 > 9.9',UNHEX(SHA2('s9',256)),NOW(),NULL);

INSERT IGNORE INTO submissions
 (public_id,eah_number,title,prompt,output,ai_model,category,status,repro_status,entry_status,transcript_mode,tracking_hash,submitted_at,owner_user_id)
SELECT 'smokedrft1',NULL,'My draft entry','p','o','GPT-5','','draft','pending','active','single',UNHEX(SHA2('s4',256)),NOW(),id FROM users WHERE username='user';
INSERT IGNORE INTO submissions
 (public_id,eah_number,title,prompt,output,ai_model,category,status,repro_status,entry_status,transcript_mode,tracking_hash,submitted_at,owner_user_id)
SELECT 'smokeunr01',NULL,'My unreviewed entry','p','o','Claude','spiraling','unreviewed','pending','active','single',UNHEX(SHA2('s5',256)),NOW(),id FROM users WHERE username='user';
SQL
  dbq < "$sqlfile"
  rm -f "$sqlfile"
}

stop_server() {
  if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
  fi
  pkill -f "bun .*src/server.ts" 2>/dev/null || true
  rm -f "$PIDFILE"
}

start_server() {
  stop_server
  say "booting server on :$APP_PORT"
  ( cd "$ROOT" && exec bun --env-file=.env.smoke src/server.ts ) >"$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  for _ in $(seq 1 30); do
    if [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/about" 2>/dev/null)" == "200" ]]; then
      say "server up"
      return 0
    fi
    sleep 1
  done
  tail -n 20 "$LOGFILE" >&2 || true
  die "server did not come up — see $LOGFILE"
}

cmd_up() {
  require_tools
  start_db
  write_env
  say "running migrations"
  ( cd "$ROOT" && bun --env-file=.env.smoke scripts/migrate.ts ) >/dev/null
  seed
  start_server
  echo
  say "ready → http://localhost:$APP_PORT"
  say "seed login password for all users: $SEED_PASSWORD"
  say "session cookies (curl --cookie '<value>' …):"
  mint_cookie owner
  mint_cookie staff
  mint_cookie user
  echo
  say "examples:"
  echo "  curl -s 'http://localhost:$APP_PORT/browse?category=spiraling&category=fabricated-citation'"
  echo "  curl -s --cookie 'eah_session=…' http://localhost:$APP_PORT/admin/users"
}

cmd_down() {
  stop_server
  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    docker rm -f "$CONTAINER" >/dev/null && say "removed container $CONTAINER"
  fi
  rm -f "$ENV_FILE" && say "removed $ENV_FILE" || true
}

case "${1:-}" in
  up)      cmd_up ;;
  down)    cmd_down ;;
  reset)   cmd_down; cmd_up ;;
  cookies) mint_cookie owner; mint_cookie staff; mint_cookie user ;;
  sql)     shift; dbq -e "$*" ;;
  logs)    tail -n 50 -f "$LOGFILE" ;;
  status)
    docker ps --filter "name=$CONTAINER" --format '  db: {{.Names}} ({{.Status}})' || true
    if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "  server: running (pid $(cat "$PIDFILE")) on :$APP_PORT"
    else
      echo "  server: not running"
    fi
    ;;
  *) die "usage: scripts/smoke.sh {up|down|reset|cookies|sql '<query>'|logs|status}" ;;
esac
