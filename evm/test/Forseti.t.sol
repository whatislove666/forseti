// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Forseti} from "../src/Forseti.sol";
import {DemoMarkets} from "../src/DemoMarkets.sol";

interface Vm {
    function sign(uint256 pk, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 pk) external returns (address);
    function warp(uint256 t) external;
    function deal(address who, uint256 amount) external;
    function prank(address who) external;
    function expectRevert(bytes4 selector) external;
}

contract ForsetiTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant MPC_KEY = 0xA11CE; // stands in for the NEAR MPC key in tests
    // Same vector as the Rust test `digest_matches_viem_hash_typed_data` (from viem hashTypedData).
    bytes32 constant C = 0x0a9e7612b74280d6ae82c8479817e0be480ffaa3b7ce2126362692937caf439a;

    Forseti judge;
    DemoMarkets markets;

    function setUp() public {
        judge = new Forseti(vm.addr(MPC_KEY));
        markets = new DemoMarkets(judge);
    }

    function sign(bytes32 c, uint8 outcome, uint32 round) internal returns (uint8 v, bytes32 r, bytes32 s) {
        (v, r, s) = vm.sign(MPC_KEY, judge.digest(c, outcome, round));
    }

    function testDigestMatchesRustAndViem() public view {
        require(judge.digest(C, 1, 1) == 0x0f2be5b5638981a2e5b73482795552b6a52137b572b7631e91e3926608c009dc, "digest 1");
        require(judge.digest(C, 3, 2) == 0xe0a0b93e6738032f9e5415cf95a4dd706bd2ddd1c98d1fb1671f9df15e3194d1, "digest 2");
    }

    function testRecordsSignedVerdictWithMpcRecoveryId() public {
        (uint8 v, bytes32 r, bytes32 s) = sign(C, 1, 1);
        judge.submitVerdict(C, 1, 1, v - 27, r, s); // MPC returns recovery id 0/1
        Forseti.Verdict memory got = judge.verdictOf(C);
        require(got.outcome == Forseti.Outcome.Yes && got.round == 1, "verdict");
    }

    function testRejectsChangedOutcome() public {
        (uint8 v, bytes32 r, bytes32 s) = sign(C, 1, 1);
        vm.expectRevert(Forseti.BadSignature.selector);
        judge.submitVerdict(C, 2, 1, v, r, s);
    }

    function testRejectsOtherSigner() public {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xB0B, judge.digest(C, 1, 1));
        vm.expectRevert(Forseti.BadSignature.selector);
        judge.submitVerdict(C, 1, 1, v, r, s);
    }

    function testVerdictIsWriteOnce() public {
        (uint8 v, bytes32 r, bytes32 s) = sign(C, 1, 1);
        judge.submitVerdict(C, 1, 1, v, r, s);
        vm.expectRevert(Forseti.AlreadyRecorded.selector);
        judge.submitVerdict(C, 1, 1, v, r, s);
    }

    function testRejectsOutcomeZero() public {
        (uint8 v, bytes32 r, bytes32 s) = sign(C, 0, 1);
        vm.expectRevert(Forseti.BadOutcome.selector);
        judge.submitVerdict(C, 0, 1, v, r, s);
    }

    function _bets() internal returns (address alice, address bob) {
        alice = address(0xA1);
        bob = address(0xB2);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        markets.open(C, uint64(block.timestamp + 1 hours));
        vm.prank(alice);
        markets.bet{value: 1 ether}(C, true);
        vm.prank(bob);
        markets.bet{value: 3 ether}(C, false);
        vm.warp(block.timestamp + 2 hours);
    }

    function testWinnerTakesThePool() public {
        (address alice, address bob) = _bets();
        vm.expectRevert(DemoMarkets.NoVerdict.selector);
        markets.payout(C, alice);
        (uint8 v, bytes32 r, bytes32 s) = sign(C, 1, 1);
        judge.submitVerdict(C, 1, 1, v, r, s);
        vm.prank(alice);
        markets.claim(C);
        require(alice.balance == 13 ether, "alice gets the whole 4 ETH pool");
        vm.expectRevert(DemoMarkets.NothingToClaim.selector);
        vm.prank(bob);
        markets.claim(C);
    }

    function testInvalidRefundsEveryone() public {
        (address alice, address bob) = _bets();
        (uint8 v, bytes32 r, bytes32 s) = sign(C, 3, 2);
        judge.submitVerdict(C, 3, 2, v, r, s);
        vm.prank(alice);
        markets.claim(C);
        vm.prank(bob);
        markets.claim(C);
        require(alice.balance == 10 ether && bob.balance == 10 ether, "refunds");
    }

    function testNoBetsAfterClose() public {
        _bets();
        vm.expectRevert(DemoMarkets.Closed.selector);
        markets.bet{value: 1}(C, true);
    }

    function record(bytes32 c, uint8 outcome) internal {
        (uint8 v, bytes32 r, bytes32 s) = sign(c, outcome, 1);
        judge.submitVerdict(c, outcome, 1, v, r, s);
    }

    function testOnlyOperatorOpens() public {
        require(markets.operator() == address(this), "deployer is operator");
        vm.expectRevert(DemoMarkets.NotOperator.selector);
        vm.prank(address(0xE7E));
        markets.open(C, uint64(block.timestamp + 1 hours));
    }

    // Audit C-1 PoC testDrainOtherMarkets: bets on a decided hash are refused, so the drain never starts.
    function testDrainPocReverts() public {
        bytes32 other = keccak256("honest market");
        markets.open(other, uint64(block.timestamp + 1 days));
        address u = address(0xBEEF);
        vm.deal(u, 10 ether);
        vm.prank(u);
        markets.bet{value: 10 ether}(other, false);

        bytes32 h = keccak256("decided market");
        record(h, 1); // already decided YES
        address a1 = address(0xA1);
        vm.deal(a1, 1 wei);
        vm.expectRevert(DemoMarkets.NotOperator.selector);
        vm.prank(a1);
        markets.open(h, type(uint64).max);
        markets.open(h, type(uint64).max); // even if the operator opens a decided hash
        vm.expectRevert(DemoMarkets.Closed.selector);
        vm.prank(a1);
        markets.bet{value: 1 wei}(h, true);
        require(address(markets).balance == 10 ether, "other market's escrow intact");
    }

    // Audit C-1 PoC testRefundHijack: a 1-wei bet on the known winner is refused; bob keeps his refund.
    function testRefundHijackPocReverts() public {
        markets.open(C, uint64(block.timestamp + 30 days));
        address bob = address(0xB0B);
        vm.deal(bob, 3 ether);
        vm.prank(bob);
        markets.bet{value: 3 ether}(C, false);
        record(C, 1); // YES, nobody bet YES
        address eve = address(0xE7E);
        vm.deal(eve, 1 wei);
        vm.expectRevert(DemoMarkets.Closed.selector);
        vm.prank(eve);
        markets.bet{value: 1 wei}(C, true);
        vm.prank(bob);
        markets.claim(C);
        require(bob.balance == 3 ether, "bob refunded");
    }

    function testRefundOnlyAfterTimeout() public {
        (address alice, address bob) = _bets();
        (uint64 closesAt,,) = markets.markets(C);
        uint256 refundAt = closesAt + markets.REFUND_AFTER();
        vm.warp(refundAt - 1);
        vm.expectRevert(DemoMarkets.NoVerdict.selector);
        markets.payout(C, alice);
        vm.expectRevert(DemoMarkets.NoVerdict.selector);
        vm.prank(alice);
        markets.claim(C);
        vm.warp(refundAt);
        require(markets.payout(C, alice) == 1 ether, "payout shows the refund");
        vm.prank(alice);
        markets.claim(C);
        vm.prank(bob);
        markets.claim(C);
        require(alice.balance == 10 ether && bob.balance == 10 ether, "refunds");
        vm.expectRevert(DemoMarkets.NothingToClaim.selector);
        vm.prank(alice);
        markets.claim(C);
    }

    // A verdict relayed after refunds began must not pay winnings out of stakes already refunded.
    function testLateVerdictAfterRefundKeepsRefunding() public {
        (address alice, address bob) = _bets();
        (uint64 closesAt,,) = markets.markets(C);
        vm.warp(closesAt + markets.REFUND_AFTER());
        vm.prank(bob);
        markets.claim(C); // bob takes his 3 ETH back
        record(C, 1); // YES arrives late
        require(markets.payout(C, alice) == 1 ether, "alice only gets her stake");
        vm.prank(alice);
        markets.claim(C);
        require(alice.balance == 10 ether && bob.balance == 10 ether && address(markets).balance == 0, "solvent");
    }

    function testLateVerdictBeforeAnyRefundSettlesNormally() public {
        (address alice,) = _bets();
        (uint64 closesAt,,) = markets.markets(C);
        vm.warp(closesAt + markets.REFUND_AFTER());
        record(C, 1);
        vm.prank(alice);
        markets.claim(C);
        require(alice.balance == 13 ether, "alice gets the whole 4 ETH pool");
    }
}
