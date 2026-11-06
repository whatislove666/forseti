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
}
