import { DEPLOYMENT } from '@/lib/config';

const GATE = DEPLOYMENT.gate ?? '0x… (LatchGate, published at deploy)';

export default function DocsPage() {
  return (
    <>
      <h1>Integrate</h1>
      <p className="lede">
        One view call. No keys, no subscription, no gas for off-chain callers. A vault checks a launch before deploying
        capital; an agent checks before recommending it.
      </p>

      <h2>Check one launch (viem)</h2>
      <pre>{`import { createPublicClient, http, parseAbi } from 'viem';
import { xLayer } from 'viem/chains';

const gate = '${GATE}';
const abi = parseAbi([
  'function check(address token, uint256 filterId) view returns (bool pass, uint16 inputs)',
  'function checkMany(address[] tokens, uint256 filterId) view returns (bool[] passes, uint16[] ins)',
]);
const client = createPublicClient({ chain: xLayer, transport: http() });

const [pass, inputs] = await client.readContract({
  address: gate, abi, functionName: 'check', args: [token, 1n], // 1 = BASIC_SAFETY
});`}</pre>

      <h2>Gate a vault (Solidity)</h2>
      <pre>{`interface ILatchGate {
    function checkMany(address[] calldata tokens, uint256 filterId)
        external view returns (bool[] memory passes, uint16[] memory inputs);
}

function _deployable(address[] calldata candidates) internal view returns (address[] memory ok) {
    (bool[] memory passes,) = GATE.checkMany(candidates, FILTER_ID);
    // keep only unlatched launches…
}`}</pre>

      <h2>Semantics</h2>
      <ul>
        <li><code>check</code> / <code>checkMany</code> evaluate the live TapeOut circuit. Combinational filters revert with <code>FeedStale()</code> if the attestor feed is older than its max age; latch filters return their last snapshotted state instead.</li>
        <li><code>checkMany</code> returns <code>false</code> for tokens the feed has never seen, instead of reverting.</li>
        <li><code>inputs</code> is the 16-bit word the circuit saw: bits 0–6 and 10–12 are attested; <code>LATCH_LOCKED</code> and <code>AGE_*</code> (bits 7–9) are computed on-chain.</li>
        <li><code>checkLocal</code> runs the same circuit through the sealed LatchEvaluator, which is what LatchLock releases use. <code>verify</code> returns both.</li>
      </ul>

      <h2>Lock an allocation</h2>
      <p>
        <code>LatchLock.createLock(token, amount, beneficiary, [(filterId, bps)…])</code>. bps must sum to 10,000; unlock
        filters must be combinational. <code>release(lockId, trancheIdx)</code> is callable by anyone and pays only the
        beneficiary.
      </p>
    </>
  );
}
