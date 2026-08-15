#!/usr/bin/env bash
#
# bench-lxc-native.sh — create a Proxmox LXC and run Bench directly in it,
# with no Docker layer. Node and MongoDB are installed into the container's
# own OS and supervised by systemd.
#
# Run this ON THE PROXMOX HOST, as root.
#
# Difference from deploy/bench-lxc.sh:
#
#   Docker path                       Native path (this script)
#   ---------------------------------------------------------------
#   needs features nesting=1,keyctl=1 needs NO extra features
#   ~3.8 GB disk, ~275 MB RAM         ~2.5 GB disk, ~155 MB RAM
#   docker compose up -d              systemctl start bench
#   docker compose logs -f bench      journalctl -u bench -f
#   app isolated in its own container app isolated by systemd sandboxing
#
# Not needing `nesting` is the real reason to prefer this: the container
# stays unprivileged with default features, so the host's kernel surface is
# not widened to let a Docker daemon run inside.
#
# Usage:
#   1. copy this repo onto the Proxmox host (git clone / scp / rsync)
#   2. cd into it
#   3. ./deploy/bench-lxc-native.sh
#
# Override anything via environment:
#   CTID=922 CT_HOSTNAME=bench STORAGE=local-lvm BRIDGE=vmbr0 \
#   DISK_GB=6 RAM_MB=1024 CORES=2 ./deploy/bench-lxc-native.sh
#
set -euo pipefail

# ------------------------------------------------------------------ config
CTID="${CTID:-}"                                 # auto-picked from pvesh if empty
CT_HOSTNAME="${CT_HOSTNAME:-bench}"
STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
BRIDGE="${BRIDGE:-vmbr0}"
DISK_GB="${DISK_GB:-6}"                          # native needs less than the Docker path
RAM_MB="${RAM_MB:-1024}"
CORES="${CORES:-2}"
UNPRIVILEGED="${UNPRIVILEGED:-1}"
TEMPLATE="${TEMPLATE:-debian-12-standard}"
BRIDGE_IP="${BRIDGE_IP:-dhcp}"                   # or e.g. 192.168.1.61/24
GATEWAY="${GATEWAY:-}"                           # required only if BRIDGE_IP is static
BENCH_SRC="${BENCH_SRC:-$(cd "$(dirname "$0")/.." && pwd)}"

NODE_MAJOR="${NODE_MAJOR:-20}"
MONGO_VERSION="${MONGO_VERSION:-7.0}"
ALLOW_NO_AVX="${ALLOW_NO_AVX:-0}"

# loopback (default) binds 127.0.0.1 inside the container, so the only way in is
# an SSH tunnel. lan binds 0.0.0.0 and puts the admin login on your network —
# opt in deliberately, never by default. Validated down in preflight, once die()
# exists.
BIND="${BIND:-loopback}"

APP_DIR=/opt/bench
STATE_DIR=/var/lib/bench
ENV_FILE=/etc/bench.env

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!! \033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx \033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------ preflight
command -v pct   >/dev/null || die "pct not found — run this on a Proxmox VE host."
command -v pvesh >/dev/null || die "pvesh not found — run this on a Proxmox VE host."
[ "$(id -u)" -eq 0 ] || die "must run as root."
[ -f "$BENCH_SRC/package.json" ] || die "no package.json under $BENCH_SRC — set BENCH_SRC to the repo."
case "$BIND" in
  loopback|lan) ;;
  *) die "BIND must be 'loopback' or 'lan', got '$BIND'." ;;
esac

if [ -z "$CTID" ]; then
  CTID="$(pvesh get /cluster/nextid)"
fi
pct status "$CTID" >/dev/null 2>&1 && die "CTID $CTID already exists — pass a different CTID."

# ------------------------------------------------------------------ AVX gate
#
# MongoDB 5.0+ requires AVX, and an LXC inherits the host CPU. The Docker path
# can fall back to the mongo:4.4 image, which ships its own userland (including
# the libssl1.1 that Debian 12 dropped).
#
# Natively there is no equivalent escape hatch: MongoDB publishes
# mongodb-org-server 4.4 ONLY for Debian 10 (buster), which is end-of-life. On
# bookworm and bullseye the 4.4 repo carries tooling (mongosh, database-tools)
# but no server. So on a CPU without AVX the honest answer is "use the Docker
# script", not "install an EOL distro".
if ! grep -qm1 avx /proc/cpuinfo; then
  warn "This host's CPU does not report AVX, which MongoDB 5.0+ requires."
  warn "There is no native fallback: mongodb-org-server 4.4 is published only"
  warn "for Debian 10 (buster), which is end-of-life."
  warn ""
  warn "Use the Docker path instead — the mongo:4.4 image works without AVX:"
  warn "    ./deploy/bench-lxc.sh"
  warn ""
  warn "If your Proxmox node does have AVX but the container cannot see it, set"
  warn "the node/VM CPU type to 'host' and re-run."
  [ "$ALLOW_NO_AVX" = "1" ] || die "refusing to build a container that would crash-loop. Override with ALLOW_NO_AVX=1."
  warn "ALLOW_NO_AVX=1 set — continuing anyway. mongod will very likely not start."
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
# Note the absence of --features: no nesting, no keyctl. Nothing here needs to
# create nested namespaces, which is the whole point of the native path.
say "creating unprivileged CT $CTID ($CT_HOSTNAME) — ${CORES} cores, ${RAM_MB}MB, ${DISK_GB}G on $STORAGE"
pct create "$CTID" "$TEMPLATE_VOL" \
  --hostname "$CT_HOSTNAME" \
  --cores "$CORES" \
  --memory "$RAM_MB" \
  --swap 512 \
  --rootfs "$STORAGE:$DISK_GB" \
  --net0 "$NET" \
  --unprivileged "$UNPRIVILEGED" \
  --onboot 1 \
  --description "Bench — blog/portfolio, native (no Docker). Managed by deploy/bench-lxc-native.sh."

say "starting CT $CTID"
pct start "$CTID"

say "waiting for network inside the container"
for i in $(seq 1 30); do
  if pct exec "$CTID" -- sh -c 'command -v getent >/dev/null && getent hosts deb.debian.org >/dev/null 2>&1'; then
    break
  fi
  sleep 2
  [ "$i" -eq 30 ] && die "container has no working DNS/network after 60s."
done

# Needed here, not just in the closing report: with BIND=lan the app's
# PUBLIC_ORIGIN has to name the address the browser will actually use, and the
# env file is written well before the end of this script.
CT_IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
if [ "$BIND" = "lan" ]; then
  [ -n "$CT_IP" ] || die "BIND=lan but the container reported no IP address."
  BIND_HOST_VALUE="0.0.0.0"
  ORIGIN_VALUE="http://$CT_IP:4000"
  warn "BIND=lan — Bench will be reachable at $ORIGIN_VALUE by anyone on this network."
else
  BIND_HOST_VALUE="127.0.0.1"
  ORIGIN_VALUE="http://127.0.0.1:4000"
fi

# ------------------------------------------------------------------ base packages
say "installing base packages"
pct exec "$CTID" -- bash -lc '
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg openssl >/dev/null
apt-get install -y -qq unattended-upgrades >/dev/null
'

# ------------------------------------------------------------------ node
say "installing Node ${NODE_MAJOR} from NodeSource"
pct exec "$CTID" -- bash -lc "
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
chmod a+r /etc/apt/keyrings/nodesource.gpg
echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main' \
  > /etc/apt/sources.list.d/nodesource.list
apt-get update -qq
apt-get install -y -qq nodejs >/dev/null
node --version
"

# ------------------------------------------------------------------ mongodb
say "installing MongoDB ${MONGO_VERSION}"
pct exec "$CTID" -- bash -lc "
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
CODENAME=\$(. /etc/os-release && echo \$VERSION_CODENAME)
curl -fsSL https://pgp.mongodb.com/server-${MONGO_VERSION}.asc \
  | gpg --dearmor -o /etc/apt/keyrings/mongodb.gpg
chmod a+r /etc/apt/keyrings/mongodb.gpg
echo \"deb [signed-by=/etc/apt/keyrings/mongodb.gpg] https://repo.mongodb.org/apt/debian \$CODENAME/mongodb-org/${MONGO_VERSION} main\" \
  > /etc/apt/sources.list.d/mongodb-org.list
apt-get update -qq

# Fail loudly here rather than half-installing. Two ways this legitimately
# comes up: the MongoDB repo publishes tooling but no server for a given
# Debian release (all of 4.4 outside buster), and it publishes no server for
# Debian on arm64 at all — only amd64.
if ! apt-cache show mongodb-org-server >/dev/null 2>&1; then
  echo \"mongodb-org-server ${MONGO_VERSION} is not available for Debian \$CODENAME/\$(dpkg --print-architecture).\"
  echo 'MongoDB publishes a Debian server package for amd64 only. On arm64, use the'
  echo 'Docker path (./deploy/bench-lxc.sh) — the official images do cover arm64.'
  exit 1
fi

apt-get install -y -qq mongodb-org >/dev/null
"

# ------------------------------------------------------------------ secrets
say "generating secrets"
ADMIN_PW="$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)"
MONGO_PW="$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)"
SESSION_SECRET="$(openssl rand -hex 32)"

# ------------------------------------------------------------------ mongo auth
# mongod ships with authorization disabled and bound to 127.0.0.1. Create the
# user first, then turn authorization on — the reverse order locks you out.
say "creating the database user and enabling authorization"
pct exec "$CTID" -- bash -lc "
set -euo pipefail
systemctl enable --now mongod >/dev/null 2>&1

for i in \$(seq 1 30); do
  mongosh --quiet --eval 'db.adminCommand({ping:1}).ok' >/dev/null 2>&1 && break
  sleep 2
  [ \"\$i\" -eq 30 ] && { echo 'mongod did not become ready'; journalctl -u mongod -n 30 --no-pager; exit 1; }
done

mongosh --quiet admin --eval '
  db.createUser({
    user: \"bench\",
    pwd: \"${MONGO_PW}\",
    roles: [{ role: \"root\", db: \"admin\" }]
  })
' >/dev/null

# bindIp stays 127.0.0.1 (the package default) so mongod is not reachable from
# the LAN even though there is no Docker network boundary here.
if ! grep -q '^security:' /etc/mongod.conf; then
  printf '\nsecurity:\n  authorization: enabled\n' >> /etc/mongod.conf
fi
systemctl restart mongod

for i in \$(seq 1 30); do
  mongosh --quiet -u bench -p '${MONGO_PW}' --authenticationDatabase admin \
    --eval 'db.adminCommand({ping:1}).ok' >/dev/null 2>&1 && break
  sleep 2
  [ \"\$i\" -eq 30 ] && { echo 'mongod did not come back with auth enabled'; exit 1; }
done
"

# ------------------------------------------------------------------ push the app
say "copying the app into the container"
TARBALL="$(mktemp /tmp/bench-XXXXXX.tar.gz)"
tar --exclude=node_modules --exclude=.git --exclude=data --exclude='.env' \
    -czf "$TARBALL" -C "$BENCH_SRC" .
pct exec "$CTID" -- mkdir -p "$APP_DIR"
pct push "$CTID" "$TARBALL" "$APP_DIR/bench.tar.gz"
pct exec "$CTID" -- tar -xzf "$APP_DIR/bench.tar.gz" -C "$APP_DIR"
pct exec "$CTID" -- rm -f "$APP_DIR/bench.tar.gz"
rm -f "$TARBALL"

say "installing dependencies and building the page"
pct exec "$CTID" -- bash -lc "
set -euo pipefail
cd $APP_DIR
if [ -f package-lock.json ]; then
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null
else
  npm install --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null
fi
npm run build
"

# ------------------------------------------------------------------ service account + env
say "creating the service account and environment file"
pct exec "$CTID" -- bash -lc "
set -euo pipefail
id -u bench >/dev/null 2>&1 || useradd --system --home $APP_DIR --shell /usr/sbin/nologin bench
install -d -o bench -g bench -m 0750 $STATE_DIR

# Root-owned and unreadable by the service user: the unit reads it as root
# before dropping privileges, so bench never needs read access itself.
umask 077
cat > $ENV_FILE <<EOF
NODE_ENV=production
PORT=4000
BIND_HOST=$BIND_HOST_VALUE
DATA_DIR=$STATE_DIR
MONGO_URL=mongodb://bench:${MONGO_PW}@127.0.0.1:27017/?authSource=admin
MONGO_DB=bench
SESSION_SECRET=${SESSION_SECRET}
ADMIN_USER=admin
ADMIN_PASSWORD=${ADMIN_PW}
SECURE_COOKIES=false
TRUST_PROXY=0
PUBLIC_ORIGIN=$ORIGIN_VALUE
EOF
chown root:root $ENV_FILE
chmod 600 $ENV_FILE
"

# ------------------------------------------------------------------ systemd unit
#
# This sandboxing is what replaces the Docker container boundary. Without it,
# native is strictly worse than the Docker path on the inward axis — a
# compromised app would sit next to mongod with apt available.
#
# MemoryDenyWriteExecute is deliberately NOT set: V8 JITs, and it would stop
# Node starting at all.
say "installing the systemd unit"
pct exec "$CTID" -- bash -lc "cat > /etc/systemd/system/bench.service <<'EOF'
[Unit]
Description=Bench — projects and writing
Documentation=https://github.com/Aryan795/bench
After=network-online.target mongod.service
Wants=network-online.target
Requires=mongod.service

[Service]
Type=simple
User=bench
Group=bench
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $APP_DIR/server/server.js
Restart=on-failure
RestartSec=5

# --- sandboxing -------------------------------------------------------
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=yes
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
UMask=0077

# The only writable path. ProtectSystem=strict makes everything else,
# including $APP_DIR, read-only to this process.
StateDirectory=bench
ReadWritePaths=$STATE_DIR

[Install]
WantedBy=multi-user.target
EOF"

say "starting bench"
pct exec "$CTID" -- bash -lc '
set -euo pipefail
systemctl daemon-reload
systemctl enable --now bench >/dev/null 2>&1

for i in $(seq 1 30); do
  if curl -fsS -o /dev/null http://127.0.0.1:4000/api/projects 2>/dev/null; then
    echo "  bench is answering on 127.0.0.1:4000"
    exit 0
  fi
  sleep 2
done
echo "bench did not answer after 60s:"
systemctl status bench --no-pager -l | head -20
journalctl -u bench -n 40 --no-pager
exit 1
'

# ------------------------------------------------------------------ journald cap
# Parity with the Docker path, where the json-file driver is capped at 3x10MB.
say "capping journal size"
pct exec "$CTID" -- bash -lc '
set -euo pipefail
mkdir -p /etc/systemd/journald.conf.d
printf "[Journal]\nSystemMaxUse=200M\nSystemMaxFileSize=20M\n" > /etc/systemd/journald.conf.d/size.conf
systemctl restart systemd-journald
'

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
  then browse http://127.0.0.1:4000 on your own machine.
  See the README section \"Reaching it from a browser\" for Tailscale too."
fi

cat <<EOF

$(printf '\033[1;32m==> Bench is up in CT %s (native — no Docker)\033[0m' "$CTID")

  Container IP : ${CT_IP:-<check: pct exec $CTID -- hostname -I>}
$ACCESS
  MongoDB      : ${MONGO_VERSION}, bound to 127.0.0.1, authorization enabled

  ADMIN LOGIN
    username : admin
    password : $ADMIN_PW
    ^ change it from the Account tab, then this printout is worthless.

  Manage it:
    pct exec $CTID -- systemctl status bench
    pct exec $CTID -- journalctl -u bench -f
    pct exec $CTID -- systemctl restart bench

  Update it:
    pct exec $CTID -- bash -lc 'cd $APP_DIR && git pull \\
      && npm ci --omit=dev --ignore-scripts && npm run build \\
      && systemctl restart bench'

  Secrets live in $ENV_FILE (root-owned, mode 600).

EOF
