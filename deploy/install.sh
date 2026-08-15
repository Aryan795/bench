#!/usr/bin/env bash
#
# install.sh — one-command Proxmox installer for Bench.
#
# Run this ON THE PROXMOX HOST, as root:
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Aryan795/bench/main/deploy/install.sh)"
#
# Use that exact form — NOT `curl ... | bash`. Piping puts the script itself on
# stdin, which leaves whiptail nothing to read your keystrokes from, so the
# menus either never appear or instantly take the default. `bash -c "$(...)"`
# passes the script as an argument, leaving stdin attached to your terminal.
#
# What it does: asks for the handful of settings it needs, downloads the repo,
# and hands off to deploy/bench-lxc-native.sh or deploy/bench-lxc.sh — those two
# do the real work and are perfectly usable on their own. This is a front end,
# not a reimplementation.
#
# Unattended runs: every prompt has an environment variable behind it, and with
# no TTY the menus are skipped entirely, so this works from cron or Ansible:
#
#   INSTALL_TYPE=native CTID=922 DISK_GB=6 RAM_MB=1024 BIND=lan \
#     bash -c "$(curl -fsSL .../install.sh)"
#
set -euo pipefail

REPO_OWNER="${REPO_OWNER:-Aryan795}"
REPO_NAME="${REPO_NAME:-bench}"
REPO_BRANCH="${REPO_BRANCH:-main}"
TARBALL_URL="https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/tar.gz/refs/heads/${REPO_BRANCH}"

# ------------------------------------------------------------------ output
YW="\033[33m"; GN="\033[1;92m"; RD="\033[01;31m"; BL="\033[36m"; DIM="\033[2m"; CL="\033[m"
CM="${GN}✓${CL}"; CROSS="${RD}✗${CL}"; INFO="${BL}i${CL}"

SPINNER_PID=""
SPINNER_MSG=""

spinner() {
  local frames=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏) i=0
  while true; do
    printf "\r ${YW}%s${CL} %s" "${frames[i]}" "$SPINNER_MSG"
    i=$(( (i + 1) % ${#frames[@]} ))
    sleep 0.1
  done
}

stop_spinner() {
  if [ -n "$SPINNER_PID" ] && kill -0 "$SPINNER_PID" 2>/dev/null; then
    kill "$SPINNER_PID" 2>/dev/null || true
    wait "$SPINNER_PID" 2>/dev/null || true
  fi
  SPINNER_PID=""
}

msg_info() {
  SPINNER_MSG="$1"
  if [ -t 1 ]; then
    spinner &
    SPINNER_PID=$!
  else
    printf " %s\n" "$SPINNER_MSG"
  fi
}

msg_ok()   { stop_spinner; printf "\r\033[K ${CM} %s\n" "$1"; }
msg_warn() { stop_spinner; printf "\r\033[K ${YW}!${CL} %s\n" "$1"; }
msg_note() { stop_spinner; printf "\r\033[K ${INFO} %s\n" "$1"; }
msg_err()  { stop_spinner; printf "\r\033[K ${CROSS} %s\n" "$1" >&2; }
die()      { msg_err "$1"; exit 1; }

TMPDIR_SELF=""
cleanup() {
  local rc=$?
  stop_spinner
  [ -n "$TMPDIR_SELF" ] && rm -rf "$TMPDIR_SELF"
  # Leave the cursor visible and the line clean however we exit.
  printf "\033[?25h"
  exit "$rc"
}
trap cleanup EXIT INT TERM

header_info() {
  clear 2>/dev/null || true
  printf "${BL}"
  cat <<'ASCII'
    ____                  __
   / __ )___  ____  _____/ /_
  / __  / _ \/ __ \/ ___/ __ \
 / /_/ /  __/ / / / /__/ / / /
/_____/\___/_/ /_/\___/_/ /_/
ASCII
  printf "${CL}${DIM}   projects and writing, in a Proxmox LXC${CL}\n\n"
}

# ------------------------------------------------------------------ preflight
header_info

[ "$(id -u)" -eq 0 ] || die "must run as root on the Proxmox host."
command -v pct   >/dev/null || die "pct not found — run this on a Proxmox VE host, not inside a container."
command -v pvesh >/dev/null || die "pvesh not found — run this on a Proxmox VE host."
command -v curl  >/dev/null || die "curl not found — apt-get install -y curl"

# No TTY (cron, Ansible, a pipe) means no menus. Fall through on defaults plus
# whatever the environment overrides, rather than blocking on a prompt nobody
# can answer.
INTERACTIVE=1
if [ ! -t 0 ] || ! command -v whiptail >/dev/null 2>&1; then
  INTERACTIVE=0
fi

HOST_ARCH="$(dpkg --print-architecture 2>/dev/null || echo unknown)"
HAS_AVX=0
grep -qm1 avx /proc/cpuinfo 2>/dev/null && HAS_AVX=1

# ------------------------------------------------------------------ defaults
INSTALL_TYPE="${INSTALL_TYPE:-}"
CTID="${CTID:-}"
CT_HOSTNAME="${CT_HOSTNAME:-bench}"
STORAGE="${STORAGE:-}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-}"
BRIDGE="${BRIDGE:-vmbr0}"
DISK_GB="${DISK_GB:-}"
RAM_MB="${RAM_MB:-1024}"
CORES="${CORES:-2}"
BRIDGE_IP="${BRIDGE_IP:-dhcp}"
GATEWAY="${GATEWAY:-}"
BIND="${BIND:-loopback}"

# ------------------------------------------------------------------ helpers
# Ask whiptail for a value; fall back to the default when non-interactive or
# when the user cancels out of that single box.
ask_input() {
  local title="$1" prompt="$2" default="$3" out
  if [ "$INTERACTIVE" -eq 0 ]; then printf '%s' "$default"; return; fi
  out="$(whiptail --backtitle "Bench installer" --title "$title" \
        --inputbox "$prompt" 10 68 "$default" 3>&1 1>&2 2>&3)" || out="$default"
  [ -n "$out" ] || out="$default"
  printf '%s' "$out"
}

# List storages that can hold a given content type. Auto-picks when there is
# only one, which is the common single-node case (local-lvm / local).
pick_storage() {
  local content="$1" title="$2" preset="$3"
  local -a menu=()
  local name type status total used avail rest

  if [ -n "$preset" ]; then printf '%s' "$preset"; return; fi

  while read -r name type status total used avail rest; do
    [ -n "$name" ] || continue
    menu+=("$name" "$type, $(( avail / 1024 / 1024 ))G free")
  done < <(pvesm status --content "$content" 2>/dev/null | awk 'NR>1')

  if [ "${#menu[@]}" -eq 0 ]; then
    die "no storage on this node accepts '$content' content. Check: pvesm status --content $content"
  fi
  if [ "${#menu[@]}" -eq 2 ] || [ "$INTERACTIVE" -eq 0 ]; then
    printf '%s' "${menu[0]}"
    return
  fi
  whiptail --backtitle "Bench installer" --title "$title" \
    --menu "Where should this live?" 16 68 6 "${menu[@]}" 3>&1 1>&2 2>&3
}

# ------------------------------------------------------------------ install type
#
# Decided first because it changes the disk default, whether the container gets
# nesting/keyctl, and whether this host can run the native path at all.
NATIVE_OK=1
NATIVE_BLOCKER=""
if [ "$HAS_AVX" -eq 0 ]; then
  NATIVE_OK=0
  NATIVE_BLOCKER="this CPU reports no AVX, and MongoDB 5.0+ requires it"
elif [ "$HOST_ARCH" != "amd64" ]; then
  NATIVE_OK=0
  NATIVE_BLOCKER="MongoDB publishes its Debian server package for amd64 only (this host is $HOST_ARCH)"
fi

if [ -z "$INSTALL_TYPE" ]; then
  if [ "$INTERACTIVE" -eq 0 ]; then
    INSTALL_TYPE=$([ "$NATIVE_OK" -eq 1 ] && echo native || echo docker)
  else
    NATIVE_LABEL="No Docker — systemd + MongoDB in the LXC (~2.5G)"
    [ "$NATIVE_OK" -eq 0 ] && NATIVE_LABEL="UNAVAILABLE — $NATIVE_BLOCKER"
    INSTALL_TYPE="$(whiptail --backtitle "Bench installer" --title "Install type" \
      --menu "How should Bench run inside the container?" 16 74 2 \
      "native" "$NATIVE_LABEL" \
      "docker" "Docker + compose in the LXC (~3.8G, needs nesting)" \
      3>&1 1>&2 2>&3)" || exit 1
  fi
fi

if [ "$INSTALL_TYPE" = "native" ] && [ "$NATIVE_OK" -eq 0 ]; then
  msg_warn "Native path is not viable here: $NATIVE_BLOCKER."
  if [ "$INTERACTIVE" -eq 1 ] && whiptail --backtitle "Bench installer" --title "Switch to Docker?" \
      --yesno "The native path cannot work on this host:\n\n  $NATIVE_BLOCKER\n\nThe Docker path handles this (the mongo:4.4 image ships its own userland, and the official images cover arm64).\n\nSwitch to Docker?" 15 74; then
    INSTALL_TYPE="docker"
    msg_ok "Switched to the Docker path"
  else
    die "refusing to build a container whose database would crash-loop. Re-run with INSTALL_TYPE=docker."
  fi
fi

# Disk default depends on the path — native carries no image layers.
[ -n "$DISK_GB" ] || DISK_GB=$([ "$INSTALL_TYPE" = "native" ] && echo 6 || echo 8)

# ------------------------------------------------------------------ settings
if [ "$INTERACTIVE" -eq 1 ]; then
  CHOICE="$(whiptail --backtitle "Bench installer" --title "Settings" \
    --menu "Bench — $INSTALL_TYPE install on this Proxmox node" 14 68 3 \
    "default"  "Sensible defaults, one confirmation" \
    "advanced" "Choose CTID, disk, RAM, network, binding" \
    "exit"     "Change nothing and quit" \
    3>&1 1>&2 2>&3)" || CHOICE="exit"
  [ "$CHOICE" = "exit" ] && { msg_note "Nothing was created."; exit 0; }
else
  CHOICE="default"
fi

[ -n "$CTID" ] || CTID="$(pvesh get /cluster/nextid)"
STORAGE="$(pick_storage rootdir "Container storage" "$STORAGE")"
[ -n "$STORAGE" ] || die "no container storage selected."
TEMPLATE_STORAGE="$(pick_storage vztmpl "Template storage" "$TEMPLATE_STORAGE")"
[ -n "$TEMPLATE_STORAGE" ] || die "no template storage selected."

if [ "$CHOICE" = "advanced" ]; then
  CTID="$(ask_input      "Container ID"  "Numeric CTID for the new container:"        "$CTID")"
  CT_HOSTNAME="$(ask_input  "Hostname"      "Hostname inside the container:"             "$CT_HOSTNAME")"
  CORES="$(ask_input     "CPU cores"     "How many cores?"                            "$CORES")"
  RAM_MB="$(ask_input    "Memory"        "RAM in MB (Bench idles around 155-275MB):"  "$RAM_MB")"
  DISK_GB="$(ask_input   "Disk"          "Root disk in GB:"                           "$DISK_GB")"
  BRIDGE="$(ask_input    "Bridge"        "Network bridge:"                            "$BRIDGE")"

  if whiptail --backtitle "Bench installer" --title "Network" \
       --yesno "Use DHCP for the container's address?" 8 60; then
    BRIDGE_IP="dhcp"
  else
    BRIDGE_IP="$(ask_input "Static IP" "Address in CIDR form, e.g. 192.168.1.61/24:" "192.168.1.61/24")"
    GATEWAY="$(ask_input   "Gateway"   "Default gateway:"                             "192.168.1.1")"
  fi

  # Loopback stays the default on purpose. Anything else is a deliberate,
  # explicit choice — an installer should not quietly put a login page on
  # your LAN because that made the success message prettier.
  BIND="$(whiptail --backtitle "Bench installer" --title "Who can reach it" \
    --menu "Bench binds this address inside the container:" 15 74 2 \
    "loopback" "127.0.0.1 — reach it over an SSH tunnel (safest)" \
    "lan"      "0.0.0.0 — anyone on your LAN can open it" \
    3>&1 1>&2 2>&3)" || BIND="loopback"
fi

[ "$BRIDGE_IP" = "dhcp" ] || [ -n "$GATEWAY" ] || die "static BRIDGE_IP needs a GATEWAY."
pct status "$CTID" >/dev/null 2>&1 && die "CTID $CTID already exists — pick another."

# ------------------------------------------------------------------ confirm
BIND_DESC=$([ "$BIND" = "lan" ] && echo "0.0.0.0 (reachable on your LAN)" || echo "127.0.0.1 (SSH tunnel only)")
if [ "$INTERACTIVE" -eq 1 ]; then
  whiptail --backtitle "Bench installer" --title "Ready" --yesno \
"Create this container?

  Type      : $INSTALL_TYPE
  CTID      : $CTID   Hostname: $CT_HOSTNAME
  Resources : ${CORES} cores, ${RAM_MB}MB RAM, ${DISK_GB}G disk
  Storage   : $STORAGE   (template: $TEMPLATE_STORAGE)
  Network   : $BRIDGE, $BRIDGE_IP
  Listens on: $BIND_DESC

This downloads packages and takes a few minutes." 19 74 || { msg_note "Nothing was created."; exit 0; }
fi

header_info
printf " ${DIM}CT %s · %s · %s cores · %sMB · %sG · %s${CL}\n\n" \
  "$CTID" "$INSTALL_TYPE" "$CORES" "$RAM_MB" "$DISK_GB" "$STORAGE"

# ------------------------------------------------------------------ fetch repo
# Tarball rather than `git clone`: Proxmox does not ship git by default, and
# there is no reason to make people apt-get it just to read three scripts.
TMPDIR_SELF="$(mktemp -d /tmp/bench-install-XXXXXX)"
msg_info "Downloading ${REPO_OWNER}/${REPO_NAME} (${REPO_BRANCH})"
if ! curl -fsSL "$TARBALL_URL" -o "$TMPDIR_SELF/src.tar.gz"; then
  die "could not download $TARBALL_URL — check the host's internet access."
fi
tar -xzf "$TMPDIR_SELF/src.tar.gz" -C "$TMPDIR_SELF"
BENCH_SRC="$(find "$TMPDIR_SELF" -maxdepth 1 -mindepth 1 -type d | head -1)"
[ -f "$BENCH_SRC/package.json" ] || die "downloaded archive does not look like the Bench repo."
msg_ok "Downloaded ${REPO_OWNER}/${REPO_NAME} (${REPO_BRANCH})"

if [ "$INSTALL_TYPE" = "native" ]; then
  DELEGATE="$BENCH_SRC/deploy/bench-lxc-native.sh"
else
  DELEGATE="$BENCH_SRC/deploy/bench-lxc.sh"
fi
[ -f "$DELEGATE" ] || die "$(basename "$DELEGATE") missing from the archive."
chmod +x "$DELEGATE"

# ------------------------------------------------------------------ hand off
#
# From here the delegate script owns the terminal. Its output is deliberately
# left visible rather than swallowed behind a spinner: this stage installs
# packages over the network, and when that fails you want the apt error, not a
# spinner that stopped moving.
msg_note "Handing off to $(basename "$DELEGATE") — this is the slow part"
printf "\n"

export CTID CT_HOSTNAME STORAGE TEMPLATE_STORAGE BRIDGE DISK_GB RAM_MB CORES
export BRIDGE_IP GATEWAY BIND BENCH_SRC

"$DELEGATE"
