#!/usr/bin/env bash
# One attestor cycle against X Layer mainnet (cron, every 10 min). Keys come from /root/latch/.env (gitignored).
set -euo pipefail
ROOT=/root/latch
export PATH="/root/.local/share/fnm/node-versions/v22.23.1/installation/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
exec 9>/tmp/nandout-attestor.lock
flock -n 9 || { echo "$(date -Is) previous cycle still running"; exit 0; }
set -a; . "$ROOT/.env"; set +a
cd "$ROOT/attestor"
echo "$(date -Is) cycle start"
node --max-old-space-size=700 --import tsx src/cli.ts --feed-rpc "$XLAYER_RPC_URL" --deployment "$ROOT/contracts/deployments/196.json" \
  > logs/last-summary.json
cp "$(ls -1t logs/cycle-*.json | head -1)" logs/cycle-latest.json
ls -1t logs/cycle-2*.json | tail -n +7 | xargs -r rm -f # keep the last 6 cycles
echo "$(date -Is) cycle done"
