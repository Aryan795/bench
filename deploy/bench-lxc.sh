#!/usr/bin/env bash
#
# bench-lxc.sh — create an unprivileged Proxmox LXC and deploy Bench inside it.
#
# Run this ON THE PROXMOX HOST, as root. It:
#   1. creates a Debian 12 unprivileged container with Docker enabled
#      (features: nesting=1,keyctl=1 — Docker will not run in an unprivileged
#      LXC without these),
#   2. installs Docker + the compose plugin inside it,
#   3. copies this repo in, generates secrets, and brings the stack up.
#
# Nothing is published to the LAN: inside the container Bench binds 127.0.0.1
# only. Reach it from the host with `pct exec`, or put a reverse proxy in front.
#
# Usage:
#   1. copy this whole repo onto the Proxmox host (scp/rsync/git)
#   2. cd into it
#   3. ./deploy/bench-lxc.sh              # sensible defaults, or override below
#
# Override anything via environment:
#   CTID=921 CT_HOSTNAME=bench STORAGE=local-lvm BRIDGE=vmbr0 \
#   DISK_GB=8 RAM_MB=1024 CORES=2 ./deploy/bench-lxc.sh
#
set -euo pipefail

# ------------------------------------------------------------------ config
CTID="${CTID:-}"                       # auto-picked from pvesh if empty
CT_HOSTNAME="${CT_HOSTNAME:-bench}"
STORAGE="${STORAGE:-local-lvm}"        # where the rootfs lives
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"  # where the template tarball lives
BRIDGE="${BRIDGE:-vmbr0}"
DISK_GB="${DISK_GB:-8}"
RAM_MB="${RAM_MB:-1024}"
CORES="${CORES:-2}"
UNPRIVILEGED="${UNPRIVILEGED:-1}"
TEMPLATE="${TEMPLATE:-debian-12-standard}"
BRIDGE_IP="${BRIDGE_IP:-dhcp}"         # or e.g. 192.168.1.60/24
GATEWAY="${GATEWAY:-}"                 # required only if BRIDGE_IP is static
BENCH_SRC="${BENCH_SRC:-$(cd "$(dirname "$0")/.." && pwd)}"

# loopback (default) publishes the port on 127.0.0.1 inside the container, so
# the only way in is an SSH tunnel. lan publishes on 0.0.0.0 and puts the admin
# login on your network — opt in deliberately, never by default.
BIND="${BIND:-loopback}"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!! \033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx \033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------ preflight
command -v pct >/dev/null   || die "pct not found — run this on a Proxmox VE host."
command -v pvesh >/dev/null || die "pvesh not found — run this on a Proxmox VE host."
case "$BIND" in
  loopback|lan) ;;
  *) die "BIND must be 'loopback' or 'lan', got '$BIND'." ;;
esac
[ "$(id -u)" -eq 0 ]        || die "must run as root."
[ -f "$BENCH_SRC/docker-compose.yml" ] || die "no docker-compose.yml under $BENCH_SRC — set BENCH_SRC to the repo."

if [ -z "$CTID" ]; then
  CTID="$(pvesh get /cluster/nextid)"
fi
pct status "$CTID" >/dev/null 2>&1 && die "CTID $CTID already exists — pass a different CTID."

# ------------------------------------------------------------------ AVX / MongoDB image
# An LXC shares the host CPU. MongoDB 5.0+ crash-loops without AVX; fall back to
# 4.4 (the last release that runs without it) so the deploy never silently fails.
if grep -qm1 avx /proc/cpuinfo; then
  MONGO_IMAGE="${MONGO_IMAGE:-mongo:7}"
  say "host CPU has AVX — using $MONGO_IMAGE"
else
  MONGO_IMAGE="${MONGO_IMAGE:-mongo:4.4}"
  warn "host CPU has NO AVX — falling back to $MONGO_IMAGE (MongoDB 5.0+ needs AVX)."
  warn "If your Proxmox VM/CPU type hides AVX, set CPU type to 'host' and re-run for mongo:7."
fi

# ------------------------------------------------------------------ template
TEMPLATE_REF="$(pveam available 2>/dev/null | awk -v t="$TEMPLATE" '$2 ~ t {print $2}' | sort -V | tail -1)"
[ -n "$TEMPLATE_REF" ] || die "no template matching '$TEMPLATE' in pveam. Try: pveam available | grep debian-12"

if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE_REF"; then
  say "downloading template $TEMPLATE_REF to $TEMPLATE_STORAGE"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE_REF"
fi
TEMPLATE_VOL="$TEMPLATE_STORAGE:vztmpl/$TEMPLATE_REF"

# ------------------------------------------------------------------ net string
if [ "$BRIDGE_IP" = "dhcp" ]; then
  NET="name=eth0,bridge=$BRIDGE,ip=dhcp"
else
  [ -n "$GATEWAY" ] || die "static BRIDGE_IP set but no GATEWAY given."
  NET="name=eth0,bridge=$BRIDGE,ip=$BRIDGE_IP,gw=$GATEWAY"
fi

# ------------------------------------------------------------------ create
say "creating unprivileged CT $CTID ($CT_HOSTNAME) — ${CORES} cores, ${RAM_MB}MB, ${DISK_GB}G on $STORAGE"
pct create "$CTID" "$TEMPLATE_VOL" \
  --hostname "$CT_HOSTNAME" \
  --cores "$CORES" \
  --memory "$RAM_MB" \
  --swap 512 \
  --rootfs "$STORAGE:$DISK_GB" \
  --net0 "$NET" \
  --unprivileged "$UNPRIVILEGED" \
  --features nesting=1,keyctl=1 \
  --onboot 1 \
  --description "Bench — blog/portfolio. Managed by deploy/bench-lxc.sh."

say "starting CT $CTID"
pct start "$CTID"

# wait for the network to actually resolve, not just for the CT to boot
say "waiting for network inside the container"
for i in $(seq 1 30); do
  if pct exec "$CTID" -- sh -c 'command -v getent >/dev/null && getent hosts deb.debian.org >/dev/null 2>&1'; then
    break
  fi
  sleep 2
  [ "$i" -eq 30 ] && die "container has no working DNS/network after 60s."
done

# Needed here, not just in the closing report: with BIND=lan, PUBLIC_ORIGIN has
# to name the address the browser will actually use, and .env is written before
# the end of this script.
CT_IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
if [ "$BIND" = "lan" ]; then
  [ -n "$CT_IP" ] || die "BIND=lan but the container reported no IP address."
  BIND_ADDR="0.0.0.0"
  ORIGIN_VALUE="http://$CT_IP:4000"
  warn "BIND=lan — Bench will be reachable at $ORIGIN_VALUE by anyone on this network."
else
  BIND_ADDR="127.0.0.1"
  ORIGIN_VALUE="http://127.0.0.1:4000"
fi

# ------------------------------------------------------------------ base + docker
say "installing base packages and Docker inside the container"
pct exec "$CTID" -- bash -lc '
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg openssl >/dev/null

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
systemctl enable --now docker >/dev/null 2>&1

# unattended security updates — a homelab box nobody logs into should patch itself
apt-get install -y -qq unattended-upgrades >/dev/null
'

# ------------------------------------------------------------------ push the app
say "copying the app into the container"
TARBALL="$(mktemp /tmp/bench-XXXXXX.tar.gz)"
tar --exclude=node_modules --exclude=.git --exclude=data --exclude='.env' \
    -czf "$TARBALL" -C "$BENCH_SRC" .
pct exec "$CTID" -- mkdir -p /opt/bench
pct push "$CTID" "$TARBALL" /opt/bench/bench.tar.gz
pct exec "$CTID" -- tar -xzf /opt/bench/bench.tar.gz -C /opt/bench
pct exec "$CTID" -- rm -f /opt/bench/bench.tar.gz
rm -f "$TARBALL"

# ------------------------------------------------------------------ secrets + up
say "generating secrets and starting the stack"
ADMIN_PW="$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)"
pct exec "$CTID" -- bash -lc "
set -euo pipefail
cd /opt/bench
if [ ! -f .env ]; then
  cat > .env <<EOF
SESSION_SECRET=\$(openssl rand -hex 32)
MONGO_USER=bench
MONGO_PASSWORD=\$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
MONGO_DB=bench
MONGO_IMAGE=$MONGO_IMAGE
ADMIN_USER=admin
ADMIN_PASSWORD=$ADMIN_PW
BIND_ADDR=$BIND_ADDR
PUBLIC_ORIGIN=$ORIGIN_VALUE
SECURE_COOKIES=false
# No proxy inside the container by default. Set to 1 (and SECURE_COOKIES=true,
# PUBLIC_ORIGIN=https://your.domain) only once Caddy/Cloudflare Tunnel is in front.
TRUST_PROXY=0
EOF
  chmod 600 .env
fi
docker compose up -d --build
"

# ------------------------------------------------------------------ report
# CT_IP was captured right after boot, above.
if [ "$BIND" = "lan" ]; then
  ACCESS="  Open it at   : http://${CT_IP}:4000   (admin at /admin)
  Reachable by anyone on your LAN. Put TLS in front before it leaves the house."
else
  ACCESS="  Inside the CT: http://127.0.0.1:4000   (admin at /admin)

  Bench binds 127.0.0.1 inside the container — it is NOT on your LAN.
  Quickest way in, opening nothing:
    pct exec $CTID -- apt-get install -y openssh-server
    ssh -N -L 4000:127.0.0.1:4000 root@${CT_IP:-<container-ip>}
  then browse http://127.0.0.1:4000 on your own machine."
fi

cat <<EOF

$(printf '\033[1;32m==> Bench is up in CT %s\033[0m' "$CTID")

  Container IP : ${CT_IP:-<check: pct exec $CTID -- hostname -I>}
$ACCESS
  Mongo image  : $MONGO_IMAGE

  ADMIN LOGIN
    username : admin
    password : $ADMIN_PW
    ^ change it from the Account tab, then this printout is worthless.

  To publish it properly, put Caddy/Cloudflare Tunnel in front, set
  SECURE_COOKIES=true and TRUST_PROXY=1 in /opt/bench/.env, then:
      cd /opt/bench && docker compose up -d

  Manage it:
    pct exec $CTID -- bash -lc 'cd /opt/bench && docker compose ps'
    pct exec $CTID -- bash -lc 'cd /opt/bench && docker compose logs -f bench'

EOF
