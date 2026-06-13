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
}
