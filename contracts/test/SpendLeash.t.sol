// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SpendLeash} from "../src/SpendLeash.sol";
import {MockUSD8} from "../src/mocks/MockUSD8.sol";

contract SpendLeashTest is Test {
    MockUSD8 token;
    SpendLeash leash;

    address owner = makeAddr("owner");
    address merchant = makeAddr("merchant");
    address evil = makeAddr("evil");
    address relayer = makeAddr("relayer");
    address agent;
    uint256 agentKey;

    bytes32 sid;

    uint96 constant PER = 1e6; // 1 tUSD8 per call
    uint96 constant DAY = 3e6;
    uint96 constant TOTAL = 5e6;

    function setUp() public {
        vm.warp(1_800_000_000);
        (agent, agentKey) = makeAddrAndKey("agent");
        token = new MockUSD8();
        leash = new SpendLeash(IERC20(address(token)));
        token.mint(owner, 100e6);

        vm.startPrank(owner);
        token.approve(address(leash), 10e6);
        leash.deposit(10e6);
        address[] memory ms = new address[](1);
        ms[0] = merchant;
        sid = leash.openSession(
            agent,
            SpendLeash.Limits({
                perPaymentCap: PER, dailyCap: DAY, totalCap: TOTAL, validUntil: uint40(block.timestamp + 7 days)
            }),
            ms
        );
        vm.stopPrank();
    }

    function _intent(address to, uint256 amount, bytes32 nonce) internal view returns (SpendLeash.PaymentIntent memory) {
        return SpendLeash.PaymentIntent({
            sessionId: sid,
            merchant: to,
            amount: amount,
            ref: keccak256("GET /v1/quote"),
            nonce: nonce,
            deadline: block.timestamp + 5 minutes
        });
    }

    function _sign(SpendLeash.PaymentIntent memory i, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, leash.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    function _pay(uint256 amount, bytes32 nonce) internal {
        SpendLeash.PaymentIntent memory i = _intent(merchant, amount, nonce);
        bytes memory sig = _sign(i, agentKey);
        vm.prank(relayer);
        leash.pay(i, sig);
    }

    function _expectFail(SpendLeash.PaymentIntent memory i, bytes memory sig, bytes4 err) internal {
        assertEq(leash.check(i, sig), err, "check() disagrees with pay()");
        vm.prank(relayer);
        vm.expectRevert(err);
        leash.pay(i, sig);
    }

    // ───────── happy path ─────────

    function test_pay_movesFundsToMerchant_relayerNeedsNothing() public {
        SpendLeash.PaymentIntent memory i = _intent(merchant, PER, bytes32("n1"));
        bytes memory sig = _sign(i, agentKey);
        assertEq(leash.check(i, sig), bytes4(0));

        vm.expectEmit(true, true, true, true, address(leash));
        emit SpendLeash.Paid(sid, merchant, agent, owner, PER, i.ref, i.nonce);
        vm.prank(relayer);
        leash.pay(i, sig);

        assertEq(token.balanceOf(merchant), PER);
        assertEq(leash.balanceOf(owner), 10e6 - PER);
        assertEq(token.balanceOf(agent), 0);
        SpendLeash.Session memory s = leash.getSession(sid);
        assertEq(s.spentTotal, PER);
        assertEq(s.spentToday, PER);
    }

    function test_remaining_tracksAllLimits() public {
        (uint256 per, uint256 today, uint256 total) = leash.remaining(sid);
        assertEq(per, PER);
        assertEq(today, DAY);
        assertEq(total, TOTAL);
        _pay(PER, "a");
        _pay(PER, "b");
        (per, today, total) = leash.remaining(sid);
        assertEq(today, DAY - 2 * PER);
        assertEq(total, TOTAL - 2 * PER);
    }

    // ───────── every limit holds ─────────

    function test_rejects_overPerPaymentCap() public {
        SpendLeash.PaymentIntent memory i = _intent(merchant, PER + 1, "n");
        _expectFail(i, _sign(i, agentKey), SpendLeash.PerPaymentCapExceeded.selector);
    }

    function test_rejects_overDailyCap_thenResetsNextDay() public {
        _pay(PER, "1");
        _pay(PER, "2");
        _pay(PER, "3");
        SpendLeash.PaymentIntent memory i = _intent(merchant, 1, "4");
        _expectFail(i, _sign(i, agentKey), SpendLeash.DailyCapExceeded.selector);

        vm.warp(block.timestamp + 1 days);
        _pay(PER, "4");
        assertEq(leash.getSession(sid).spentToday, PER);
    }

    function test_rejects_overTotalCap_acrossDays() public {
        _pay(PER, "1");
        _pay(PER, "2");
        _pay(PER, "3");
        vm.warp(block.timestamp + 1 days);
        _pay(PER, "4");
        _pay(PER, "5");
        SpendLeash.PaymentIntent memory i = _intent(merchant, 1, "6");
        _expectFail(i, _sign(i, agentKey), SpendLeash.TotalCapExceeded.selector);
    }

    function test_rejects_merchantNotOnAllowlist_promptInjection() public {
        // The agent was tricked into "paying" an attacker. It even signed it. The chain still says no.
        SpendLeash.PaymentIntent memory i = _intent(evil, PER, "n");
        _expectFail(i, _sign(i, agentKey), SpendLeash.MerchantNotAllowed.selector);
        assertEq(token.balanceOf(evil), 0);
    }

    function test_rejects_replay() public {
        SpendLeash.PaymentIntent memory i = _intent(merchant, PER, "same");
        bytes memory sig = _sign(i, agentKey);
        vm.prank(relayer);
        leash.pay(i, sig);
        _expectFail(i, sig, SpendLeash.NonceAlreadyUsed.selector);
    }

    function test_rejects_wrongSigner() public {
        (, uint256 otherKey) = makeAddrAndKey("other");
        SpendLeash.PaymentIntent memory i = _intent(merchant, PER, "n");
        _expectFail(i, _sign(i, otherKey), SpendLeash.BadSignature.selector);
    }

    function test_rejects_tamperedAmountOrMerchant() public {
        SpendLeash.PaymentIntent memory i = _intent(merchant, PER / 2, "n");
        bytes memory sig = _sign(i, agentKey);
        i.amount = PER; // relayer bumps the amount
        _expectFail(i, sig, SpendLeash.BadSignature.selector);
    }

    function test_rejects_afterRevoke_sameBlock() public {
        SpendLeash.PaymentIntent memory i = _intent(merchant, PER, "n");
        bytes memory sig = _sign(i, agentKey);
        vm.prank(owner);
        leash.revoke(sid);
        _expectFail(i, sig, SpendLeash.SessionIsRevoked.selector);
        (uint256 per,,) = leash.remaining(sid);
        assertEq(per, 0);
    }

    function test_rejects_expiredSession() public {
        vm.warp(block.timestamp + 7 days + 1);
        SpendLeash.PaymentIntent memory i = _intent(merchant, PER, "n");
        _expectFail(i, _sign(i, agentKey), SpendLeash.SessionExpired.selector);
    }

    function test_rejects_expiredIntent() public {
        SpendLeash.PaymentIntent memory i = _intent(merchant, PER, "n");
        bytes memory sig = _sign(i, agentKey);
        vm.warp(i.deadline + 1);
        _expectFail(i, sig, SpendLeash.IntentExpired.selector);
    }

    function test_rejects_whenOwnerWithdrewFunds() public {
        vm.prank(owner);
        leash.withdraw(10e6);
        SpendLeash.PaymentIntent memory i = _intent(merchant, PER, "n");
        _expectFail(i, _sign(i, agentKey), SpendLeash.InsufficientDeposit.selector);
    }

    // ───────── owner-only controls ─────────

    function test_onlyOwner_canRevokeOrEditMerchants() public {
        vm.expectRevert(SpendLeash.NotOwner.selector);
        vm.prank(agent);
        leash.revoke(sid);

        address[] memory ms = new address[](1);
        ms[0] = evil;
        vm.expectRevert(SpendLeash.NotOwner.selector);
        vm.prank(agent);
        leash.setMerchants(sid, ms, true);
    }

    function test_openSession_validatesLimits() public {
        address[] memory ms = new address[](0);
        vm.startPrank(owner);
        vm.expectRevert(SpendLeash.BadLimits.selector);
        leash.openSession(agent, SpendLeash.Limits(2, 1, 5, uint40(block.timestamp + 1)), ms);
        vm.expectRevert(SpendLeash.BadLimits.selector);
        leash.openSession(agent, SpendLeash.Limits(1, 1, 5, uint40(block.timestamp)), ms);
        vm.stopPrank();
    }

    function test_sessionIds_unique() public {
        address[] memory ms = new address[](0);
        vm.prank(owner);
        bytes32 sid2 = leash.openSession(agent, SpendLeash.Limits(1, 1, 1, uint40(block.timestamp + 1)), ms);
        assertTrue(sid2 != sid);
    }

    // ───────── fuzz: no sequence of payments ever exceeds the caps ─────────

    function testFuzz_neverExceedsCaps(uint96[8] memory amounts, uint8[8] memory dayJumps) public {
        uint256 paid;
        for (uint256 k; k < 8; ++k) {
            vm.warp(block.timestamp + uint256(dayJumps[k] % 2) * 1 days);
            uint256 amt = bound(amounts[k], 1, 2e6);
            SpendLeash.PaymentIntent memory i = _intent(merchant, amt, bytes32(k + 1));
            bytes memory sig = _sign(i, agentKey);
            if (leash.check(i, sig) == bytes4(0)) {
                vm.prank(relayer);
                leash.pay(i, sig);
                paid += amt;
                assertLe(amt, PER);
            }
        }
        assertLe(paid, TOTAL);
        assertEq(token.balanceOf(merchant), paid);
        assertLe(leash.getSession(sid).spentToday, DAY);
    }
}
