// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PayrollVaultV2, IERC20} from "../src/PayrollVaultV2.sol";

contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract PayrollVaultV2Test is Test {
    MockUSDC usdc;
    PayrollVaultV2 vault;
    address employer = address(this);
    address agent = address(0xA9E27);
    address alice = address(0xA11CE);

    function setUp() public {
        usdc = new MockUSDC();
        vault = new PayrollVaultV2(address(usdc), agent);
        usdc.mint(employer, 10_000_000);
        usdc.approve(address(vault), 10_000_000);
    }

    function _schedule() internal {
        // 1.00 USDC over 100s, cliff at 50s.
        vault.createSchedule(alice, 1_000_000, uint64(block.timestamp), uint64(block.timestamp + 50), 100);
    }

    function testLinearReleaseThenResetReArmsRemaining() public {
        uint256 t0 = block.timestamp;
        _schedule();
        vm.warp(t0 + 60); // 60% vested
        vm.prank(agent);
        vault.release(alice); // releases 0.60, remaining 0.40 in the vault
        assertEq(usdc.balanceOf(alice), 600_000);
        assertEq(usdc.balanceOf(address(vault)), 400_000);

        // Re-arm the remaining 0.40 over a fresh clock, fully vested at once.
        vm.prank(agent);
        vault.resetClock(alice, uint64(block.timestamp - 10), uint64(block.timestamp - 10), 10);
        (uint256 total, uint256 released,,,,) = vault.schedules(alice);
        assertEq(total, 400_000);
        assertEq(released, 0);
        assertEq(vault.releasable(alice), 400_000);

        vm.prank(agent);
        vault.release(alice);
        assertEq(usdc.balanceOf(alice), 1_000_000); // 0.60 + 0.40
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function testResetNeverPromisesMoreThanHeld() public {
        // Geometric drain: each reset re-arms only what's still in the vault.
        uint256 t0 = block.timestamp;
        _schedule();
        vm.warp(t0 + 200); // fully vested
        vm.prank(agent);
        vault.release(alice); // releases all 1.00
        assertEq(usdc.balanceOf(address(vault)), 0);

        vm.prank(agent);
        vm.expectRevert("nothing remaining");
        vault.resetClock(alice, uint64(block.timestamp), uint64(block.timestamp), 10);
    }

    function testOnlyEmployerOrReleaserResets() public {
        _schedule();
        vm.prank(address(0xBAD));
        vm.expectRevert("not authorized");
        vault.resetClock(alice, uint64(block.timestamp), uint64(block.timestamp), 10);
    }

    function testTopUpAddsFunds() public {
        uint256 t0 = block.timestamp;
        _schedule();
        vault.topUp(alice, 500_000);
        (uint256 total,,,,,) = vault.schedules(alice);
        assertEq(total, 1_500_000);
        assertEq(usdc.balanceOf(address(vault)), 1_500_000);
        vm.warp(t0 + 200);
        vm.prank(agent);
        vault.release(alice);
        assertEq(usdc.balanceOf(alice), 1_500_000);
    }

    function testReleaseStillCliffGated() public {
        uint256 t0 = block.timestamp;
        _schedule();
        vm.warp(t0 + 49);
        assertEq(vault.releasable(alice), 0);
        vm.prank(agent);
        vm.expectRevert("nothing to release");
        vault.release(alice);
    }
}
