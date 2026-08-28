#!/usr/bin/env bash
# One-shot content update for the Nova redesign, August 2026.
#
# Re-domains the twelve live projects into the expanded category set
# (sh = Smart Home, net = Networking, 3d = 3D Printing) and corrects the
# smart-switches year to 2023 (per CV: Aug 2023 – Jul 2025).
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

# slug<TAB>domain<TAB>year  (year "-" = keep as stored)
MAPPING='openwrt-dns-everything-that-broke	net	-
bench	sw	-
servearr	sw	-
mirror	sh	-
wall-tablet	sh	-
smart-switches	sh	2023
smart-blinds	3d	-
home-assistant	sh	-
home-server	sw	-
ir-blaster	sh	-
ambilight	hw	-
f22	hw	-'

JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

echo "→ logging in to $BENCH_URL"
printf '%s' "$BENCH_PASS" | python3 -c 'import sys,json;
print(json.dumps({"username":sys.argv[1],"password":sys.stdin.read()}))' "$BENCH_USER" \
| curl -fsS -c "$JAR" -H 'Content-Type: application/json' --data-binary @- \
       "$BENCH_URL/api/auth/login" >/dev/null
echo "  ok"

ALL="$(curl -fsS -b "$JAR" "$BENCH_URL/api/admin/projects")"

printf '%s\n' "$MAPPING" | while IFS="$(printf '\t')" read -r slug domain year; do
  [ -n "$slug" ] || continue
  DOC="$(printf '%s' "$ALL" | python3 -c '
import sys, json
slug, domain, year = sys.argv[1], sys.argv[2], sys.argv[3]
rows = json.load(sys.stdin)
row = next((r for r in rows if r.get("slug") == slug), None)
if row is None:
    sys.exit(2)
row["domain"] = domain
if year != "-":
    row["year"] = int(year)
row.pop("bodyHtml", None)   # derived; the server re-renders from bodyMd
print(json.dumps({"id": row["id"], "body": row}))
' "$slug" "$domain" "$year" || true)"
  if [ -z "$DOC" ]; then echo "  !! $slug not found on the server, skipped"; continue; fi
  ID="$(printf '%s' "$DOC" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')"
  printf '%s' "$DOC" | python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin)["body"]))' \
  | curl -fsS -b "$JAR" -X PUT -H 'Content-Type: application/json' --data-binary @- \
         "$BENCH_URL/api/admin/projects/$ID" >/dev/null
  echo "  ✓ $slug → $domain$( [ "$year" != "-" ] && printf ', year %s' "$year" )"
done

echo "done — verify at $BENCH_URL/#/projects"
