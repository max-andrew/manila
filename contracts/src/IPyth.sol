// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The slice of Pyth's oracle interface Manila relies on. Anything that
///         implements this — the canonical Pyth contract, or our relay on Arc —
///         is a drop-in price source, so the vault never has to change.
struct PythPrice {
    int64 price; // price, scaled by 10^expo
    uint64 conf; // confidence interval
    int32 expo; // exponent (typically negative, e.g. -8)
    uint64 publishTime; // unix seconds the price was published
}

interface IPyth {
    /// @notice Latest price for a feed id, reverting if none has been posted.
    function getPriceUnsafe(bytes32 id) external view returns (PythPrice memory);
}
