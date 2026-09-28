#!/usr/bin/env bash
# Backs up the attestor's durable state (launch registry, transfer index, LP peaks) to release assets on the PRIVATE
# repo davieslennox0/nandout-state. Rolling asset "state-latest", plus one dated snapshot per day, keeping the last 7.
# Contains only public chain/API data; no keys. Restore: gh release download state-latest -R davieslennox0/nandout-state
set -euo pipefail
export PATH="/root/.local/share/fnm/node-versions/v22.23.1/installation/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
REPO=davieslennox0/nandout-state
SRC=/root/latch/attestor/state
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
# Consistent copy: don't race the attestor cycle writing these files.
exec 9>/tmp/nandout-attestor.lock; flock -w 600 9
tar -C "$SRC" -czf "$TMP/state.tgz" registry.json index.json lp.json
flock -u 9
DAY=$(date -u +%F)
gh release view state-latest -R "$REPO" >/dev/null 2>&1 || gh release create state-latest -R "$REPO" -t "latest state" -n "rolling" >/dev/null
gh release upload state-latest "$TMP/state.tgz#state.tgz" -R "$REPO" --clobber
if ! gh release view "state-$DAY" -R "$REPO" >/dev/null 2>&1; then
  gh release create "state-$DAY" "$TMP/state.tgz" -R "$REPO" -t "state $DAY" -n "daily snapshot" >/dev/null
fi
gh release list -R "$REPO" --limit 100 --json tagName -q '.[].tagName' | grep '^state-20' | sort -r | tail -n +8 | while read -r t; do gh release delete "$t" -R "$REPO" -y --cleanup-tag; done
echo "$(date -u +%FT%TZ) backed up $(du -h "$TMP/state.tgz" | cut -f1)"
