// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title LatchBits — the 16-bit input word fed to every Latch circuit.
/// @notice Must match compiler/src/bits.ts (checked against test/fixtures/circuits.json).
///         Circuit pins are packed little-endian: pin i = byte (i >> 3), bit (i & 7).
library LatchBits {
    uint16 internal constant AGENT_LINKED = 1 << 0;
    uint16 internal constant REV_GE_100 = 1 << 1;
    uint16 internal constant REV_GE_1000 = 1 << 2;
    uint16 internal constant LP_LOCKED = 1 << 3;
    uint16 internal constant TOP10_LT_40 = 1 << 4;
    uint16 internal constant TOP10_LT_25 = 1 << 5;
    uint16 internal constant DEV_NO_SELL_7D = 1 << 6;
    uint16 internal constant LATCH_LOCKED = 1 << 7; // on-chain (LatchLock)
    uint16 internal constant AGE_GE_7D = 1 << 8; // on-chain (feed launch time + block.timestamp)
    uint16 internal constant AGE_GE_30D = 1 << 9; // on-chain
    uint16 internal constant HOLDERS_GE_100 = 1 << 10;
    uint16 internal constant HOLDERS_GE_300 = 1 << 11;

    uint16 internal constant ONCHAIN_MASK = LATCH_LOCKED | AGE_GE_7D | AGE_GE_30D;
    uint16 internal constant RESERVED_MASK = 0xF000;
    uint16 internal constant ATTESTED_MASK = ~(ONCHAIN_MASK | RESERVED_MASK);

    uint32 internal constant N_IN = 16;
    uint32 internal constant N_OUT = 1;

    /// @dev TapeOut pin encoding for a 16-bit word: [low byte, high byte].
    function pack(uint16 bits) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(bits), uint8(bits >> 8));
    }
}
