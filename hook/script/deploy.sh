#!/usr/bin/env bash
# FeeRouteHook deploy. Default: DRY RUN on a local anvil fork of X Layer as the Nandout deploy wallet (impersonated, no key).
# Mainnet only with HOOK_MAINNET_GO=yes, using DEPLOYER_PRIVATE_KEY from the repo's .env (never the attestor key).
set -euo pipefail
cd "$(dirname "$0")/.."
DEPLOYER=0x934d315C0a9C0866D393B722C1805F2B6b20b816
if [ "${HOOK_MAINNET_GO:-}" = "yes" ]; then
  set -a; . ../.env; set +a
  [ "$(cast wallet address "$DEPLOYER_PRIVATE_KEY")" = "$DEPLOYER" ] || { echo "key is not the Nandout deploy wallet"; exit 1; }
  DEPLOY_OUT=196 forge script script/DeployFeeRoute.s.sol --tc DeployFeeRoute --rpc-url https://rpc.xlayer.tech \
    --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast --slow
  exit
fi
PORT=${PORT:-8550}; FORK="http://127.0.0.1:$PORT"
anvil --fork-url https://rpc.xlayer.tech --port "$PORT" --chain-id 196 --silent --gas-limit 300000000 &
ANVIL=$!; trap 'kill $ANVIL 2>/dev/null' EXIT
until cast chain-id --rpc-url "$FORK" >/dev/null 2>&1; do sleep 1; done
REAL=$(cast balance "$DEPLOYER" --rpc-url "$FORK")
cast rpc anvil_setBalance "$DEPLOYER" 0xDE0B6B3A7640000 --rpc-url "$FORK" >/dev/null # fork only: 1 OKB of headroom to measure the full cost
BAL0=$(cast balance "$DEPLOYER" --rpc-url "$FORK")
cast rpc anvil_impersonateAccount "$DEPLOYER" --rpc-url "$FORK" >/dev/null
DEPLOY_OUT=196-dryrun forge script script/DeployFeeRoute.s.sol --tc DeployFeeRoute --rpc-url "$FORK" --sender "$DEPLOYER" --unlocked --broadcast --slow -vvv > dryrun.log 2>&1 || { grep -E "Revert|revert|\[Revert\]|Error|←" dryrun.log | tail -25; exit 1; }
BAL1=$(cast balance "$DEPLOYER" --rpc-url "$FORK")
node - "$BAL0" "$BAL1" "$REAL" <<'JS'
const r = require('./broadcast/DeployFeeRoute.s.sol/196/run-latest.json');
const [b0, b1, real] = process.argv.slice(2).map(BigInt);
let gas = 0n, val = 0n;
const rows = r.transactions.map((t, i) => {
  const rc = r.receipts[i]; const g = BigInt(rc.gasUsed); const p = BigInt(rc.effectiveGasPrice); const v = BigInt(t.transaction.value || '0x0');
  gas += g * p; val += v;
  return { tx: (t.function || t.contractName || 'create2 deploy').split('(')[0], gasUsed: Number(g), gasPriceWei: Number(p), gasOKB: Number(g * p) / 1e18, valueOKB: Number(v) / 1e18 };
});
console.table(rows);
console.log('gas OKB', Number(gas) / 1e18, '| value OKB', Number(val) / 1e18, '| total OKB', Number(gas + val) / 1e18, '| balance change', Number(b0 - b1) / 1e18, '| wallet holds now', Number(real) / 1e18);
JS
cat deployments/196-dryrun.json | head -12
