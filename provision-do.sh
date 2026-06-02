#!/bin/bash
set -euo pipefail

# provision-do.sh — reproducibly create the EAH droplet via the DigitalOcean API.
#
# Runs on your LAPTOP. Creates (or finds) one droplet, waits for it to boot,
# prints its public IP + next steps. It does NOT configure the box — that's
# bootstrap.sh's job (portable to any Ubuntu host: droplet, Pi, friend's server).
#
# The DO token is read from $DO_API_TOKEN (never written, logged, or echoed;
# passed to curl via a config FD so it stays out of `ps`). Mint a SCOPED token
# (droplet:create, droplet:read, ssh_key:read) — not a full-access PAT:
#   DO_API_TOKEN='dop_v1_...'  ./provision-do.sh
#
# Idempotent: if a droplet tagged "$DROPLET_TAG" already exists, it prints that
# droplet's IP and exits instead of creating a second one.
#
# Tunables (env overrides):
#   DO_REGION     default sfo3   (San Francisco — closest to the Bay)
#   DO_SIZE       default s-1vcpu-2gb  ($12/mo: 2 GB. others: s-1vcpu-1gb $6,
#                                       s-2vcpu-2gb $18, s-2vcpu-4gb $24)
#   DO_IMAGE      default ubuntu-24-04-x64
#   DROPLET_NAME  default enaih
#   DROPLET_TAG   default enaih  (used for the dup check)
#   SSH_KEY_NAME  default ""     (attach only the account key with this name;
#                                 empty = attach ALL account SSH keys)
#   DO_USER_DATA_FILE  optional cloud-init file to run on first boot

: "${DO_API_TOKEN:?set DO_API_TOKEN to a DigitalOcean token (scoped: droplet:create,droplet:read,ssh_key:read)}"
command -v curl >/dev/null    || { echo "need curl" >&2; exit 1; }
command -v python3 >/dev/null || { echo "need python3" >&2; exit 1; }

REGION="${DO_REGION:-sfo3}"
SIZE="${DO_SIZE:-s-1vcpu-2gb}"
IMAGE="${DO_IMAGE:-ubuntu-24-04-x64}"
NAME="${DROPLET_NAME:-enaih}"
TAG="${DROPLET_TAG:-enaih}"
SSH_KEY_NAME="${SSH_KEY_NAME:-}"
API="https://api.digitalocean.com/v2"

# curl wrapper: token goes in via -K <(...) (a config FD), not argv, so it never
# appears in `ps`. printf is a bash builtin, so no separate process either.
do_api() {
  local method="$1" path="$2" data="${3:-}"
  curl --fail-with-body -sS -X "$method" "${API}${path}" \
    -H "Content-Type: application/json" \
    -K <(printf 'header = "Authorization: Bearer %s"\n' "$DO_API_TOKEN") \
    ${data:+--data "$data"}
}
log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# ---- 1. resolve SSH key ids -------------------------------------------------
log "looking up account SSH keys"
keys_json="$(do_api GET /account/keys)"
SSH_KEY_IDS="$(printf '%s' "$keys_json" | SSH_KEY_NAME="$SSH_KEY_NAME" python3 -c '
import sys, json, os
want = os.environ.get("SSH_KEY_NAME", "")
keys = json.load(sys.stdin)["ssh_keys"]
sel = [k for k in keys if (not want or k["name"] == want)]
print(" ".join(str(k["id"]) for k in sel))
')"
if [[ -z "$SSH_KEY_IDS" ]]; then
  echo "ERROR: no matching SSH keys in the DO account." >&2
  echo "  Add one: DO console → Settings → Security → SSH Keys (or check SSH_KEY_NAME)." >&2
  echo "  Without a key the droplet would be unreachable." >&2
  exit 1
fi
echo "attaching key id(s): $SSH_KEY_IDS"

# ---- 2. idempotency: reuse an existing droplet by tag -----------------------
log "checking for an existing droplet tagged '$TAG'"
existing_ip="$(do_api GET "/droplets?tag_name=${TAG}" | python3 -c '
import sys, json
ds = json.load(sys.stdin).get("droplets", [])
if ds:
    v4 = ds[0].get("networks", {}).get("v4", [])
    pub = next((n["ip_address"] for n in v4 if n.get("type") == "public"), "")
    print(pub or "PENDING")
')"
if [[ -n "$existing_ip" ]]; then
  echo "a droplet tagged '$TAG' already exists (ip: ${existing_ip}). Not creating another."
  echo "delete it in the DO console first if you want a fresh box."
  [[ "$existing_ip" != "PENDING" ]] && echo "$existing_ip"
  exit 0
fi

# ---- 3. create --------------------------------------------------------------
USER_DATA=""
if [[ -n "${DO_USER_DATA_FILE:-}" ]]; then
  [[ -r "$DO_USER_DATA_FILE" ]] || { echo "DO_USER_DATA_FILE not readable: $DO_USER_DATA_FILE" >&2; exit 1; }
  USER_DATA="$(cat "$DO_USER_DATA_FILE")"
fi

payload="$(NAME="$NAME" REGION="$REGION" SIZE="$SIZE" IMAGE="$IMAGE" TAG="$TAG" \
  SSH_KEY_IDS="$SSH_KEY_IDS" USER_DATA="$USER_DATA" python3 - <<'PY'
import os, json
d = {
  "name":   os.environ["NAME"],
  "region": os.environ["REGION"],
  "size":   os.environ["SIZE"],
  "image":  os.environ["IMAGE"],
  "ssh_keys": [int(x) for x in os.environ["SSH_KEY_IDS"].split()],
  "tags":   [os.environ["TAG"]],
  "backups": False,
  "monitoring": True,
}
ud = os.environ.get("USER_DATA", "")
if ud:
    d["user_data"] = ud
print(json.dumps(d))
PY
)"

log "creating droplet '$NAME' ($SIZE, $IMAGE, $REGION)"
create_resp="$(do_api POST /droplets "$payload")"
droplet_id="$(printf '%s' "$create_resp" | python3 -c 'import sys,json;print(json.load(sys.stdin)["droplet"]["id"])')"
echo "droplet id: $droplet_id — waiting for it to boot..."

# ---- 4. poll until active with a public IP ----------------------------------
ip=""
for _ in $(seq 1 60); do          # up to ~8 min
  sleep 8
  d="$(do_api GET "/droplets/${droplet_id}")"
  read -r status ip < <(printf '%s' "$d" | python3 -c '
import sys, json
dr = json.load(sys.stdin)["droplet"]
v4 = dr.get("networks", {}).get("v4", [])
pub = next((n["ip_address"] for n in v4 if n.get("type") == "public"), "")
print(dr.get("status", ""), pub)
')
  echo "  status=$status ip=${ip:-none}"
  [[ "$status" == "active" && -n "$ip" ]] && break
done
[[ -n "$ip" ]] || { echo "ERROR: droplet never reported a public IP — check the DO console." >&2; exit 1; }

# ---- done -------------------------------------------------------------------
log "droplet up at $ip"
cat <<DONE

Next steps:
  1. SSH in directly (DO Ubuntu images log in as ROOT, not 'ubuntu'):
       ssh root@${ip}
  2. Copy + run the host setup, with your Cloudflare tunnel token:
       scp bootstrap.sh root@${ip}:~/
       ssh root@${ip} 'TUNNEL_TOKEN="eyJ..." bash ~/bootstrap.sh'
     (APP_DIR defaults to /root/eah when you run it as root.)
  3. Set tunnel routes (app -> localhost:8090, ssh.enaih.org -> ssh://localhost:22),
     add the 'enaih' SSH alias, then:  DEPLOY_HOST=enaih ./deploy.sh
  4. Once the tunnel SSH path works, drop inbound :22 (DO → Networking → Firewalls)
     and take a DO Snapshot of the configured box.

Note: 'enaih' alias should use  User root  on a DO droplet (Oracle used 'ubuntu').
DONE
