// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTestHooks} from "v4-core/src/test/BaseTestHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {FeeEvaluator} from "../FeeEvaluator.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

interface IFactFeed { function milestone(address) external view returns (bool); }

/// @notice Phase 0 gas benchmark only. Not the product hook.
/// mode 0: fixed override fee (hook overhead baseline)
/// mode 1: facts (slot0 + liquidity + attested bit) + live NetlistVM eval via FeeEvaluator
/// mode 2: facts + frozen truth-table lookup
/// mode 3: mode 1 + per-swap volatility observation (one storage slot updated per swap)
/// mode 4: mode 2 + per-swap volatility observation
contract BenchHook is BaseTestHooks {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager public immutable manager;
    uint8 public immutable mode;
    FeeEvaluator public immutable evaluator;
    address public immutable netlist;
    uint256 public immutable table;
    IFactFeed public immutable feed;

    struct Obs { int24 lastTick; uint40 lastTime; uint32 ewma; }
    mapping(PoolId => Obs) public obs;

    constructor(IPoolManager m, uint8 mode_, FeeEvaluator e, address nl, uint256 table_, IFactFeed f) {
        manager = m; mode = mode_; evaluator = e; netlist = nl; table = table_; feed = f;
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        external
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        require(msg.sender == address(manager), "pm");
        if (mode == 0) return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 3000 | LPFeeLibrary.OVERRIDE_FEE_FLAG);
        PoolId id = key.toId();
        (, int24 tick,,) = manager.getSlot0(id);
        uint128 liq = manager.getLiquidity(id);
        uint32 vol;
        if (mode >= 3) {
            Obs memory o = obs[id];
            uint256 d = tick > o.lastTick ? uint256(int256(tick - o.lastTick)) : uint256(int256(o.lastTick - tick));
            vol = uint32((uint256(o.ewma) * 7 + d * 1000) / 8); // integer EWMA in Solidity; the circuit only sees the threshold bits
            obs[id] = Obs(tick, uint40(block.timestamp), vol);
        }
        uint8 facts = (vol > 50_000 ? 1 : 0) | (vol > 10_000 ? 2 : 0) | (liq < 1e18 ? 4 : 0)
            | (feed.milestone(Currency.unwrap(key.currency1)) ? 8 : 0) | (tick < 0 ? 16 : 0);
        uint8 tier = (mode == 1 || mode == 3) ? evaluator.tierOf(netlist, facts) : uint8((table >> (2 * facts)) & 3);
        uint24 fee = tier == 0 ? 500 : tier == 1 ? 3000 : tier == 2 ? 10000 : 30000;
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }
}

contract FactFeed is IFactFeed {
    mapping(address => bool) public milestone;
}
