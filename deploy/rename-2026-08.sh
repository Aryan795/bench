#!/usr/bin/env bash
# Renames six project display titles (chosen by Aryan, 29 Aug 2026).
# Slugs and URLs are untouched — routes, plates, covers and the other
# deploy scripts keep working. Order-independent of the other two
# scripts; run it in the same session for one review pass.
#
# Special case: openwrt-dns-everything-that-broke used its long editorial
# sentence AS its title, with an empty headline. The sentence moves into
# `headline` so cards keep it, and the title becomes "Pi Router".
#
# Usage:
#   BENCH_URL=https://bench.homelabweb.space BENCH_USER=admin ./rename-2026-08.sh
set -euo pipefail

BENCH_URL="${BENCH_URL:-http://127.0.0.1:4000}"
BENCH_USER="${BENCH_USER:-admin}"
if [ -z "${BENCH_PASS:-}" ]; then read -rsp "Bench password for $BENCH_USER: " BENCH_PASS; echo; fi

# slug<TAB>new title
MAPPING='openwrt-dns-everything-that-broke	Pi Router
mirror	Looking Glass
wall-tablet	Smart Home Dashboard
ir-blaster	Universal Remote
ambilight	TV Halo
f22	RC F22 Raptor'

JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

echo "→ logging in to $BENCH_URL"
printf '%s' "$BENCH_PASS" | python3 -c 'import sys,json;
print(json.dumps({"username":sys.argv[1],"password":sys.stdin.read()}))' "$BENCH_USER" \
| curl -fsS -c "$JAR" -H 'Content-Type: application/json' --data-binary @- \
       "$BENCH_URL/api/auth/login" >/dev/null
echo "  ok"

ALL="$(curl -fsS -b "$JAR" "$BENCH_URL/api/admin/projects")"

printf '%s\n' "$MAPPING" | while IFS="$(printf '\t')" read -r slug title; do
  [ -n "$slug" ] || continue
  DOC="$(printf '%s' "$ALL" | python3 -c '
import sys, json
slug, title = sys.argv[1], sys.argv[2]
rows = json.load(sys.stdin)
row = next((r for r in rows if r.get("slug") == slug), None)
if row is None:
    sys.exit(2)
# keep the old editorial sentence on the card if no headline exists
if not (row.get("headline") or "").strip():
    row["headline"] = row["title"]
row["title"] = title
row.pop("bodyHtml", None)   # derived; the server re-renders from bodyMd
print(json.dumps({"id": row["id"], "body": row}))
' "$slug" "$title" || true)"
  if [ -z "$DOC" ]; then echo "  !! $slug not found on the server, skipped"; continue; fi
  ID="$(printf '%s' "$DOC" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')"
  printf '%s' "$DOC" | python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin)["body"]))' \
  | curl -fsS -b "$JAR" -X PUT -H 'Content-Type: application/json' --data-binary @- \
         "$BENCH_URL/api/admin/projects/$ID" >/dev/null
  echo "  ✓ $slug → \"$title\""
done

echo "done — verify at $BENCH_URL/#/projects"
