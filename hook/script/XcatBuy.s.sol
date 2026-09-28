// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// The ONE open-market XCAT purchase for Nandout's disclosed demo (test lock + demo pool). Not repeated.
import {Script, console2} from "forge-std/Script.sol";
import {BuyOnce, IPairB, IERC20B, IWOKBB} from "../src/demo/BuyOnce.sol";

contract XcatBuy is Script {
    IPairB constant PAIR = IPairB(0x042df24e921205A6A5AaA2cCBC73E18B04AD77aE);
    IERC20B constant XCAT = IERC20B(0xbB9A906f1A8906D548C5D94b7079fA31bF09EEee);
    IWOKBB constant WOKB = IWOKBB(0xe538905cf8410324e03A5A23C1c177a474D59b2b);
    address constant TO = 0x934d315C0a9C0866D393B722C1805F2B6b20b816;

    function run() external {
        uint256 value = vm.envUint("BUY_WEI");
        (uint112 r0, uint112 r1,) = PAIR.getReserves(); // token0 = XCAT, token1 = WOKB
        uint256 quote = value * 9970 * uint256(r0) / (uint256(r1) * 10_000 + value * 9970);
        uint256 minOut = quote * 96 / 100; // 3% buy tax + slippage headroom
        console2.log("quote (pre-tax)", quote);
        console2.log("minOut", minOut);
        vm.startBroadcast();
        new BuyOnce{value: value}(PAIR, XCAT, WOKB, minOut, TO);
        vm.stopBroadcast();
    }
}
