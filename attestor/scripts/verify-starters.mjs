// Read-only: recompile every starter circuit with the CURRENT compiler and compare byte-for-byte with what is deployed on
// X Layer mainnet: the netlist stored on the Nandout processor (TapeOut) and LatchGate's frozen SSTORE2 copy (which
// LatchLock releases evaluate via gate.netlistPointer). Reads from chain, not fixtures.
//   cd attestor && npx tsx scripts/verify-starters.mjs
import { readFileSync } from 'node:fs';
import { createPublicClient, http, parseAbi, keccak256 } from 'viem';
import { xLayer } from 'viem/chains';
import { compile, STARTERS } from '@latch/compiler';

const dep = JSON.parse(readFileSync(new URL('../../contracts/deployments/196.json', import.meta.url), 'utf8'));
const c = createPublicClient({ chain: xLayer, transport: http('https://rpc.xlayer.tech') });
const gateAbi = parseAbi([
  'function getFilter(uint256) view returns ((address cpu, uint64 circuitId, uint32 gateCount, uint32 nState, address netlistPointer, bytes32 netlistHash, address registrant, string name))',
  'function netlistPointer(uint256) view returns (address)', 'function lock() view returns (address)', 'function evaluator() view returns (address)', 'function filterCount() view returns (uint256)',
]);
const lockAbi = parseAbi(['function gate() view returns (address)', 'function evaluator() view returns (address)']);
const cpuAbi = parseAbi(['function netlist(uint256) view returns (bytes)']);
const lc = (x) => String(x).toLowerCase();
let allOk = true;
const block = await c.getBlockNumber();
console.log(`X Layer mainnet block ${block}`);

const [lockGate, lockEval, gateLock, gateEval] = await Promise.all([
  c.readContract({ address: dep.lock, abi: lockAbi, functionName: 'gate' }),
  c.readContract({ address: dep.lock, abi: lockAbi, functionName: 'evaluator' }),
  c.readContract({ address: dep.gate, abi: gateAbi, functionName: 'lock' }),
  c.readContract({ address: dep.gate, abi: gateAbi, functionName: 'evaluator' }),
]);
const wiring = lc(lockGate) === lc(dep.gate) && lc(gateLock) === lc(dep.lock) && lc(lockEval) === lc(dep.evaluator) && lc(gateEval) === lc(dep.evaluator);
console.log(`${wiring ? 'PASS' : 'FAIL'}  wiring: LatchLock.gate == LatchGate, LatchGate.lock == LatchLock, both use LatchEvaluator ${dep.evaluator}`);
allOk &&= wiring;

for (const [name, fid] of Object.entries(dep.filters).sort((a, b) => a[1] - b[1])) {
  const compiled = compile(name, STARTERS[name]);
  const f = await c.readContract({ address: dep.gate, abi: gateAbi, functionName: 'getFilter', args: [BigInt(fid)] });
  const onProcessor = await c.readContract({ address: f.cpu, abi: cpuAbi, functionName: 'netlist', args: [f.circuitId] });
  const ptrForLock = await c.readContract({ address: dep.gate, abi: gateAbi, functionName: 'netlistPointer', args: [BigInt(fid)] });
  const code = await c.getCode({ address: f.netlistPointer });
  const frozen = '0x' + code.slice(4); // SSTORE2: STOP byte, then data
  const checks = {
    'processor == compiler': lc(onProcessor) === lc(compiled.netlist),
    'LatchGate frozen copy == compiler': lc(frozen) === lc(compiled.netlist),
    'registered hash == keccak(compiler)': lc(f.netlistHash) === lc(compiled.netlistHash) && lc(keccak256(frozen)) === lc(compiled.netlistHash),
    'pointer LatchLock evaluates == frozen copy': lc(ptrForLock) === lc(f.netlistPointer),
    'name/cpu/shape': f.name === name && lc(f.cpu) === lc(dep.processor) && f.gateCount === compiled.gateCount && f.nState === compiled.nState,
  };
  const ok = Object.values(checks).every(Boolean);
  allOk &&= ok;
  console.log(`${ok ? 'PASS' : 'FAIL'}  filter #${fid} ${name.padEnd(14)} circuit #${f.circuitId}  ${(compiled.netlist.length - 2) / 2} bytes  ${compiled.gateCount} gates  keccak ${compiled.netlistHash.slice(0, 10)}…` +
    (ok ? '' : '  ' + Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join('; ')));
}
console.log(allOk ? '\nALL PASS' : '\nMISMATCH: STOP');
process.exit(allOk ? 0 : 1);
