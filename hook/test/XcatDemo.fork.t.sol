// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {FeeRouteHook} from "../src/FeeRouteHook.sol";
import {FeeCircuitHook} from "../src/FeeCircuitHook.sol";
import {ICPU} from "latch/vendor/tapeout/interfaces/ICPU.sol";
import {ICircuitRegistryView, ILatchEvaluator} from "latch/interfaces/ILatch.sol";

struct Tranche { uint64 filterId; uint16 bps; }

interface ILatchLockW {
    struct LockView { address token; address depositor; address beneficiary; uint64 createdAt; uint256 amount; uint256 released; }
    struct TrancheView { uint64 filterId; uint16 bps; bool released; uint256 amount; }
    function createLock(address token, uint256 amount, address beneficiary, Tranche[] calldata tranches) external returns (uint256);
    function getLock(uint256) external view returns (LockView memory, TrancheView[] memory);
    function isLocked(address token, address creator) external view returns (bool);
}

interface ILatchFeedW {
    function getBits(address) external view returns (uint16, uint64, uint64, address);
}

library FeedCreator {
    function creatorOf(ILatchFeedW f, address t) internal view returns (address c) { (,,, c) = f.getBits(t); }
}

interface IERC20D {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

interface IWOKB is IERC20D { function deposit() external payable; }

interface IPairV2 {
    function getReserves() external view returns (uint112, uint112, uint32);
    function token0() external view returns (address);
    function swap(uint256, uint256, address, bytes calldata) external;
}

interface IPermit2 { function approve(address token, address spender, uint160 amount, uint48 expiration) external; }

interface IPositionManager {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function nextTokenId() external view returns (uint256);
}

/// One-shot XCAT purchase: wrap OKB, pay the v2 pair, swap, all inside the constructor (one transaction, nothing to
/// front-run between steps). Reverts unless at least `minOut` XCAT reaches `to`.
contract BuyOnce {
    constructor(IPairV2 pair, IERC20D xcat, IWOKB wokb, uint256 minOut, address to, uint256 feeBpsNum) payable {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        bool xcatIs0 = pair.token0() == address(xcat);
        (uint256 rIn, uint256 rOut) = xcatIs0 ? (uint256(r1), uint256(r0)) : (uint256(r0), uint256(r1));
        uint256 inWithFee = msg.value * feeBpsNum;
        uint256 out = inWithFee * rOut / (rIn * 10_000 + inWithFee);
        wokb.deposit{value: msg.value}();
        wokb.transfer(address(pair), msg.value);
        uint256 before = xcat.balanceOf(to);
        pair.swap(xcatIs0 ? out : 0, xcatIs0 ? 0 : out, to, "");
        require(xcat.balanceOf(to) - before >= minOut, "min out");
    }
}

/// DRY RUN (local fork only) of the proposed XCAT demo, as the Nandout deploy wallet. Opt-in: XCAT_DEMO=true.
contract XcatDemoForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager constant PM = IPoolManager(0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32);
    IPositionManager constant POSM = IPositionManager(0xcF1EAFC6928dC385A342E7C6491d371d2871458b);
    IPermit2 constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    IERC20D constant XCAT = IERC20D(0xbB9A906f1A8906D548C5D94b7079fA31bF09EEee);
    IWOKB constant WOKB = IWOKB(0xe538905cf8410324e03A5A23C1c177a474D59b2b);
    IPairV2 constant PAIR = IPairV2(0x042df24e921205A6A5AaA2cCBC73E18B04AD77aE);
    address constant LOCK = 0xBe9ae981ec742B9053AD802a1D6A2B96E58b67f1;
    address constant FEED = 0x81Ea55c0d48fB985707eA224dC099Ff3C8f2AD78;
    address constant PROCESSOR = 0x8A60B4A4BCf4066F5E5F9A406fE09c5e4f52a58E;
    address constant CREATE2 = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    ILatchEvaluator constant EVALUATOR = ILatchEvaluator(0x8cA3ecB418962801e64FF1e847a444fAB6352D03);
    ICircuitRegistryView constant TAPEOUT = ICircuitRegistryView(0x1f09DAeFA827f02CBb40967cc91b259763760761);
    address constant DEPLOYER = 0x934d315C0a9C0866D393B722C1805F2B6b20b816;
    bytes32 constant SWAP_EVENT = keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");

    uint256 constant OKB_USD_E2 = 11691; // $116.91 (OKX ticker, 2026-09-28 07:24 UTC)

    function setUp() public {
        string memory rpc = vm.envOr("XLAYER_RPC_URL", string(""));
        if (bytes(rpc).length == 0 || !vm.envOr("XCAT_DEMO", false)) vm.skip(true);
        vm.createSelectFork(rpc);
    }

    function test_dryRun() public {
        uint256 usd20 = 20e18 * 100 / OKB_USD_E2; // OKB worth $20: ONE purchase covers the lock and the pool
        vm.deal(DEPLOYER, 1 ether); // fork-only headroom
        vm.startPrank(DEPLOYER);

        // 1. One open-market purchase.
        (uint112 r0, uint112 r1,) = PAIR.getReserves();
        uint256 quoted = usd20 * 9970 * uint256(r0) / (uint256(r1) * 10_000 + usd20 * 9970);
        uint256 x0 = XCAT.balanceOf(DEPLOYER);
        uint256 g = gasleft();
        new BuyOnce{value: usd20}(PAIR, XCAT, WOKB, quoted * 96 / 100, DEPLOYER, 9970);
        emit log_named_uint("gas: buy (one tx)", g - gasleft());
        uint256 got = XCAT.balanceOf(DEPLOYER) - x0;
        emit log_named_decimal_uint("OKB spent on the buy", usd20, 18);
        emit log_named_decimal_uint("XCAT quoted before tax", quoted, 18);
        emit log_named_decimal_uint("XCAT received (after XCAT's buy tax)", got, 18);
        uint256 spotOut = usd20 * uint256(r0) / uint256(r1);
        emit log_named_uint("shortfall vs spot, bps", (spotOut - got) * 10_000 / spotOut);

        // 2. Tax on a plain transfer into LatchLock (measured, not assumed), then the test lock with half the XCAT.
        uint256 half = got / 2;
        uint256 lb = XCAT.balanceOf(LOCK);
        XCAT.transfer(LOCK, 1e18);
        emit log_named_uint("XCAT tax on transfer into LatchLock, bps", (1e18 - (XCAT.balanceOf(LOCK) - lb)) * 10_000 / 1e18);
        XCAT.approve(LOCK, half);
        Tranche[] memory tr = new Tranche[](1);
        tr[0] = Tranche(4, 10_000); // UNLOCK_T1, 100%
        g = gasleft();
        uint256 lockId = ILatchLockW(LOCK).createLock(address(XCAT), half, DEPLOYER, tr);
        emit log_named_uint("gas: createLock", g - gasleft());
        (ILatchLockW.LockView memory lv,) = ILatchLockW(LOCK).getLock(lockId);
        emit log_named_decimal_uint("lock: requested", half, 18);
        emit log_named_decimal_uint("lock: actually locked (after 0.5% fee and any tax)", lv.amount, 18);
        emit log_named_uint("LATCH_LOCKED for XCAT (we are not its creator): isLocked", ILatchLockW(LOCK).isLocked(address(XCAT), FeedCreator.creatorOf(ILatchFeedW(FEED), address(XCAT))) ? 1 : 0);

        // 3. The corrected hook (fee on the actual fill), deployed here on the fork with the already-taped-out circuits #7-#10.
        address hook = _deployV2Hook();
        g = 0;

        // 4. Pool at the v2 pair's price, full range, with the remaining XCAT and matching OKB.
        PoolKey memory key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(XCAT)), LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(hook));
        (r0, r1,) = PAIR.getReserves();
        uint160 sqrtP = uint160(FixedSqrt.sqrt(FullMath.mulDiv(uint256(r0), 1 << 192, uint256(r1))));
        g = gasleft();
        PM.initialize(key, sqrtP);
        emit log_named_uint("gas: pool initialize", g - gasleft());
        XCAT.approve(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(address(XCAT), address(POSM), type(uint160).max, uint48(block.timestamp + 1 days));
        uint256 xcatSide = XCAT.balanceOf(DEPLOYER) - x0;
        uint256 okbSide = FullMath.mulDiv(xcatSide, 1 << 192, uint256(sqrtP) * uint256(sqrtP)) * 101 / 100; // ~ equal value, capped below
        uint256 L0 = FullMath.mulDiv(okbSide, sqrtP, 1 << 96);
        uint256 L1 = FullMath.mulDiv(xcatSide, 1 << 96, sqrtP);
        uint256 L = (L0 < L1 ? L0 : L1) * 99 / 100;
        uint256 tokenId = POSM.nextTokenId();
        bytes memory actions = abi.encodePacked(uint8(0x02), uint8(0x0d), uint8(0x14));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(key, int24(-887220), int24(887220), L, uint128(okbSide), uint128(xcatSide), DEPLOYER, bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);
        params[2] = abi.encode(key.currency0, DEPLOYER);
        uint256 okbBefore = DEPLOYER.balance;
        uint256 xBefore = XCAT.balanceOf(DEPLOYER);
        g = gasleft();
        POSM.modifyLiquidities{value: okbSide}(abi.encode(actions, params), block.timestamp + 600);
        emit log_named_uint("gas: add liquidity (mint position NFT)", g - gasleft());
        uint256 okbIn = okbBefore - DEPLOYER.balance;
        uint256 xIn = xBefore - XCAT.balanceOf(DEPLOYER);
        emit log_named_decimal_uint("liquidity: OKB side", okbIn, 18);
        emit log_named_decimal_uint("liquidity: XCAT side", xIn, 18);

        // 5. Read-only tier evidence (on mainnet: eth_call, no transaction): the circuit's facts and tier for the live pool,
        //    and simulated swaps whose state is discarded.
        uint8 facts = FeeRouteHook(hook).currentFacts(key);
        emit log_named_uint("currentFacts (view)", facts);
        emit log_named_uint("tier fee for those facts (view), pips", FeeRouteHook(hook).feeOfTier(FeeRouteHook(hook).tierOf(facts)));
        PoolSwapTest router = new PoolSwapTest(PM);
        uint256 snap = vm.snapshotState();
        (uint24 simFee,) = _swap(router, key, true, okbSide / 100);
        vm.revertToState(snap);
        emit log_named_uint("simulated swap (state discarded): LP fee applied, pips", simFee);

        // 6. Withdraw (proves the liquidity comes back): BURN_POSITION + TAKE_PAIR.
        okbBefore = DEPLOYER.balance;
        xBefore = XCAT.balanceOf(DEPLOYER);
        actions = abi.encodePacked(uint8(0x03), uint8(0x11));
        params = new bytes[](2);
        params[0] = abi.encode(tokenId, uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, DEPLOYER);
        g = gasleft();
        POSM.modifyLiquidities(abi.encode(actions, params), block.timestamp + 600);
        emit log_named_uint("gas: withdraw (burn position)", g - gasleft());
        emit log_named_decimal_uint("withdrawn: OKB", DEPLOYER.balance - okbBefore, 18);
        emit log_named_decimal_uint("withdrawn: XCAT", XCAT.balanceOf(DEPLOYER) - xBefore, 18);
        vm.stopPrank();
    }

    function _deployV2Hook() internal returns (address hook) {
        string memory fee = vm.readFile("test/fixtures/fee-circuits.json");
        string memory rte = vm.readFile("test/fixtures/route-circuits.json");
        FeeCircuitHook.Guard memory v = FeeCircuitHook.Guard(ICPU(PROCESSOR), 7, vm.parseJsonBytes32(fee, ".circuits[0].netlistHash"));
        FeeCircuitHook.Guard memory d = FeeCircuitHook.Guard(ICPU(PROCESSOR), 8, vm.parseJsonBytes32(fee, ".circuits[1].netlistHash"));
        FeeCircuitHook.Guard memory sp = FeeCircuitHook.Guard(ICPU(PROCESSOR), 9, vm.parseJsonBytes32(rte, ".circuits[0].netlistHash"));
        FeeCircuitHook.Guard memory gu = FeeCircuitHook.Guard(ICPU(PROCESSOR), 10, vm.parseJsonBytes32(rte, ".circuits[1].netlistHash"));
        FeeRouteHook.RouteConfig memory r = FeeRouteHook.RouteConfig(sp, gu, [address(0), address(0), address(0), address(0)], 5, Currency.wrap(address(0)), 1000, DEPLOYER);
        bytes memory init = abi.encodePacked(type(FeeRouteHook).creationCode, abi.encode(PM, EVALUATOR, TAPEOUT, v, d, [uint24(500), 3000, 6000, 10000], FeeCircuitHook.Thresholds(20_000, 5_000, 5_000, 2_500), uint32(60), r));
        bytes32 h = keccak256(init);
        uint256 salt;
        for (;; salt++) {
            hook = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2, bytes32(salt), h)))));
            if (uint160(hook) & ((1 << 14) - 1) == (1 << 7) | (1 << 6) | (1 << 2)) break;
        }
        uint256 g = gasleft();
        (bool ok,) = CREATE2.call(abi.encodePacked(bytes32(salt), init));
        require(ok && hook.code.length > 0, "hook");
        emit log_named_uint("gas: redeploy FeeRouteHook (circuits #7-#10 reused)", g - gasleft());
        emit log_named_address("v2 hook (fork; mainnet address depends on deploy nonce-free CREATE2: same init code -> same address)", hook);
    }

    function _swap(PoolSwapTest router, PoolKey memory key, bool zeroForOne, uint256 amountIn) internal returns (uint24 fee, uint256 gasUsed) {
        vm.recordLogs();
        uint256 g = gasleft();
        router.swap{value: zeroForOne ? amountIn : 0}(
            key, SwapParams(zeroForOne, -int256(amountIn), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1), PoolSwapTest.TestSettings(false, false), ""
        );
        gasUsed = g - gasleft();
        fee = _fee(vm.getRecordedLogs());
    }

    function _swapToTick(PoolSwapTest router, PoolKey memory key, int24 target) internal returns (uint24 fee, uint256 gasUsed) {
        (, int24 tick,,) = PM.getSlot0(key.toId());
        bool zeroForOne = target < tick;
        vm.recordLogs();
        uint256 g = gasleft();
        router.swap{value: zeroForOne ? 1 ether / 10 : 0}(
            key, SwapParams(zeroForOne, (zeroForOne ? -int256(uint256(1 ether / 10)) : -int256(uint256(1e30))), TickMath.getSqrtPriceAtTick(target)), PoolSwapTest.TestSettings(false, false), ""
        );
        gasUsed = g - gasleft();
        fee = _fee(vm.getRecordedLogs());
    }

    function _fee(Vm.Log[] memory logs) internal pure returns (uint24 fee) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(PM) && logs[i].topics[0] == SWAP_EVENT) {
                (,,,,, fee) = abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
                return fee;
            }
        }
    }

    receive() external payable {}
}

library FixedSqrt {
    function sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        z = x;
        uint256 y = (x >> 1) + 1;
        while (y < z) { z = y; y = (x / y + y) >> 1; }
    }
}
