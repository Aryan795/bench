#!/usr/bin/env bash
# One-shot content update for the Nova redesign, August 2026.
#
# Re-domains the twelve live projects into the expanded category set
# (sh = Smart Home, net = Networking, 3d = 3D Printing), corrects the
# smart-switches year to 2023 (per CV: Aug 2023 – Jul 2025), and sets
# each project's free-form tag list (IoT, ESPHome, Proxmox, ...).
#
# RUN THIS ONLY AFTER THE REDESIGNED SERVER IS DEPLOYED. The old server
# validates domains against {sw, hw, ml} and silently rewrites anything
# else to "sw".
#
# Usage:
#   BENCH_URL=https://bench.homelabweb.space BENCH_USER=admin ./recategorize-2026-08.sh
# Prompts for the password (never passed on the command line, never echoed).
set -euo pipefail

BENCH_URL="${BENCH_URL:-http://127.0.0.1:4000}"
BENCH_USER="${BENCH_USER:-admin}"
if [ -z "${BENCH_PASS:-}" ]; then read -rsp "Bench password for $BENCH_USER: " BENCH_PASS; echo; fi

# slug<TAB>domain<TAB>year<TAB>tags  (year "-" = keep as stored)
MAPPING='openwrt-dns-everything-that-broke	net	-	OpenWrt,Raspberry Pi,DNS,AdGuard Home,Firewall,IPv6
bench	sw	-	Node.js,Express,MongoDB,Docker,Self-hosted
servearr	sw	-	Docker,Jellyfin,Automation,TrueNAS,NFS,Media
mirror	sh	-	IoT,ESP8266,MagicMirror,WLED,Two-way glass
wall-tablet	sh	-	IoT,Android,Fully Kiosk,Motion sensing,LineageOS
smart-switches	sh	2023	IoT,ESP32,ESPHome,Relays,Node-RED,Electronics
smart-blinds	3d	-	IoT,ESPHome,3D printing,Stepper motor,C++
home-assistant	sh	-	IoT,Raspberry Pi,Automations,MQTT,ESPHome
home-server	sw	-	Proxmox,TrueNAS,RAIDZ1,NFS,Virtualization,Homelab
ir-blaster	sh	-	IoT,ESP8266,Infrared,ESPHome,3D printing
ambilight	hw	-	IoT,HyperHDR,Raspberry Pi,LEDs,HDMI capture
f22	hw	-	RC,Depron,Aeromodelling,Electronics'

JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

echo "→ logging in to $BENCH_URL"
printf '%s' "$BENCH_PASS" | python3 -c 'import sys,json;
print(json.dumps({"username":sys.argv[1],"password":sys.stdin.read()}))' "$BENCH_USER" \
| curl -fsS -c "$JAR" -H 'Content-Type: application/json' --data-binary @- \
       "$BENCH_URL/api/auth/login" >/dev/null
echo "  ok"

ALL="$(curl -fsS -b "$JAR" "$BENCH_URL/api/admin/projects")"

printf '%s\n' "$MAPPING" | while IFS="$(printf '\t')" read -r slug domain year tags; do
  [ -n "$slug" ] || continue
  DOC="$(printf '%s' "$ALL" | python3 -c '
import sys, json
slug, domain, year, tags = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
rows = json.load(sys.stdin)
row = next((r for r in rows if r.get("slug") == slug), None)
if row is None:
    sys.exit(2)
row["domain"] = domain
if year != "-":
    row["year"] = int(year)
if tags:
    row["tags"] = [t.strip() for t in tags.split(",") if t.strip()]
row.pop("bodyHtml", None)   # derived; the server re-renders from bodyMd
print(json.dumps({"id": row["id"], "body": row}))
' "$slug" "$domain" "$year" "$tags" || true)"
  if [ -z "$DOC" ]; then echo "  !! $slug not found on the server, skipped"; continue; fi
  ID="$(printf '%s' "$DOC" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')"
  printf '%s' "$DOC" | python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin)["body"]))' \
  | curl -fsS -b "$JAR" -X PUT -H 'Content-Type: application/json' --data-binary @- \
         "$BENCH_URL/api/admin/projects/$ID" >/dev/null
  echo "  ✓ $slug → $domain$( [ "$year" != "-" ] && printf ', year %s' "$year" ), tags: $tags"
done

echo "done — verify at $BENCH_URL/#/projects"
