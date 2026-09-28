import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LOG_RPC_URL = 'https://primary.invalid/rpc';
process.env.LOG_RPC_FALLBACK = 'https://fallback.invalid/rpc';
process.env.LOG_FALLBACK_RANGE = '100';
process.env.LOG_RETRY_MS = '1';

test('primary log RPC answering with an HTML page -> the range is fetched from the fallback in 100-block chunks', async () => {
  const calls: { url: string; from: number; to: number }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const { params } = JSON.parse(init.body);
    const from = parseInt(params[0].fromBlock, 16), to = parseInt(params[0].toBlock, 16);
    calls.push({ url, from, to });
    if (url.startsWith('https://primary')) return new Response('<!DOCTYPE html><title>Access</title>', { status: 307 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [{ address: '0xabc', topics: [], data: '0x', blockNumber: `0x${from.toString(16)}` }] }));
  }) as typeof fetch;
  try {
    const { getLogs } = await import('../src/indexer.ts');
    const logs = await getLogs(['0xabc'], 1000, 1349);
    const fb = calls.filter((c) => c.url.startsWith('https://fallback'));
    assert.deepEqual(fb.map((c) => [c.from, c.to]), [[1000, 1099], [1100, 1199], [1200, 1299], [1300, 1349]]);
    assert.equal(logs.length, 4, "every chunk's logs returned");
    assert.ok(calls.some((c) => c.url.startsWith('https://primary')), 'primary tried first');
  } finally {
    globalThis.fetch = realFetch;
  }
});
