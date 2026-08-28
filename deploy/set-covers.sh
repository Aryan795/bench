#!/usr/bin/env bash
# Uploads the generated project covers and attaches each one to its project.
#
# The images live in deploy/covers/<slug>.png (Antigravity-generated, flat
# technical-illustration style, one accent colour per domain). A cover set on
# a project replaces its SVG plate on cards and hero figures automatically.
#
# Run order for the Nova redesign rollout:
#   1. deploy the new build          (git pull && docker compose up -d --build)
#   2. deploy/recategorize-2026-08.sh
#   3. this script
#
# Usage:
#   BENCH_URL=https://bench.homelabweb.space BENCH_USER=admin ./set-covers.sh
# Prompts for the password (never passed on the command line, never echoed).
# COVERS_DIR overrides the image directory (default: deploy/covers).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COVERS_DIR="${COVERS_DIR:-$HERE/covers}"
BENCH_URL="${BENCH_URL:-http://127.0.0.1:4000}"
BENCH_USER="${BENCH_USER:-admin}"
if [ -z "${BENCH_PASS:-}" ]; then read -rsp "Bench password for $BENCH_USER: " BENCH_PASS; echo; fi

SLUGS='openwrt-dns-everything-that-broke bench servearr mirror wall-tablet
smart-switches smart-blinds home-assistant home-server ir-blaster ambilight f22'

JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

echo "→ logging in to $BENCH_URL"
printf '%s' "$BENCH_PASS" | python3 -c 'import sys,json;
print(json.dumps({"username":sys.argv[1],"password":sys.stdin.read()}))' "$BENCH_USER" \
| curl -fsS -c "$JAR" -H 'Content-Type: application/json' --data-binary @- \
       "$BENCH_URL/api/auth/login" >/dev/null
echo "  ok"

ALL="$(curl -fsS -b "$JAR" "$BENCH_URL/api/admin/projects")"

for slug in $SLUGS; do
  f="$COVERS_DIR/$slug.png"
  if [ ! -f "$f" ]; then echo "  !! $f missing, skipped"; continue; fi

  url="$(curl -fsS -b "$JAR" -F "image=@$f;type=image/png" "$BENCH_URL/api/admin/upload" \
         | python3 -c 'import sys,json; print(json.load(sys.stdin)["url"])')"

  DOC="$(printf '%s' "$ALL" | python3 -c '
import sys, json
slug, cover = sys.argv[1], sys.argv[2]
rows = json.load(sys.stdin)
row = next((r for r in rows if r.get("slug") == slug), None)
if row is None:
    sys.exit(2)
row["cover"] = cover
row.pop("bodyHtml", None)   # derived; the server re-renders from bodyMd
print(json.dumps({"id": row["id"], "body": row}))
' "$slug" "$url" || true)"
  if [ -z "$DOC" ]; then echo "  !! $slug not found on the server, skipped"; continue; fi

  ID="$(printf '%s' "$DOC" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')"
  printf '%s' "$DOC" | python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin)["body"]))' \
  | curl -fsS -b "$JAR" -X PUT -H 'Content-Type: application/json' --data-binary @- \
         "$BENCH_URL/api/admin/projects/$ID" >/dev/null
  echo "  ✓ $slug ← $url"
done

echo "done — verify at $BENCH_URL/#/projects, then check for orphaned uploads"
