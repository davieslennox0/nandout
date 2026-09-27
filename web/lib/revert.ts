import { BaseError, ContractFunctionRevertedError, parseAbi } from 'viem';

/** Errors a createLock/approve/release can surface: LatchLock (from its source), the token, and OZ SafeERC20/ERC20. */
export const lockErrorsAbi = parseAbi([
  'error FeeTooHigh()', 'error BadConfig()', 'error ZeroAddress()', 'error ZeroAmount()', 'error BadTranches()',
  'error UnknownFilter(uint64 filterId)', 'error StatefulUnlock(uint64 filterId)', 'error UnknownLock(uint256 lockId)',
  'error BadTranche(uint256 trancheIdx)', 'error AlreadyReleased()', 'error StillLatched(uint16 inputs)',
  'error FeedStale()', 'error ReentrancyGuardReentrantCall()', 'error SafeERC20FailedOperation(address token)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InvalidReceiver(address receiver)', 'error ERC20InvalidSender(address sender)', 'error CurveOnly()',
]);

/** Pull the named custom error out of a viem simulate/write error, if the ABI knows it. */
export function decodeRevert(e: unknown): { name?: string; args: readonly unknown[]; raw?: string; userRejected: boolean; message: string } {
  const message = (e as Error)?.message?.split('\n')[0] ?? String(e);
  const userRejected = /User rejected|denied|rejected the request/i.test(message);
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (r) return { name: r.data?.errorName ?? (r.reason ? 'Error' : undefined), args: r.data?.args ?? (r.reason ? [r.reason] : []), raw: r.raw, userRejected, message };
  }
  return { args: [], userRejected, message };
}
