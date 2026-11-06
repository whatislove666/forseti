// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Forseti verdicts on an EVM chain
/// @notice Stores final verdicts of the Forseti contract on NEAR. The NEAR contract signs each
/// verdict through Chain Signatures; this contract only checks that signature. No owner, no
/// upgrades: the signer address is fixed at deployment.
contract Forseti {
    enum Outcome { None, Yes, No, Invalid }

    struct Verdict {
        Outcome outcome;
        uint32 round;
    }

    /// EIP-712 domain without chainId or verifyingContract, so one signature is valid on every chain.
    bytes32 public constant DOMAIN_SEPARATOR = keccak256(
        abi.encode(keccak256("EIP712Domain(string name,string version)"), keccak256("Forseti"), keccak256("1"))
    );
    bytes32 public constant VERDICT_TYPEHASH = keccak256("Verdict(bytes32 commitmentHash,uint8 outcome,uint32 round)");

    /// Address derived from the NEAR contract account and the path "verdict-v1".
    address public immutable signer;
    mapping(bytes32 => Verdict) private verdicts;

    event VerdictRecorded(bytes32 indexed commitmentHash, Outcome outcome, uint32 round);

    error BadOutcome();
    error BadSignature();
    error AlreadyRecorded();

    constructor(address signer_) {
        signer = signer_;
    }

    function digest(bytes32 commitmentHash, uint8 outcome, uint32 round) public pure returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(VERDICT_TYPEHASH, commitmentHash, outcome, round));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    /// @notice Anyone can relay a verdict. v may be 0/1 (MPC recovery id) or 27/28.
    function submitVerdict(bytes32 commitmentHash, uint8 outcome, uint32 round, uint8 v, bytes32 r, bytes32 s) external {
        if (outcome < 1 || outcome > 3) revert BadOutcome();
        if (verdicts[commitmentHash].outcome != Outcome.None) revert AlreadyRecorded();
        if (v < 27) v += 27;
        address recovered = ecrecover(digest(commitmentHash, outcome, round), v, r, s);
        if (recovered == address(0) || recovered != signer) revert BadSignature();
        verdicts[commitmentHash] = Verdict(Outcome(outcome), round);
        emit VerdictRecorded(commitmentHash, Outcome(outcome), round);
    }

    function verdictOf(bytes32 commitmentHash) external view returns (Verdict memory) {
        return verdicts[commitmentHash];
    }
}
