import { isAddress, type Address } from 'viem';

const addr = (v: string | undefined): Address | undefined => (v && isAddress(v) ? (v as Address) : undefined);

/** Deployed addresses. Unset until the mainnet deploy; every page renders an honest "not deployed" state until then. */
export const DEPLOYMENT = {
  gate: addr(process.env.NEXT_PUBLIC_LATCH_GATE),
  lock: addr(process.env.NEXT_PUBLIC_LATCH_LOCK),
  feed: addr(process.env.NEXT_PUBLIC_LATCH_FEED),
  evaluator: addr(process.env.NEXT_PUBLIC_LATCH_EVALUATOR),
  processor: addr(process.env.NEXT_PUBLIC_PROCESSOR),
};

export const deployed = Boolean(DEPLOYMENT.gate && DEPLOYMENT.lock && DEPLOYMENT.feed);

export const RPC = process.env.NEXT_PUBLIC_XLAYER_RPC || 'https://rpc.xlayer.tech';
export const IGNIX_API = 'https://api.ignix.bot';
export const IGNIX_LAUNCH_URL = (token: string) => `https://ignix.bot/launch?token=${token}`;
export const EXPLORER = 'https://www.oklink.com/xlayer';
export const TAPEOUT_FACTORY: Address = '0x1f09DAeFA827f02CBb40967cc91b259763760761';
