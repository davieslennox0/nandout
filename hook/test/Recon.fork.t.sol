// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";

/// @notice Phase 0 recon claims, re-checked on every CI run against a local fork of X Layer mainnet (docs/HOOK-RECON.md).
contract ReconForkTest is Test {
    address internal constant POOL_MANAGER = 0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32;
    address internal constant CANONICAL_ETH_POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;

    function setUp() public {
        string memory rpc = vm.envOr("XLAYER_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
    }

    /// X Layer's PoolManager is byte-identical to Uniswap's canonical Ethereum deployment except the 20-byte
    /// NoDelegateCall self-address immutable, i.e. it is released v4-core, unmodified.
    function test_poolManagerIsCanonicalV4Core() public {
        bytes memory live = POOL_MANAGER.code;
        vm.createSelectFork(vm.envOr("ETH_RPC_URL", string("https://ethereum-rpc.publicnode.com")));
        bytes memory canonical = CANONICAL_ETH_POOL_MANAGER.code;
        assertEq(live.length, canonical.length, "same length");
        bytes20 eth = bytes20(CANONICAL_ETH_POOL_MANAGER);
        bytes20 xl = bytes20(POOL_MANAGER);
        uint256 replaced;
        for (uint256 i = 0; i + 20 <= canonical.length; i++) {
            bool hit = true;
            for (uint256 j = 0; j < 20; j++) if (canonical[i + j] != eth[j]) { hit = false; break; }
            if (hit) { for (uint256 j = 0; j < 20; j++) canonical[i + j] = xl[j]; replaced++; }
        }
        assertEq(replaced, 1, "one self-address immutable");
        assertEq(keccak256(canonical), keccak256(live), "identical after substituting the self-address");
    }

    function test_dynamicFeeFlags() public pure {
        assertEq(LPFeeLibrary.DYNAMIC_FEE_FLAG, 0x800000);
        assertEq(LPFeeLibrary.OVERRIDE_FEE_FLAG, 0x400000);
    }
}
