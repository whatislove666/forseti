# Integrate Forseti into a market

Forseti only decides outcomes. Your market keeps its own trading, custody and payout logic and asks Forseti one question at the end: what was the final answer for this commitment hash?

Integration takes three steps, plus a few rules your market must follow so that nobody can trade on a known outcome (see Rules for your market below).

## 1. Seal the judge when you list the market

Call `create_market` on the NEAR contract with the market's terms (see [Write a market](write-a-market.md) for every field). Attach 2 NEAR, which pays for the market's storage on NEAR.

With the executor, `node --env-file=../.env forseti.mjs create markets/berlin.json` does this and prints the new market's id and commitment hash. From your own code:

```js
// near-kit, the library our executor uses
const tx = await near.transaction(creator)
  .functionCall('forseti.testnet', 'create_market', { params }, { gas: '100 Tgas', attachedDeposit: '2 NEAR' })
  .send();
const id = JSON.parse(Buffer.from(tx.status.SuccessValue, 'base64'));
const { commitment_hash } = await near.view('forseti.testnet', 'get_market', { id });
```

`commitment_hash` is `0x` plus 64 hex characters. Store it next to your market. It is the only thing your contract needs to know about Forseti, and it changes if any part of the terms changes, so traders can check that the market they see is the one that was sealed.

Show traders the sealed terms, or link to the market on the Forseti page, so they can read the rules and ask the judge before they trade.

## 2. Read the final answer on your chain

### On an EVM chain

`Forseti.sol` stores verdicts that NEAR signed through Chain Signatures. It has no owner and cannot be upgraded; the only address it trusts is the signer derived from the NEAR contract account `forseti.testnet`. That account is therefore the trust root: on testnet it still has a full-access key, which could also ask Chain Signatures for any signature (see [what is still trusted](verification.md)).

```solidity
interface IForseti {
    enum Outcome { None, Yes, No, Invalid }
    struct Verdict { Outcome outcome; uint32 round; }
    function verdictOf(bytes32 commitmentHash) external view returns (Verdict memory);
}

contract MyMarket {
    IForseti public immutable forseti;
    bytes32 public immutable commitmentHash;

    constructor(IForseti forseti_, bytes32 commitmentHash_) {
        forseti = forseti_;
        commitmentHash = commitmentHash_;
    }

    function settle() external {
        IForseti.Outcome o = forseti.verdictOf(commitmentHash).outcome;
        require(o != IForseti.Outcome.None, "no verdict yet");
        if (o == IForseti.Outcome.Invalid) {
            // refund every stake
        } else {
            // pay the Yes or No side
        }
    }
}
```

`DemoMarkets.sol` in `evm/src/` is a complete pari-mutuel example that follows the rules below: winners split the pool, Invalid refunds everyone, and stakes come back if no verdict arrives within 7 days of the close.

On Base Sepolia the verifier is [`0x3745…2121`](https://sepolia.basescan.org/address/0x374541e22a7406E8246D0774E8994fc358232121). For another EVM chain, deploy `evm/src/Forseti.sol` with the signer `0xD5f2B07870279Fd733eDadFB1e49b9Fe1f3e26e8`. The signature has no chain id in it, so the same verdict is accepted on every chain.

If you prefer not to depend on our deployment, check the signature yourself: recover the EIP-712 digest below with `ecrecover` and compare it with the signer address.

```
domain:  { name: "Forseti", version: "1" }            // no chainId, no verifyingContract
type:    Verdict(bytes32 commitmentHash, uint8 outcome, uint32 round)
outcome: 1 = Yes, 2 = No, 3 = Invalid
```

### On NEAR

Call `get_market(id)` from your contract or app. When `phase` is `Final`, `outcome` holds the answer and `evm_signature` holds the signature other chains use.

### Anywhere else

Every final verdict is a signed message from one secp256k1 key, so any chain or app that can run `ecrecover` can check it. Native support for chains that use other signatures is on the [roadmap](roadmap.md).

## 3. Deliver the verdict

After the challenge period anyone can call `finalize` on NEAR and then relay the signature to your chain:

```
node --env-file=../.env forseti.mjs finalize <id>
node --env-file=../.env relay.mjs <id> <Forseti.sol address> [rpc url]
```

Relaying needs no permission: `Forseti.sol` accepts the verdict only if the NEAR signature checks out, and only once per market. Your keeper, a trader who wants to be paid, or our executor can do it.

## Resolving a market that already exists

Forseti can also judge a market listed somewhere else. Write a commitment with the same question and rules adapted to sources the judge can read. The replays on the [markets page](#/markets) do this for real Polymarket, Kalshi and Manifold markets that have already settled, with the original deadline written into the rules: each shows the platform's own outcome next to Forseti's verdict, with every check runnable in the browser.

## Rules for your market

Forseti tells you the outcome; keeping trading fair around it is your contract's job. The first version of our own demo contract skipped these and could be drained, so they are not optional:

- **Close trading at `resolve_after`.** Set your market's close time from the sealed deadline, and let only your operator open a market.
- **Reject trades once a verdict exists.** Check `verdictOf(commitmentHash).outcome == None` in every trade, so nobody bets after the answer is public on NEAR or on your chain.
- **Pay from frozen pools.** Compute payouts from totals that stop changing when trading closes.
- **Bind the hash at creation.** Store the commitment hash when you list the market, and show traders the sealed terms (or link to the market page) so they can check them.
- **Plan for no verdict.** Refund stakes if no verdict arrives some time after the close, in case nobody finalizes or relays.
- **Check the verifier.** Before trusting a `Forseti.sol` deployment, check that `signer()` is `0xD5f2B07870279Fd733eDadFB1e49b9Fe1f3e26e8`.
- **Accept round 0.** A market that expires without a verdict settles Invalid in round 0; don't require `round > 0`.

## Costs

- On NEAR: 2 NEAR at creation for storage, plus gas for each step (a ruling with snapshots costs well under 0.1 NEAR on testnet).
- Model fees on NEAR AI Cloud: a fraction of a cent per answer.
- On the EVM chain: one `submitVerdict` transaction per market, paid by whoever relays.
