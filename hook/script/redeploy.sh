#!/usr/bin/env bash
# FeeRouteHook v2 redeploy. Default: DRY RUN on a local anvil fork as the Nandout deploy wallet (impersonated, no key).
# Mainnet only with HOOK_MAINNET_GO=yes, using DEPLOYER_PRIVATE_KEY from the repo's .env (never the attestor key).
set -euo pipefail
cd "$(dirname "$0")/.."
DEPLOYER=0x934d315C0a9C0866D393B722C1805F2B6b20b816
if [ "${HOOK_MAINNET_GO:-}" = "yes" ]; then
  set -a; . ../.env; set +a
  [ "$(cast wallet address "$DEPLOYER_PRIVATE_KEY")" = "$DEPLOYER" ] || { echo "key is not the Nandout deploy wallet"; exit 1; }
  DEPLOY_OUT=196-v2 forge script script/RedeployFeeRoute.s.sol --tc RedeployFeeRoute --rpc-url https://rpc.xlayer.tech \
    --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast --slow
  exit
fi
PORT=${PORT:-8551}; FORK="http://127.0.0.1:$PORT"
anvil --fork-url https://rpc.xlayer.tech --port "$PORT" --chain-id 196 --silent --gas-limit 300000000 &
ANVIL=$!; trap 'kill $ANVIL 2>/dev/null' EXIT
until cast chain-id --rpc-url "$FORK" >/dev/null 2>&1; do sleep 1; done
cast rpc anvil_impersonateAccount "$DEPLOYER" --rpc-url "$FORK" >/dev/null
DEPLOY_OUT=196-v2-dryrun forge script script/RedeployFeeRoute.s.sol --tc RedeployFeeRoute --rpc-url "$FORK" --sender "$DEPLOYER" --unlocked --broadcast --slow 2>&1 | grep -E "hook|Error|rror" | tail -3
node -e 'const r=require("./broadcast/RedeployFeeRoute.s.sol/196/run-latest.json");const rc=r.receipts[0];console.log("gas",parseInt(rc.gasUsed),"status",parseInt(rc.status),"OKB at 0.02 gwei",parseInt(rc.gasUsed)*20000001/1e18)'
