// Nandout MCP server (stdio). Exposes read-only Latch tools to OKX.AI / any MCP client.
//   LATCH_GATE=0x.. LATCH_LOCK=0x.. LATCH_FEED=0x.. tsx src/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { checkToken, envFromProcess, explainLatch, feedStatus, listUnlatched, lockGuide } from './tools.ts';

const env = envFromProcess();
const server = new McpServer({ name: 'nandout', version: '0.1.0' });

const reply = async (f: () => Promise<unknown>) => {
  try {
    return { content: [{ type: 'text' as const, text: JSON.stringify(await f(), (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] };
  }
};

const filterArg = z.union([z.string(), z.number()]).describe('Filter id or name, e.g. 1 or "BASIC_SAFETY"');

server.tool('check_token', 'Is this Ignix launch unlatched (trusted) under a Nandout filter? Read on-chain from LatchGate.',
  { token: z.string().describe('Token address (0x…)'), filter: filterArg },
  ({ token, filter }) => reply(() => checkToken(env, token, filter)));

server.tool('list_unlatched', 'List Ignix launches that currently pass a Nandout filter, most holders first.',
  { filter: filterArg, limit: z.number().int().min(1).max(100).optional() },
  ({ filter, limit }) => reply(() => listUnlatched(env, filter, limit)));

server.tool('explain_latch', 'Explain, bit by bit, why a launch is latched or unlatched under every registered filter.',
  { token: z.string().describe('Token address (0x…)') },
  ({ token }) => reply(() => explainLatch(env, token)));

server.tool('lock_guide', 'Step-by-step guide to locking a creator allocation in LatchLock, with live fee and threshold values.',
  { token: z.string().describe('Token address (0x…)') },
  ({ token }) => reply(() => lockGuide(env, token)));

server.tool('feed_status', 'Is the Nandout attestor feed fresh?', {}, () => reply(() => feedStatus(env)));

await server.connect(new StdioServerTransport());
