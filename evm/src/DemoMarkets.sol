// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Forseti} from "./Forseti.sol";

/// @title Demo YES/NO pari-mutuel markets settled by Forseti
/// @notice One contract, many markets keyed by the Forseti commitment hash. Winners split the
/// pool pro rata; INVALID (or a pool nobody won) refunds every stake. If no verdict arrives
/// REFUND_AFTER the close, every stake is refunded instead. Testnet demo only.
contract DemoMarkets {
    struct Market {
        uint64 closesAt;
        uint256 yes;
        uint256 no;
    }

    /// Time after closesAt with no verdict after which bettors can take their stakes back.
    uint256 public constant REFUND_AFTER = 7 days;

    Forseti public immutable judge;
    /// The deployer. Only it opens markets, with closesAt = the NEAR market's resolve_after.
    address public immutable operator;
    mapping(bytes32 => Market) public markets;
    mapping(bytes32 => mapping(address => uint256)) public yesStake;
    mapping(bytes32 => mapping(address => uint256)) public noStake;
    mapping(bytes32 => mapping(address => bool)) public claimed;
    /// Set by the first timeout refund. From then on the market only refunds, even if a verdict
    /// arrives later, so refunds and winnings are never both paid from one pool.
    mapping(bytes32 => bool) public refunding;

    event Opened(bytes32 indexed commitmentHash, uint64 closesAt);
    event Bet(bytes32 indexed commitmentHash, address indexed bettor, bool yes, uint256 amount);
    event Claimed(bytes32 indexed commitmentHash, address indexed bettor, uint256 amount);

    error NotOperator();
    error AlreadyOpen();
    error NotOpen();
    error Closed();
    error NoVerdict();
    error NothingToClaim();

    constructor(Forseti judge_) {
        judge = judge_;
        operator = msg.sender;
    }

    /// @notice Opens betting on a Forseti market. Operator only; the close time is fixed once.
    function open(bytes32 commitmentHash, uint64 closesAt) external {
        if (msg.sender != operator) revert NotOperator();
        if (markets[commitmentHash].closesAt != 0) revert AlreadyOpen();
        if (closesAt <= block.timestamp) revert Closed();
        markets[commitmentHash].closesAt = closesAt;
        emit Opened(commitmentHash, closesAt);
    }

    /// @notice Betting stops at closesAt or as soon as the verdict is on-chain, whichever is first,
    /// so the pools are frozen before anyone can claim.
    function bet(bytes32 commitmentHash, bool yes) external payable {
        Market storage m = markets[commitmentHash];
        if (m.closesAt == 0) revert NotOpen();
        if (block.timestamp >= m.closesAt) revert Closed();
        if (judge.verdictOf(commitmentHash).outcome != Forseti.Outcome.None) revert Closed();
        if (yes) {
            m.yes += msg.value;
            yesStake[commitmentHash][msg.sender] += msg.value;
        } else {
            m.no += msg.value;
            noStake[commitmentHash][msg.sender] += msg.value;
        }
        emit Bet(commitmentHash, msg.sender, yes, msg.value);
    }

    /// @notice What `bettor` can claim (before checking `claimed`). Reverts NoVerdict while there
    /// is no verdict and the refund timeout has not passed.
    function payout(bytes32 commitmentHash, address bettor) public view returns (uint256) {
        Market memory m = markets[commitmentHash];
        uint256 y = yesStake[commitmentHash][bettor];
        uint256 n = noStake[commitmentHash][bettor];
        if (refunding[commitmentHash]) return y + n;
        Forseti.Outcome o = judge.verdictOf(commitmentHash).outcome;
        if (o == Forseti.Outcome.None) {
            if (block.timestamp < m.closesAt + REFUND_AFTER) revert NoVerdict();
            return y + n;
        }
        uint256 winPool = o == Forseti.Outcome.Yes ? m.yes : m.no;
        if (o == Forseti.Outcome.Invalid || winPool == 0) return y + n;
        return (o == Forseti.Outcome.Yes ? y : n) * (m.yes + m.no) / winPool;
    }

    function claim(bytes32 commitmentHash) external {
        uint256 amount = payout(commitmentHash, msg.sender);
        if (amount == 0 || claimed[commitmentHash][msg.sender]) revert NothingToClaim();
        claimed[commitmentHash][msg.sender] = true;
        if (judge.verdictOf(commitmentHash).outcome == Forseti.Outcome.None) refunding[commitmentHash] = true;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
        emit Claimed(commitmentHash, msg.sender, amount);
    }
}
