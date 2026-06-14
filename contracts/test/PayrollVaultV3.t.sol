// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PayrollVaultV3} from "../src/PayrollVaultV3.sol";
import {IPyth, PythPrice} from "../src/IPyth.sol";

contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) { allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; return true; }
}

contract MockPyth is IPyth {
    PythPrice public p;
    function set(int64 price, int32 expo) external { p = PythPrice(price, 0, expo, uint64(block.timestamp)); }
    function getPriceUnsafe(bytes32) external view returns (PythPrice memory) { require(p.publishTime != 0, "no price"); return p; }
}

contract PayrollVaultV3Test is Test {
    MockUSDC usdc;
    MockPyth oracle;
    PayrollVaultV3 vault;
    address employer = address(this);
    address agent = address(0xA9E27);
    address alice = address(0xA11CE);
    bytes32 constant AAPL = bytes32(uint256(1));

    function setUp() public {
        usdc = new MockUSDC();
        oracle = new MockPyth();
        oracle.set(29115005, -5); // AAPL $291.15
        vault = new PayrollVaultV3(address(usdc), address(oracle), AAPL, agent);
        usdc.mint(employer, 1_000_000_000); // 1,000 USDC
        usdc.approve(address(vault), 1_000_000_000);
        vault.fundPool(10_000_000); // 10 USDC pool
    }

    function _grant() internal {
        // 0.01 AAPL shares over 100s, cliff at 50s.
        vault.createSchedule(alice, 0.01e18, uint64(block.timestamp), uint64(block.timestamp + 50), 100);
    }

    function testQuoteMatchesOraclePrice() public view {
        // 0.01 AAPL @ $291.15 = $2.9115 -> 2_911_500 (6dec)
        assertEq(vault.quoteUsdc(0.01e18), 2_911_500);
    }

    function testReleasePaysOraclePricedUsdc() public {
        uint256 t0 = block.timestamp;
        _grant();
        vm.warp(t0 + 60); // 60% of 0.01 sh = 0.006 sh vested
        uint256 expected = vault.quoteUsdc(0.006e18); // ~$1.7469
        vm.prank(agent);
        vault.release(alice);
        assertEq(usdc.balanceOf(alice), expected);
        assertGt(expected, 0);
    }

    function testPayoutTracksPriceMovement() public {
        uint256 t0 = block.timestamp;
        _grant();
        vm.warp(t0 + 200); // fully vested 0.01 sh
        uint256 atOld = vault.releasableUsdc(alice);
        oracle.set(32000000, -5); // AAPL jumps to $320.00
        uint256 atNew = vault.releasableUsdc(alice);
        assertGt(atNew, atOld); // same shares, higher price -> higher USDC
        assertEq(atNew, 3_200_000); // 0.01 * 320
    }

    function testResetReArmsRemainingShares() public {
        uint256 t0 = block.timestamp;
        _grant();
        vm.warp(t0 + 60);
        vm.prank(agent);
        vault.release(alice); // releases 0.006 sh
        vm.prank(agent);
        vault.resetClock(alice, uint64(block.timestamp - 10), uint64(block.timestamp - 10), 10);
        (uint256 total, uint256 released,,,,) = vault.schedules(alice);
        assertEq(total, 0.004e18); // remaining
        assertEq(released, 0);
        assertEq(vault.releasableShares(alice), 0.004e18);
    }

    function testUnderfundedPoolReverts() public {
        // Drain the pool below the owed value.
        PayrollVaultV3 poor = new PayrollVaultV3(address(usdc), address(oracle), AAPL, agent);
        usdc.approve(address(poor), 1_000_000_000);
        poor.fundPool(1_000_000); // only $1 in the pool
        poor.createSchedule(alice, 0.01e18, uint64(block.timestamp), uint64(block.timestamp), 100);
        vm.warp(block.timestamp + 200); // fully vested, owes ~$2.91
        vm.prank(agent);
        vm.expectRevert("pool underfunded");
        poor.release(alice);
    }

    function testOnlyEmployerOrReleaserResets() public {
        _grant();
        vm.prank(address(0xBAD));
        vm.expectRevert("not authorized");
        vault.resetClock(alice, uint64(block.timestamp), uint64(block.timestamp), 10);
    }
}
