// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Nandout's DISCLOSED demo pool: native OKB / XCAT with FeeRouteHook v2, full-range liquidity supplied by the Nandout
// deploy wallet from the XCAT it bought once. No swaps are made by us.
import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";

interface IERC20P { function balanceOf(address) external view returns (uint256); function approve(address, uint256) external returns (bool); }
interface IPairP { function getReserves() external view returns (uint112, uint112, uint32); }
interface IPermit2P { function approve(address, address, uint160, uint48) external; }
interface IPosmP { function modifyLiquidities(bytes calldata, uint256) external payable; function nextTokenId() external view returns (uint256); }

contract XcatPool is Script {
    using PoolIdLibrary for PoolKey;

    IPoolManager constant PM = IPoolManager(0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32);
    IPosmP constant POSM = IPosmP(0xcF1EAFC6928dC385A342E7C6491d371d2871458b);
    IPermit2P constant PERMIT2 = IPermit2P(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    IERC20P constant XCAT = IERC20P(0xbB9A906f1A8906D548C5D94b7079fA31bF09EEee);
    IPairP constant PAIR = IPairP(0x042df24e921205A6A5AaA2cCBC73E18B04AD77aE);
    address constant HOOK = 0xfd77af872A8f590680Fd27D79319e2e4E08E80c4;
    address constant OWNER = 0x934d315C0a9C0866D393B722C1805F2B6b20b816;

    function run() external {
        uint256 xcatSide = XCAT.balanceOf(OWNER);
        (uint112 rX, uint112 rW,) = PAIR.getReserves(); // token0 = XCAT, token1 = WOKB
        uint160 sqrtP = uint160(_sqrt(FullMath.mulDiv(uint256(rX), 1 << 192, uint256(rW)))); // XCAT per OKB, Q64.96
        uint256 okbSide = FullMath.mulDiv(xcatSide, uint256(rW), uint256(rX)) * 101 / 100; // balanced, 1% cap headroom
        uint256 L0 = FullMath.mulDiv(okbSide, sqrtP, 1 << 96);
        uint256 L1 = FullMath.mulDiv(xcatSide, 1 << 96, sqrtP);
        uint256 L = (L0 < L1 ? L0 : L1) * 99 / 100;
        PoolKey memory key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(XCAT)), LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(HOOK));
        uint256 tokenId = POSM.nextTokenId();
        console2.log("xcatSide", xcatSide);
        console2.log("okbSide cap", okbSide);
        console2.log("liquidity", L);
        console2.log("tokenId", tokenId);
        console2.logBytes32(PoolId.unwrap(key.toId()));

        bytes memory actions = abi.encodePacked(uint8(0x02), uint8(0x0d), uint8(0x14)); // MINT_POSITION, SETTLE_PAIR, SWEEP
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(key, int24(-887220), int24(887220), L, uint128(okbSide), uint128(xcatSide), OWNER, bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);
        params[2] = abi.encode(key.currency0, OWNER);

        vm.startBroadcast();
        XCAT.approve(address(PERMIT2), xcatSide);
        PERMIT2.approve(address(XCAT), address(POSM), uint160(xcatSide), uint48(block.timestamp + 1 hours));
        PM.initialize(key, sqrtP);
        POSM.modifyLiquidities{value: okbSide}(abi.encode(actions, params), block.timestamp + 1 hours);
        vm.stopBroadcast();
    }

    function _sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        z = x;
        uint256 y = (x >> 1) + 1;
        while (y < z) { z = y; y = (x / y + y) >> 1; }
    }
}
