// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

interface IERC20T {
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function symbol() external view returns (string memory);
}

interface IPositionManagerView {
    function getPoolAndPositionInfo(uint256 tokenId) external view returns (PoolKey memory, uint256);
}

/// Read-only survey (local fork): does each graduated Ignix launch tax transfers, and specifically transfers into the
/// Uniswap v4 PoolManager? Tokens move holder -> fresh A (A cannot be on any exemption list), then A -> fresh B
/// (ordinary transfer) and A -> PoolManager. Losses are reported in basis points of the amount sent.
/// Run: XLAYER_RPC_URL=... forge test --mc IgnixTaxSurveyForkTest -vv   (writes bench/ignix-tax-survey.csv)
contract IgnixTaxSurveyForkTest is Test {
    address constant PM = 0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32;
    IPositionManagerView constant POSM = IPositionManagerView(0xcF1EAFC6928dC385A342E7C6491d371d2871458b);

    struct Row { address token; string symbol; string venue; address holder; uint256 holderBal; }

    function setUp() public {
        // Opt-in (minutes of fork reads; depends on live holder balances): IGNIX_SURVEY=true XLAYER_RPC_URL=... forge test --mc IgnixTaxSurveyForkTest
        string memory rpc = vm.envOr("XLAYER_RPC_URL", string(""));
        if (bytes(rpc).length == 0 || !vm.envOr("IGNIX_SURVEY", false)) vm.skip(true);
        vm.createSelectFork(rpc);
    }

    function _move(address token, address from, address to, uint256 amt) internal returns (bool ok, uint256 lossBps) {
        uint256 b = IERC20T(token).balanceOf(to);
        vm.prank(from);
        try IERC20T(token).transfer(to, amt) returns (bool) {
            uint256 got = IERC20T(token).balanceOf(to) - b;
            return (true, (amt - got) * 10_000 / amt);
        } catch {
            return (false, 0);
        }
    }

    function test_survey() public {
        string memory json = vm.readFile("test/fixtures/ignix-graduated.json");
        uint256 n = vm.parseJsonUint(json, ".count");
        string memory csv = "token,symbol,venue,holder_to_A_bps,A_to_EOA_bps,A_to_PoolManager_bps,v4_pool_hooks,v4_pool_fee";
        for (uint256 i = 0; i < n; i++) {
            string memory p = string.concat(".tokens[", vm.toString(i), "]");
            address token = vm.parseJsonAddress(json, string.concat(p, ".token"));
            address holder = vm.parseJsonAddress(json, string.concat(p, ".holder"));
            string memory venue = vm.parseJsonString(json, string.concat(p, ".venue"));
            uint256 bal = IERC20T(token).balanceOf(holder);
            string memory sym = IERC20T(token).symbol();
            string memory row;
            if (bal < 1000) {
                row = string.concat(vm.toString(token), ",", sym, ",", venue, ",holder-empty,,,,");
            } else {
                address a = address(uint160(uint256(keccak256(abi.encode("A", i)))));
                address b = address(uint160(uint256(keccak256(abi.encode("B", i)))));
                (bool ok0, uint256 t0) = _move(token, holder, a, bal / 2);
                uint256 have = IERC20T(token).balanceOf(a);
                (bool ok1, uint256 t1) = ok0 && have > 4 ? _move(token, a, b, have / 4) : (false, 0);
                (bool ok2, uint256 t2) = ok0 && have > 4 ? _move(token, a, PM, have / 4) : (false, 0);
                string memory hooks = "";
                string memory fee = "";
                if (keccak256(bytes(venue)) == keccak256("v4")) {
                    uint256 lp = vm.parseJsonUint(json, string.concat(p, ".lpTokenId"));
                    (PoolKey memory key,) = POSM.getPoolAndPositionInfo(lp);
                    hooks = vm.toString(address(key.hooks));
                    fee = vm.toString(uint256(key.fee));
                }
                row = string.concat(
                    vm.toString(token), ",", sym, ",", venue, ",",
                    ok0 ? vm.toString(t0) : "revert", ",", ok1 ? vm.toString(t1) : "revert", ",", ok2 ? vm.toString(t2) : "revert", ",",
                    hooks, ",", fee
                );
            }
            csv = string.concat(csv, "\n", row);
        }
        vm.writeFile("bench/ignix-tax-survey.csv", csv);
    }
}
