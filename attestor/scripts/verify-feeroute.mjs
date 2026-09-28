// Read-only mainnet verification of the deployed FeeRouteHook (hook/deployments/196.json). No transactions.
import { readFileSync } from 'node:fs';
import { createPublicClient, http, parseAbi, keccak256 } from 'viem';
import { xLayer } from 'viem/chains';
const dir = new URL('../../hook/', import.meta.url).pathname; // run: cd attestor && node scripts/verify-feeroute.mjs
const dep = JSON.parse(readFileSync(dir + 'deployments/196.json', 'utf8'));
const fee = JSON.parse(readFileSync(dir + 'test/fixtures/fee-circuits.json', 'utf8'));
const rte = JSON.parse(readFileSync(dir + 'test/fixtures/route-circuits.json', 'utf8'));
const c = createPublicClient({ chain: xLayer, transport: http('https://rpc.xlayer.tech') });
const cpu = parseAbi(['function netlist(uint256) view returns (bytes)', 'function eval(uint256, bytes) view returns (bytes)', 'function circuitInfo(uint256) view returns (uint32,uint32,uint32,uint32)']);
const hk = parseAbi([
  'function table() view returns (uint64)', 'function routeTable() view returns (uint64)', 'function volNetlist() view returns (address)', 'function depthNetlist() view returns (address)',
  'function routeSplitNetlist() view returns (address)', 'function routeGuardNetlist() view returns (address)', 'function hookFeePips() view returns (uint16)', 'function hookFeeRecipient() view returns (address)',
  'function routeBps() view returns (uint16)', 'function token() view returns (address)', 'function fee0() view returns (uint24)', 'function fee1() view returns (uint24)', 'function fee2() view returns (uint24)', 'function fee3() view returns (uint24)',
  'function volHigh() view returns (uint32)', 'function volElevated() view returns (uint32)', 'function depthThinBps() view returns (uint16)', 'function depthCriticalBps() view returns (uint16)', 'function epochBlocks() view returns (uint32)',
  'function destOf(uint8) view returns (address)', 'function evaluator() view returns (address)', 'function poolManager() view returns (address)',
]);
const P = dep.processor, H = dep.hook;
const r = (fn, args = []) => c.readContract({ address: H, abi: hk, functionName: fn, args });
let ok = true;
const check = (label, cond, extra = '') => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${extra ? '  ' + extra : ''}`); ok &&= cond; };
const block = await c.getBlockNumber();
console.log(`X Layer mainnet, block ${block}, hook ${H}`);

// 1. Netlists byte-for-byte == compiler output; the hook's SSTORE2 snapshots == the same bytes.
const circuits = [['VOL_GUARD', fee.circuits[0], 'volNetlist'], ['DEPTH_GUARD', fee.circuits[1], 'depthNetlist'], ['ROUTE_SPLIT', rte.circuits[0], 'routeSplitNetlist'], ['ROUTE_GUARD', rte.circuits[1], 'routeGuardNetlist']];
for (const [name, fx, getter] of circuits) {
  const id = BigInt(dep[name]);
  const onchain = await c.readContract({ address: P, abi: cpu, functionName: 'netlist', args: [id] });
  const [nIn, nOut, nState, gates] = await c.readContract({ address: P, abi: cpu, functionName: 'circuitInfo', args: [id] });
  check(`${name} (#${id}) netlist == compiler output, byte for byte`, onchain.toLowerCase() === fx.netlist.toLowerCase(), `${(onchain.length - 2) / 2} bytes, keccak ${keccak256(onchain).slice(0, 10)}…`);
  check(`${name} shape 16-in/1-out, stateless, ${fx.gateCount} gates`, nIn === 16 && nOut === 1 && nState === 0 && gates === fx.gateCount);
  const ptr = await r(getter);
  const code = await c.getCode({ address: ptr });
  check(`${name} hook snapshot (SSTORE2 ${ptr}) == taped-out bytes`, ('0x' + code.slice(4)).toLowerCase() === onchain.toLowerCase());
}

// 2. Tables == TapeOut live eval for all 32 fact words, read from mainnet.
const tier = await r('table'), route = await r('routeTable');
const ev = (id, f) => c.readContract({ address: P, abi: cpu, functionName: 'eval', args: [BigInt(id), `0x${f.toString(16).padStart(2, '0')}00`] }).then((b) => parseInt(b.slice(2, 4), 16) & 1);
let tierOk = true, routeOk = true;
for (let f = 0; f < 32; f++) {
  const [v, d, s, g] = await Promise.all([ev(dep.VOL_GUARD, f), ev(dep.DEPTH_GUARD, f), ev(dep.ROUTE_SPLIT, f), ev(dep.ROUTE_GUARD, f)]);
  if (Number((tier >> BigInt(2 * f)) & 3n) !== ((v << 1) | d) || ((v << 1) | d) !== fee.tiers[f]) tierOk = false;
  if (Number((route >> BigInt(2 * f)) & 3n) !== ((g << 1) | s) || ((g << 1) | s) !== rte.routes[f]) routeOk = false;
}
check('tier table == TapeOut live eval == DSL, all 32 fact words', tierOk, `table 0x${tier.toString(16)}`);
check('route table == TapeOut live eval == DSL, all 32 fact words', routeOk, `table 0x${route.toString(16)}`);

// 3. Permission bits + configuration.
const bits = BigInt(H) & 0x3fffn;
check('hook address low 14 bits == 0x00CC (beforeSwap, afterSwap, beforeSwapReturnsDelta, afterSwapReturnsDelta)', bits === 0xccn, `0x${bits.toString(16).padStart(4, '0')}`);
const cfg = { hookFeePips: 1000, hookFeeRecipient: '0x934d315C0a9C0866D393B722C1805F2B6b20b816', routeBps: 5, token: '0x0000000000000000000000000000000000000000', fee0: 500, fee1: 3000, fee2: 6000, fee3: 10000, volHigh: 20000, volElevated: 5000, depthThinBps: 5000, depthCriticalBps: 2500, epochBlocks: 60, evaluator: '0x8cA3ecB418962801e64FF1e847a444fAB6352D03', poolManager: '0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32' };
for (const [k, want] of Object.entries(cfg)) { const got = await r(k); check(`${k} = ${got}`, String(got).toLowerCase() === String(want).toLowerCase()); }
for (let i = 0; i < 4; i++) { const d = await r('destOf', [i]); check(`route ${i} destination = in-range LPs (address(0))`, d === '0x0000000000000000000000000000000000000000'); }
console.log(ok ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
process.exit(ok ? 0 : 1);
