#!/bin/bash
set -euo pipefail

# provision-spaces.sh — create a DigitalOcean Spaces bucket for off-box backups.
#
# One-time, OPTIONAL. Spaces buckets are created via the S3 API (not the DO
# droplet API), so this uses s3cmd. Creating a bucket is also a one-click job in
# the panel (Spaces Object Storage -> Create a Space); this script just makes it
# reproducible.
#
# Key flow (changed 2025/26): DO panel -> Spaces Object Storage -> Access Keys
# tab -> Create Access Key. These *Spaces* keys are SEPARATE from the droplet
# DO_API_TOKEN. Keys are now scoped:
#   - "Full access" — can create buckets. REQUIRED to run THIS script.
#   - "Limited"     — per-bucket Read / Read-Write-Delete; CANNOT create buckets.
# Least privilege: run this once with a Full-access key, but for the daily
# backup upload (the key that lives in ~/eah/.spaces on the always-on droplet),
# use a separate *Limited* key scoped to just this bucket with Read/Write.
#
# Credentials are read from env, or from a creds file (default ~/eah/.spaces or
# $SPACES_CREDS_FILE) in the same KEY=value format backup-db.sh consumes:
#   SPACES_REGION=sfo3
#   SPACES_BUCKET=enaih-backups
#   SPACES_KEY=...
#   SPACES_SECRET=...
#
# Run with env:
#   SPACES_REGION=sfo3 SPACES_BUCKET=enaih-backups SPACES_KEY=... SPACES_SECRET=... ./provision-spaces.sh
# or create the creds file first and run with no args.
#
# Idempotent: re-running when the bucket already exists (and is yours) is fine.

command -v s3cmd >/dev/null || { echo "need s3cmd (apt-get install s3cmd / brew install s3cmd)" >&2; exit 1; }

CREDS_FILE="${SPACES_CREDS_FILE:-$HOME/eah/.spaces}"
sget(){ [[ -r "$CREDS_FILE" ]] && grep -E "^$1=" "$CREDS_FILE" | head -n1 | cut -d= -f2- || true; }

# env wins, else creds file
SPACES_REGION="${SPACES_REGION:-$(sget SPACES_REGION)}"
SPACES_BUCKET="${SPACES_BUCKET:-$(sget SPACES_BUCKET)}"
SPACES_KEY="${SPACES_KEY:-$(sget SPACES_KEY)}"
SPACES_SECRET="${SPACES_SECRET:-$(sget SPACES_SECRET)}"

for v in SPACES_REGION SPACES_BUCKET SPACES_KEY SPACES_SECRET; do
  [[ -n "${!v}" ]] || { echo "ERROR: $v not set (env or $CREDS_FILE)" >&2; exit 1; }
done

# Temp s3cmd config so the secret never hits argv/ps.
S3CFG="$(mktemp)"; trap 'rm -f "$S3CFG"' EXIT; chmod 600 "$S3CFG"
cat > "$S3CFG" <<CFG
[default]
access_key = $SPACES_KEY
secret_key = $SPACES_SECRET
host_base = $SPACES_REGION.digitaloceanspaces.com
host_bucket = %(bucket)s.$SPACES_REGION.digitaloceanspaces.com
use_https = True
CFG

echo "==> creating bucket s3://$SPACES_BUCKET in $SPACES_REGION"
if s3cmd -c "$S3CFG" mb "s3://$SPACES_BUCKET" 2>/tmp/mb.err; then
  echo "    created."
else
  if grep -qiE "already (exists|own)|BucketAlreadyOwnedByYou|Conflict" /tmp/mb.err; then
    echo "    already exists (yours) — ok."
  else
    echo "ERROR creating bucket:" >&2; cat /tmp/mb.err >&2; exit 1
  fi
fi

# Keep it private (backups are not public). DO buckets default private, but be explicit.
s3cmd -c "$S3CFG" setacl "s3://$SPACES_BUCKET" --acl-private >/dev/null 2>&1 || true

echo "==> verifying access (list bucket)"
s3cmd -c "$S3CFG" ls "s3://$SPACES_BUCKET" >/dev/null && echo "    ok — bucket reachable."

cat <<DONE

Bucket ready. Next:
  1. Put the SAME four values in /root/eah/.spaces ON THE DROPLET (enaih), so the
     daily backup uploads there:
       ssh enaih 'umask 077; cat > /root/eah/.spaces' <<EOF
       SPACES_REGION=$SPACES_REGION
       SPACES_BUCKET=$SPACES_BUCKET
       SPACES_KEY=<key>
       SPACES_SECRET=<secret>
       EOF
  2. Test it:  ssh enaih 'sudo systemctl start eah-backup.service && journalctl -u eah-backup -n 20 --no-pager'
  3. (Optional) set a lifecycle/expiry rule on the bucket in the DO panel.

The .spaces file is host-side ops config (a bearer secret) — it lives outside
.env and is already excluded from deploy's rsync --delete (alongside .backup-par).
DONE
