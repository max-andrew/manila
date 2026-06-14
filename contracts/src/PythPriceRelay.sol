// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPyth, PythPrice} from "./IPyth.sol";

/// @title PythPriceRelay
/// @notice A Pyth-shaped price source for Arc. Pyth publishes signed prices off
///         chain (Hermes); a permissioned relayer posts the latest one here, and
///         consumers read it through the standard `IPyth.getPriceUnsafe`. Because
///         it implements the same interface as the canonical Pyth contract,
///         pointing a consumer at a native Pyth deployment later is an
///         address swap — no code change.
contract PythPriceRelay is IPyth {
    address public immutable relayer;
    mapping(bytes32 => PythPrice) internal prices;

    event PriceRelayed(bytes32 indexed id, int64 price, int32 expo, uint64 publishTime);

    constructor(address _relayer) {
        require(_relayer != address(0), "relayer=0");
        relayer = _relayer;
    }

    /// @notice Post the latest Hermes price for a feed id.
    function pushPrice(bytes32 id, int64 price, uint64 conf, int32 expo, uint64 publishTime) external {
        require(msg.sender == relayer, "not relayer");
        require(price > 0, "bad price");
        prices[id] = PythPrice({price: price, conf: conf, expo: expo, publishTime: publishTime});
        emit PriceRelayed(id, price, expo, publishTime);
    }

    function getPriceUnsafe(bytes32 id) external view returns (PythPrice memory) {
        PythPrice memory p = prices[id];
        require(p.publishTime != 0, "no price for feed");
        return p;
    }
}
