#!/usr/bin/env bash
# Per-swap gas from real transaction receipts on a LOCAL anvil fork of X Layer mainnet. Nothing touches mainnet:
# the script only ever broadcasts to 127.0.0.1, with the throwaway HOOK_FORK_KEY from hook/.env (gitignored).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
: "${HOOK_FORK_KEY:?set HOOK_FORK_KEY in hook/.env}"
PORT=${PORT:-8549}; FORK="http://127.0.0.1:$PORT"
anvil --fork-url "${XLAYER_RPC_URL:-https://rpc.xlayer.tech}" --port "$PORT" --chain-id 196 --silent --gas-limit 300000000 &
ANVIL=$!; trap 'kill $ANVIL 2>/dev/null' EXIT
until cast chain-id --rpc-url "$FORK" >/dev/null 2>&1; do sleep 1; done
ADDR=$(cast wallet address "$HOOK_FORK_KEY")
cast rpc anvil_setBalance "$ADDR" 0x56BC75E2D63100000 --rpc-url "$FORK" >/dev/null
FORK_BLOCK=$(cast block-number --rpc-url "$FORK")
forge script script/GasReport.s.sol --tc GasReport --fork-url "$FORK" --private-key "$HOOK_FORK_KEY" --broadcast --slow --skip-simulation >/dev/null
node - "$FORK_BLOCK" <<'JS'
const r = require('./broadcast/GasReport.s.sol/196/run-latest.json');
const g = r.receipts.map((x) => parseInt(x.gasUsed));
const swaps = [], deploys = [];
r.transactions.forEach((t, i) => {
  if ((t.function || '').startsWith('swap(')) swaps.push(g[i]);
  if (t.transactionType === 'CALL' && t.contractAddress == null && (t.function || '') === '' ) deploys.push(g[i]);
});
const labels = ['plain_static_0.30', 'hook_tier_table', 'hook_tier_live_eval', 'hook_final_config'];
// 6 alternating swaps per pool; steady = mean of swaps 3-6 (window slots written and both route sinks already funded).
const rows = labels.map((l, k) => { const s = swaps.slice(k * 6, k * 6 + 6); return { pool: l, swaps: s, steady: Math.round((s[2] + s[3] + s[4] + s[5]) / 4) }; });
const base = rows[0].steady;
const out = { forkBlock: Number(process.argv[2]), gasPriceWei: 20000001, rows: rows.map((r) => ({ ...r, overPlain: r.steady - base, overPlainPct: +(100 * (r.steady - base) / base).toFixed(1) })),
  hookDeployGas: r.receipts.filter((x, i) => (r.transactions[i].function || '') === '' && r.transactions[i].transaction.to?.toLowerCase() === '0x4e59b44847b379578588920ca78fbf26c0b4956c').map((x) => parseInt(x.gasUsed)),
  tapeoutGas: r.transactions.map((t, i) => [t.function || '', g[i]]).filter(([f]) => f.startsWith('tapeout(') || f.startsWith('mint(uint256,uint256)')).map(([f, x]) => ({ f: f.split('(')[0], gas: x })) };
require('fs').writeFileSync('gas-report.json', JSON.stringify(out, null, 2) + '\n');
console.table(out.rows.map(({ pool, steady, overPlain, overPlainPct }) => ({ pool, steady, overPlain, overPlainPct })));
console.log('hook deploy gas (tier table, tier live, final FeeRouteHook):', out.hookDeployGas.join(', '), '| tape-out txs:', JSON.stringify(out.tapeoutGas));
JS
