// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPyth, PythPrice} from "./IPyth.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title PayrollVaultV3 — RSU vesting, settled in USDC, priced by an oracle
/// @notice Equity that pays in cash. Each employee vests a number of RSU SHARES
///         (cliff + linear). On release, the contract reads a live company stock
///         price from a Pyth oracle and pays out the vested shares' value in
///         USDC — so the grant's USDC value tracks the real share price, exactly
///         like an RSU. The employer funds a USDC pool up front; the agent
///         releaser triggers releases (and can resetClock to re-arm a schedule).
contract PayrollVaultV3 {
    struct Schedule {
        uint256 totalShares; // RSU shares granted, 18 decimals
        uint256 releasedShares; // shares already paid out
        uint64 start;
        uint64 cliff;
        uint64 duration;
        bool exists;
    }

    IERC20 public immutable usdc; // payout asset (6 decimals on Arc)
    IPyth public immutable oracle; // price source (Pyth-shaped)
    bytes32 public immutable priceId; // e.g. AAPL/USD
    address public immutable employer;
    address public releaser;

    mapping(address => Schedule) public schedules;

    event ScheduleCreated(address indexed beneficiary, uint256 totalShares, uint64 start, uint64 cliff, uint64 duration);
    event Released(address indexed beneficiary, uint256 shares, uint256 usdcPaid, int64 price);
    event ScheduleReset(address indexed beneficiary, uint256 totalShares, uint64 start, uint64 cliff, uint64 duration);
    event ScheduleToppedUp(address indexed beneficiary, uint256 addedShares, uint256 totalShares);
    event PoolFunded(uint256 amount);
    event ReleaserUpdated(address indexed releaser);

    modifier onlyEmployer() {
        require(msg.sender == employer, "not employer");
        _;
    }

    modifier onlyEmployerOrReleaser() {
        require(msg.sender == employer || msg.sender == releaser, "not authorized");
        _;
    }

    constructor(address _usdc, address _oracle, bytes32 _priceId, address _releaser) {
        require(_usdc != address(0) && _oracle != address(0), "zero addr");
        usdc = IERC20(_usdc);
        oracle = IPyth(_oracle);
        priceId = _priceId;
        employer = msg.sender;
        releaser = _releaser;
    }

    function setReleaser(address _releaser) external onlyEmployer {
        releaser = _releaser;
        emit ReleaserUpdated(_releaser);
    }

    /// @notice Top the contract's USDC payout pool (employer approves first).
    function fundPool(uint256 amount) external onlyEmployer {
        require(amount > 0, "amount=0");
        require(usdc.transferFrom(msg.sender, address(this), amount), "funding failed");
        emit PoolFunded(amount);
    }

    /// @notice Grant an RSU vesting schedule (in shares). Funded from the shared
    ///         USDC pool at release time, valued by the oracle.
    function createSchedule(address beneficiary, uint256 totalShares, uint64 start, uint64 cliff, uint64 duration)
        external
        onlyEmployer
    {
        require(beneficiary != address(0), "beneficiary=0");
        require(totalShares > 0 && duration > 0, "bad amount/duration");
        require(cliff >= start, "cliff<start");
        require(!schedules[beneficiary].exists, "schedule exists");
        schedules[beneficiary] = Schedule(totalShares, 0, start, cliff, duration, true);
        emit ScheduleCreated(beneficiary, totalShares, start, cliff, duration);
    }

    /// @notice Re-arm the unreleased shares over a fresh clock (no new grant).
    function resetClock(address beneficiary, uint64 start, uint64 cliff, uint64 duration)
        external
        onlyEmployerOrReleaser
    {
        Schedule storage s = schedules[beneficiary];
        require(s.exists, "no schedule");
        require(duration > 0 && cliff >= start, "bad clock");
        uint256 remaining = s.totalShares - s.releasedShares;
        require(remaining > 0, "nothing remaining");
        s.totalShares = remaining;
        s.releasedShares = 0;
        s.start = start;
        s.cliff = cliff;
        s.duration = duration;
        emit ScheduleReset(beneficiary, remaining, start, cliff, duration);
    }

    function topUp(address beneficiary, uint256 addShares) external onlyEmployer {
        Schedule storage s = schedules[beneficiary];
        require(s.exists, "no schedule");
        require(addShares > 0, "shares=0");
        s.totalShares += addShares;
        emit ScheduleToppedUp(beneficiary, addShares, s.totalShares);
    }

    /// @notice Shares vested so far (cliff-gated, then linear).
    function vestedShares(address beneficiary) public view returns (uint256) {
        Schedule memory s = schedules[beneficiary];
        if (!s.exists || block.timestamp < s.cliff) return 0;
        if (block.timestamp >= s.start + s.duration) return s.totalShares;
        return (s.totalShares * (block.timestamp - s.start)) / s.duration;
    }

    function releasableShares(address beneficiary) public view returns (uint256) {
        return vestedShares(beneficiary) - schedules[beneficiary].releasedShares;
    }

    /// @notice USDC (6 dec) value of a share amount at the current oracle price.
    function quoteUsdc(uint256 shares) public view returns (uint256) {
        PythPrice memory p = oracle.getPriceUnsafe(priceId);
        require(p.price > 0, "bad oracle price");
        uint256 price = uint256(uint64(p.price));
        // payout(6dec) = shares(1e18) * price * 10^expo (USD/share) * 1e6 / 1e18.
        // expo is negative; scale down by 10^(-expo).
        uint256 e = uint256(int256(-p.expo));
        return (shares * price * 1e6) / (1e18 * (10 ** e));
    }

    function releasableUsdc(address beneficiary) external view returns (uint256) {
        return quoteUsdc(releasableShares(beneficiary));
    }

    /// @notice Release vested RSUs: pay their current USDC value from the pool.
    function release(address beneficiary) external returns (uint256 usdcOut) {
        require(
            msg.sender == beneficiary || msg.sender == employer || msg.sender == releaser, "not authorized"
        );
        uint256 shares = releasableShares(beneficiary);
        require(shares > 0, "nothing to release");
        usdcOut = quoteUsdc(shares);
        require(usdcOut > 0, "value rounds to zero");
        require(usdc.balanceOf(address(this)) >= usdcOut, "pool underfunded");

        schedules[beneficiary].releasedShares += shares;
        PythPrice memory p = oracle.getPriceUnsafe(priceId);
        require(usdc.transfer(beneficiary, usdcOut), "transfer failed");
        emit Released(beneficiary, shares, usdcOut, p.price);
    }
}
