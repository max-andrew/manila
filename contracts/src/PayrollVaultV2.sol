// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-20 surface (USDC on Arc exposes this at its token address).
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title PayrollVaultV2
/// @notice Programmable USDC payroll: per-employee cliff + linear vesting,
///         funded up front by the employer, released by the agent wallet.
///
///         V2 adds two operations so a long-running schedule stays live:
///         - resetClock: re-arm the *remaining* (unreleased) funds over a fresh
///           clock, without depositing more. Lets the agent restart vesting so
///           there's always an amount to release — the demo never dead-ends on a
///           fully-vested, fully-released schedule.
///         - topUp: add more USDC to an existing schedule.
///         Every release emits an event the off-chain audit log records.
contract PayrollVaultV2 {
    struct Schedule {
        uint256 total; // total USDC to vest from `start` (token base units)
        uint256 released; // amount already released
        uint64 start; // vesting start timestamp
        uint64 cliff; // no release before this timestamp
        uint64 duration; // seconds from start to fully vested
        bool exists;
    }

    IERC20 public immutable usdc;
    address public immutable employer; // funds the vault, creates schedules
    address public releaser; // the agent wallet permitted to release()/resetClock()

    mapping(address => Schedule) public schedules;

    event ScheduleCreated(
        address indexed beneficiary, uint256 total, uint64 start, uint64 cliff, uint64 duration
    );
    event Released(address indexed beneficiary, uint256 amount, uint256 totalReleased);
    event ScheduleReset(address indexed beneficiary, uint256 total, uint64 start, uint64 cliff, uint64 duration);
    event ScheduleToppedUp(address indexed beneficiary, uint256 added, uint256 total);
    event ReleaserUpdated(address indexed releaser);

    modifier onlyEmployer() {
        require(msg.sender == employer, "not employer");
        _;
    }

    modifier onlyEmployerOrReleaser() {
        require(msg.sender == employer || msg.sender == releaser, "not authorized");
        _;
    }

    constructor(address _usdc, address _releaser) {
        require(_usdc != address(0), "usdc=0");
        usdc = IERC20(_usdc);
        employer = msg.sender;
        releaser = _releaser;
    }

    /// @notice Point releases at the agent wallet (or rotate it).
    function setReleaser(address _releaser) external onlyEmployer {
        releaser = _releaser;
        emit ReleaserUpdated(_releaser);
    }

    /// @notice Create and fund a vesting schedule. Employer must approve this
    ///         contract for `total` USDC first; the funds are pulled in here.
    function createSchedule(
        address beneficiary,
        uint256 total,
        uint64 start,
        uint64 cliff,
        uint64 duration
    ) external onlyEmployer {
        require(beneficiary != address(0), "beneficiary=0");
        require(total > 0 && duration > 0, "bad amount/duration");
        require(cliff >= start, "cliff<start");
        require(!schedules[beneficiary].exists, "schedule exists");

        schedules[beneficiary] =
            Schedule({total: total, released: 0, start: start, cliff: cliff, duration: duration, exists: true});

        require(usdc.transferFrom(msg.sender, address(this), total), "funding failed");
        emit ScheduleCreated(beneficiary, total, start, cliff, duration);
    }

    /// @notice Re-arm the schedule's *remaining* (unreleased) funds over a fresh
    ///         clock — no new deposit. The new `total` is whatever has not yet
    ///         been released, so the contract never promises more than it holds.
    ///         Callable by the employer or the agent releaser. Use a `start` in
    ///         the past to make a slice immediately releasable.
    function resetClock(address beneficiary, uint64 start, uint64 cliff, uint64 duration)
        external
        onlyEmployerOrReleaser
    {
        Schedule storage s = schedules[beneficiary];
        require(s.exists, "no schedule");
        require(duration > 0, "bad duration");
        require(cliff >= start, "cliff<start");

        uint256 remaining = s.total - s.released;
        require(remaining > 0, "nothing remaining");

        s.total = remaining;
        s.released = 0;
        s.start = start;
        s.cliff = cliff;
        s.duration = duration;
        emit ScheduleReset(beneficiary, remaining, start, cliff, duration);
    }

    /// @notice Add more USDC to an existing schedule (employer approves first).
    function topUp(address beneficiary, uint256 amount) external onlyEmployer {
        Schedule storage s = schedules[beneficiary];
        require(s.exists, "no schedule");
        require(amount > 0, "amount=0");
        s.total += amount;
        require(usdc.transferFrom(msg.sender, address(this), amount), "funding failed");
        emit ScheduleToppedUp(beneficiary, amount, s.total);
    }

    /// @notice Amount vested so far (cliff-gated, then linear).
    function vested(address beneficiary) public view returns (uint256) {
        Schedule memory s = schedules[beneficiary];
        if (!s.exists || block.timestamp < s.cliff) return 0;
        if (block.timestamp >= s.start + s.duration) return s.total;
        return (s.total * (block.timestamp - s.start)) / s.duration;
    }

    /// @notice Vested but not-yet-released amount.
    function releasable(address beneficiary) public view returns (uint256) {
        return vested(beneficiary) - schedules[beneficiary].released;
    }

    /// @notice Release vested USDC to the beneficiary. Callable by the
    ///         beneficiary, the employer, or the agent releaser.
    function release(address beneficiary) external returns (uint256 amount) {
        require(
            msg.sender == beneficiary || msg.sender == employer || msg.sender == releaser,
            "not authorized"
        );
        amount = releasable(beneficiary);
        require(amount > 0, "nothing to release");

        schedules[beneficiary].released += amount;
        require(usdc.transfer(beneficiary, amount), "transfer failed");
        emit Released(beneficiary, amount, schedules[beneficiary].released);
    }
}
