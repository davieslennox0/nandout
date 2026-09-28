// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20B { function balanceOf(address) external view returns (uint256); function transfer(address, uint256) external returns (bool); }
interface IWOKBB is IERC20B { function deposit() external payable; }
interface IPairB { function getReserves() external view returns (uint112, uint112, uint32); function token0() external view returns (address); function swap(uint256, uint256, address, bytes calldata) external; }

/// One-shot purchase used ONCE for Nandout's disclosed demo (XCAT for the test lock and the demo pool's token side).
/// Everything happens in the constructor, in one transaction: wrap OKB, pay the v2 pair, swap priced from the pair's
/// reserves at execution, and revert unless at least `minOut` arrives at `to`.
contract BuyOnce {
    constructor(IPairB pair, IERC20B token, IWOKBB wokb, uint256 minOut, address to) payable {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        bool tokenIs0 = pair.token0() == address(token);
        (uint256 rIn, uint256 rOut) = tokenIs0 ? (uint256(r1), uint256(r0)) : (uint256(r0), uint256(r1));
        uint256 inWithFee = msg.value * 9970;
        uint256 out = inWithFee * rOut / (rIn * 10_000 + inWithFee);
        wokb.deposit{value: msg.value}();
        wokb.transfer(address(pair), msg.value);
        uint256 before = token.balanceOf(to);
        pair.swap(tokenIs0 ? out : 0, tokenIs0 ? 0 : out, to, "");
        require(token.balanceOf(to) - before >= minOut, "min out");
    }
}
