// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PayrollVault, IERC20} from "../src/PayrollVault.sol";

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

contract PayrollVaultTest is Test {
    MockUSDC usdc;
    PayrollVault vault;
    address employer = address(this);
    address agent = address(0xA9E27);
    address alice = address(0xA11CE);

    function setUp() public {
        usdc = new MockUSDC();
        vault = new PayrollVault(address(usdc), agent);
        usdc.mint(employer, 1_000_000);
        usdc.approve(address(vault), 1_000_000);
    }

    function _schedule() internal {
        // 1.00 USDC over 100s, cliff at 50s.
        vault.createSchedule(alice, 1_000_000, uint64(block.timestamp), uint64(block.timestamp + 50), 100);
    }

    function testNothingBeforeCliff() public {
        _schedule();
        vm.warp(block.timestamp + 49);
        assertEq(vault.releasable(alice), 0);
        vm.prank(agent);
        vm.expectRevert("nothing to release");
        vault.release(alice);
    }

    function testLinearAfterCliff() public {
        uint256 t0 = block.timestamp;
        _schedule();
        vm.warp(t0 + 60); // 60% through
        assertEq(vault.releasable(alice), 600_000);
        vm.prank(agent); // agent wallet triggers the release
        vault.release(alice);
        assertEq(usdc.balanceOf(alice), 600_000);
    }

    function testFullyVestedAndNoDoubleRelease() public {
        uint256 t0 = block.timestamp;
        _schedule();
        vm.warp(t0 + 200);
        vm.prank(agent);
        vault.release(alice);
        assertEq(usdc.balanceOf(alice), 1_000_000);
        vm.prank(agent);
        vm.expectRevert("nothing to release");
        vault.release(alice);
    }

    function testOnlyAuthorizedCanRelease() public {
        uint256 t0 = block.timestamp;
        _schedule();
        vm.warp(t0 + 100);
        vm.prank(address(0xBAD));
        vm.expectRevert("not authorized");
        vault.release(alice);
    }

    // At the cliff, the whole amount accrued from start unlocks at once
    // (standard cliff vesting), then it continues linearly.
    function testCliffUnlocksAccruedChunkAtOnce() public {
        uint256 t0 = block.timestamp;
        _schedule(); // cliff at +50, duration 100
        vm.warp(t0 + 49);
        assertEq(vault.releasable(alice), 0); // nothing before the cliff
        vm.warp(t0 + 50);
        assertEq(vault.releasable(alice), 500_000); // 50% unlocks in one step
    }

    function testCannotCreateScheduleTwice() public {
        _schedule();
        vm.expectRevert("schedule exists");
        _schedule();
    }

    function testOnlyEmployerCreates() public {
        vm.prank(address(0xBAD));
        vm.expectRevert("not employer");
        vault.createSchedule(alice, 1_000_000, uint64(block.timestamp), uint64(block.timestamp), 100);
    }

    function testReleaserRotation() public {
        uint256 t0 = block.timestamp;
        _schedule();
        vm.warp(t0 + 200);

        address newAgent = address(0xBEEF);
        vault.setReleaser(newAgent);

        // The old releaser is no longer authorized; the new one is.
        vm.prank(agent);
        vm.expectRevert("not authorized");
        vault.release(alice);
        vm.prank(newAgent);
        vault.release(alice);
        assertEq(usdc.balanceOf(alice), 1_000_000);
    }

    function testOnlyEmployerSetsReleaser() public {
        vm.prank(address(0xBAD));
        vm.expectRevert("not employer");
        vault.setReleaser(address(0xBEEF));
    }
}
