#!/bin/bash
set -euo pipefail

# backup-db.sh — dump the EAH MariaDB, gzip it, rotate old copies, and
# (optionally) push to Oracle Object Storage via a Pre-Authenticated Request.
#
# Runs ON the host (where MariaDB lives on 127.0.0.1). Reads DB creds from
# ~/eah/.env — no secrets on the command line, no `ps` leakage (uses a
# temp --defaults-extra-file).
#
# Object Storage upload uses a PAR (Pre-Authenticated Request) URL: the
# zero-dependency way to write to a bucket — no OCI CLI, no API keys. Create
# one in the console (bucket → Pre-Authenticated Requests → Create, "Permit
# object writes", scope "Bucket", expiry far out).
#
# The PAR is a bearer secret and host-side OPS config (the app never reads it),
# so — like deploy.sh's Cloudflare token — it lives in its own file, NOT in
# .env (which is app/container config). Default location: ~/eah/.backup-par.
# Create it once:
#   umask 077; echo 'https://objectstorage.<region>.oraclecloud.com/p/<token>/n/<ns>/b/<bucket>/o/' > ~/eah/.backup-par
# The URL MUST end in a trailing slash (we append the filename to it).
# If absent, the backup stays local-only — still useful, just not off-box.
#
# Cron example (daily 03:17 UTC, log to a file cron can mail you on error) —
# note NO secret on the command line; the script reads the PAR file itself:
#   17 3 * * *  /home/ubuntu/eah/scripts/backup-db.sh >> /home/ubuntu/eah/backups/backup.log 2>&1

# ---- config (override via env) ---------------------------------------------
APP_DIR="${APP_DIR:-$HOME/eah}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
# PAR lives in its own file (host-side ops secret, not app config). Env var
# overrides the file if set, mirroring the *_FILE convention elsewhere.
OBJECT_STORAGE_PAR="${OBJECT_STORAGE_PAR:-}"
OBJECT_STORAGE_PAR_FILE="${OBJECT_STORAGE_PAR_FILE:-$APP_DIR/.backup-par}"
# age PUBLIC key (recipient). Encrypts every backup artifact at creation, so the
# only plaintext copy of the data anywhere is the live MariaDB. A public key is
# NOT a secret — it cannot decrypt anything — so it may sit on the box (or in
# git). The matching PRIVATE key MUST live OFF this box (password manager +
# encrypted laptop), never here, so a host compromise can't read the off-box
# backup history. If unset, backups are written UNENCRYPTED (with a warning).
AGE_RECIPIENT="${AGE_RECIPIENT:-}"
AGE_RECIPIENT_FILE="${AGE_RECIPIENT_FILE:-$APP_DIR/.backup-age-pub}"

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

[[ -f "$ENV_FILE" ]] || die "no .env at $ENV_FILE"

# Pull just the keys we need — the file is docker env_file format, not bash,
# so do NOT `source` it (unquoted spaces in e.g. EMAIL_FROM break the parse).
get_env() { grep -E "^$1=" "$ENV_FILE" | head -n1 | cut -d= -f2-; }
DB_HOST="$(get_env DB_HOST)"; DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="$(get_env DB_PORT)"; DB_PORT="${DB_PORT:-3306}"
DB_NAME="$(get_env DB_NAME)"; DB_NAME="${DB_NAME:-eah}"
DB_USER="$(get_env DB_USER)"; DB_USER="${DB_USER:-eah}"
DB_PASSWORD="$(get_env DB_PASSWORD)"
[[ -n "$DB_PASSWORD" ]] || die ".env has no DB_PASSWORD"

# Resolve the PAR from its file unless an env override was given.
if [[ -z "$OBJECT_STORAGE_PAR" && -r "$OBJECT_STORAGE_PAR_FILE" ]]; then
  OBJECT_STORAGE_PAR="$(tr -d '[:space:]' < "$OBJECT_STORAGE_PAR_FILE")"
fi

# Resolve the age recipient (public key) from its file unless overridden.
if [[ -z "$AGE_RECIPIENT" && -r "$AGE_RECIPIENT_FILE" ]]; then
  AGE_RECIPIENT="$(grep -E '^age1' "$AGE_RECIPIENT_FILE" | head -n1)"
fi

# Prefer mariadb-dump (Ubuntu 24.04 ships this; mysqldump is a compat symlink).
if command -v mariadb-dump >/dev/null 2>&1; then DUMP=mariadb-dump
elif command -v mysqldump >/dev/null 2>&1; then DUMP=mysqldump
else die "no mariadb-dump / mysqldump found"; fi

mkdir -p "$BACKUP_DIR"

# Credentials file instead of CLI args, so the password never shows in `ps`.
CRED_FILE="$(mktemp)"
trap 'rm -f "$CRED_FILE"' EXIT
chmod 600 "$CRED_FILE"
cat > "$CRED_FILE" <<EOF
[client]
host=$DB_HOST
port=$DB_PORT
user=$DB_USER
password=$DB_PASSWORD
EOF

STAMP="$(date -u +%Y%m%d-%H%M%S)"

# Encrypt at creation when a recipient is configured: the artifact is sealed
# everywhere it lands (on-box, PAR, Spaces, any copy pulled to a laptop), and
# the only plaintext is the live DB. age can't decrypt with the public key, so
# even this host can't read its own backup history.
if [[ -n "$AGE_RECIPIENT" ]]; then
  command -v age >/dev/null 2>&1 || die "AGE_RECIPIENT set but 'age' not installed (apt-get install age)"
  OUT="$BACKUP_DIR/eah-${STAMP}.sql.gz.age"
  ENCRYPT=(age -r "$AGE_RECIPIENT")
else
  log "WARNING: no AGE_RECIPIENT (.backup-age-pub absent) — writing UNENCRYPTED backup"
  OUT="$BACKUP_DIR/eah-${STAMP}.sql.gz"
  ENCRYPT=(cat)
fi

log "dumping ${DB_NAME} -> ${OUT}"
# --single-transaction: consistent InnoDB snapshot without locking writers.
# Dump to a .partial first; only rename on success so a failed dump can't be
# mistaken for a good backup or uploaded. set -o pipefail makes a failure in
# the dump or age stage abort the rename.
"$DUMP" --defaults-extra-file="$CRED_FILE" \
  --single-transaction --quick --routines --triggers --events \
  "$DB_NAME" | gzip | "${ENCRYPT[@]}" > "${OUT}.partial"
mv "${OUT}.partial" "$OUT"
log "dump complete ($(du -h "$OUT" | cut -f1))"

# ---- rotate local copies ---------------------------------------------------
log "pruning local backups older than ${KEEP_DAYS} days"
find "$BACKUP_DIR" -maxdepth 1 -name 'eah-*.sql.gz*' -mtime "+${KEEP_DAYS}" -print -delete || true

offbox=0

# ---- optional off-box upload #1: Oracle Object Storage PAR -----------------
if [[ -n "$OBJECT_STORAGE_PAR" ]]; then
  [[ "$OBJECT_STORAGE_PAR" == */ ]] || die "OBJECT_STORAGE_PAR must end in '/'"
  log "uploading to Object Storage (PAR)"
  curl -fsS --upload-file "$OUT" "${OBJECT_STORAGE_PAR}$(basename "$OUT")" \
    && { log "PAR upload ok"; offbox=1; } \
    || die "PAR upload failed (local copy kept at $OUT)"
fi

# ---- optional off-box upload #2: DigitalOcean Spaces (S3) via s3cmd --------
# Creds in their own file (host-side ops secret, not app config), like the PAR.
# Format, one KEY=value per line, no quotes (provision with provision-spaces.sh):
#   SPACES_REGION=sfo3
#   SPACES_BUCKET=enaih-backups
#   SPACES_KEY=...
#   SPACES_SECRET=...
# No Spaces-side rotation: dumps are tiny (~6 KB) and cold-storage charges for
# frequent list/delete, so we just upload. Set a bucket lifecycle rule in the
# DO panel if you want server-side expiry.
SPACES_CREDS_FILE="${SPACES_CREDS_FILE:-$APP_DIR/.spaces}"
if [[ -r "$SPACES_CREDS_FILE" ]]; then
  command -v s3cmd >/dev/null || die "s3cmd not installed (apt-get install s3cmd)"
  sget(){ grep -E "^$1=" "$SPACES_CREDS_FILE" | head -n1 | cut -d= -f2-; }
  s_region="$(sget SPACES_REGION)"; s_bucket="$(sget SPACES_BUCKET)"
  s_key="$(sget SPACES_KEY)"; s_secret="$(sget SPACES_SECRET)"
  [[ -n "$s_region" && -n "$s_bucket" && -n "$s_key" && -n "$s_secret" ]] \
    || die "$SPACES_CREDS_FILE missing a field (need SPACES_REGION/BUCKET/KEY/SECRET)"
  S3CFG="$(mktemp)"; chmod 600 "$S3CFG"
  trap 'rm -f "$CRED_FILE" "$S3CFG"' EXIT   # extend cleanup to the temp s3 config
  cat > "$S3CFG" <<CFG
[default]
access_key = $s_key
secret_key = $s_secret
host_base = $s_region.digitaloceanspaces.com
host_bucket = %(bucket)s.$s_region.digitaloceanspaces.com
use_https = True
CFG
  log "uploading to Spaces (s3://$s_bucket @ $s_region)"
  s3cmd -c "$S3CFG" put "$OUT" "s3://$s_bucket/$(basename "$OUT")" >/dev/null \
    && { log "Spaces upload ok"; offbox=1; } \
    || die "Spaces upload failed (local copy kept at $OUT)"
fi

[[ "$offbox" == 1 ]] || log "no off-box target configured (.backup-par / .spaces absent) — local-only backup"

log "done"
