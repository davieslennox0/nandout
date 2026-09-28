#!/usr/bin/env bash
# Pulls the web bundle built by GitHub Actions (release `web-latest`) and runs it here under pm2.
# Idempotent: does nothing if the published revision is already live. Safe to run from cron.
#   REPO=owner/nandout deploy/pull-web.sh
set -euo pipefail

REPO="${REPO:?set REPO=owner/name}"
BASE="${BASE:-/srv/nandout}"
PORT="${PORT:-8440}"
KEEP="${KEEP:-3}"
export PATH="/root/.local/share/fnm/node-versions/v22.23.1/installation/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

mkdir -p "$BASE/releases"
exec 9>"$BASE/.lock"
flock -n 9 || exit 0 # another run in progress

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

gh release download web-latest --repo "$REPO" --pattern nandout-web.sha --dir "$tmp" --clobber
rev=$(tr -d '[:space:]' < "$tmp/nandout-web.sha")
[ -n "$rev" ] || { echo "empty revision"; exit 1; }
current=$(cat "$BASE/current/REVISION" 2>/dev/null || true)
if [ "$rev" = "$current" ] && pm2 describe nandout-web >/dev/null 2>&1; then
  exit 0
fi

echo "$(date -Is) deploying $rev (was ${current:-none})"
gh release download web-latest --repo "$REPO" --pattern nandout-web.tar.gz --dir "$tmp" --clobber
dest="$BASE/releases/$rev"
rm -rf "$dest" && mkdir -p "$dest"
tar -xzf "$tmp/nandout-web.tar.gz" -C "$dest"
[ -f "$dest/web/server.js" ] || { echo "bundle has no web/server.js"; exit 1; }

ln -sfn "$dest" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"

# Zero-downtime switch: deploy/serve.cjs (stable path) loads whatever `current` points to. In cluster mode `pm2 reload`
# brings up a worker on the new release and waits for it to listen before stopping the old one.
ENTRY="$(cd "$(dirname "$0")" && pwd)/serve.cjs"
if pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const p=JSON.parse(s).find(p=>p.name==="nandout-web");process.exit(p&&p.pm2_env.exec_mode==="cluster_mode"&&p.pm2_env.pm_exec_path===process.argv[1]?0:1)})' "$ENTRY"; then
  PORT="$PORT" HOSTNAME=127.0.0.1 NODE_ENV=production pm2 reload nandout-web --update-env >/dev/null
else
  pm2 delete nandout-web >/dev/null 2>&1 || true
  PORT="$PORT" HOSTNAME=127.0.0.1 NODE_ENV=production \
    pm2 start "$ENTRY" --name nandout-web -i 1 --max-memory-restart 300M >/dev/null
fi
pm2 save >/dev/null

# prune old releases, never the live one
ls -1dt "$BASE"/releases/* | grep -v "/$rev$" | tail -n +"$KEEP" | xargs -r rm -rf
echo "$(date -Is) live: $rev"
