import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BITS } from '@latch/compiler';
import { checkToken, explainBits, REASONS } from '../src/tools.ts';

test('every bit has an on/off explanation', () => {
  for (const b of Object.keys(BITS)) assert.ok(REASONS[b as keyof typeof REASONS], b);
});

test('explainBits marks on-chain vs attested and picks the right sentence', () => {
  const word = (1 << BITS.LP_LOCKED) | (1 << BITS.AGE_GE_7D);
  const e = explainBits(word);
  const lp = e.find((x) => x.bit === 'LP_LOCKED')!;
  const age = e.find((x) => x.bit === 'AGE_GE_7D')!;
  const dev = e.find((x) => x.bit === 'DEV_NO_SELL_7D')!;
  assert.equal(lp.value, 1);
  assert.equal(lp.source, 'attested');
  assert.equal(age.source, 'on-chain');
  assert.equal(dev.value, 0);
  assert.match(dev.reason, /moved tokens out/);
});

test('tools answer honestly when contracts are not deployed', async () => {
  const env = { ignixApi: 'http://unused', client: {} as never };
  const r = (await checkToken(env, '0x0000000000000000000000000000000000000001', 1)) as { deployed: boolean };
  assert.equal(r.deployed, false);
});

test('package contains no signing or trading code', () => {
  const src = readdirSync(new URL('../src', import.meta.url)).map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')).join('\n');
  for (const banned of ['privateKeyToAccount', 'createWalletClient', 'sendTransaction', 'writeContract', 'swap']) {
    assert.ok(!src.includes(banned), `agent must stay read-only: found ${banned}`);
  }
});
