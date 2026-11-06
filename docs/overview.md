# Overview

Forseti is a resolution layer for prediction markets. A market seals its AI judge before the first trade: the model, its instructions, the sources it may read and the three models that hear appeals. After the deadline the NEAR contract checks that this exact judge answered this exact question, and the final answer is signed once for every EVM chain.

Forseti does not run an exchange, an order book or a token. Any prediction market on an EVM chain, or anywhere a secp256k1 signature can be checked, can use it in place of a token vote or a team that settles by hand.

## Why

Most crypto prediction markets settle disputes by token vote. On Polymarket that is UMA: holders of the UMA token vote on the outcome, and many active voters can be linked to trading accounts on the same platform. Settling by hand is faster but asks traders to trust the operator.

An AI judge is cheaper and quicker than both, but only if traders can answer three questions:

1. Which model will decide, with which instructions, reading which sources?
2. Did that model really answer, and was it asked the right question?
3. If it gets it wrong, what happens?

Forseti answers the first by sealing the judge before trading, the second with signatures from secure hardware that NEAR checks, and the third with an appeal to a fixed panel of three models.

## The life of a market

| Step | Who | What happens |
|---|---|---|
| Seal | Market creator | `create_market` stores the question, rules, model, system prompt, sources, seed, appeal panel, deadlines and appeal bond. The sha256 of this commitment (these terms plus the market id and creator) is the market's **commitment hash**, which other chains use as its id. |
| Ask the judge | Anyone, before the deadline | Runs the sealed judge on today's sources and records a signed, non-binding answer. Traders see how the judge reads the rules before they bet. |
| Open a round | Anyone, after the deadline | The contract draws a nonce from the block's random seed, so a verdict cannot be prepared in advance. |
| Verdict | Any executor | Fetches the sources, gets the exact request from the contract, asks the model on NEAR AI Cloud and submits the answer with its TEE signature. The contract rebuilds the request, checks the signature and finds the quoted evidence in the source. The answer becomes the proposal, Too early included. |
| Challenge | Anyone, during the challenge period | An appeal with a bond, or a second signed answer that disagrees, sends the market to the panel. An unchallenged Too early lets anyone open a new round. |
| Panel | Anyone, for one more challenge period | Each of the three sealed models votes once, asked with a nonce of its own. A second signed vote for a seat with a different outcome contests that seat, which then counts as Invalid. After the window the majority decides. |
| Finalize | Anyone, after the challenge period | The contract settles Yes, No or Invalid and asks NEAR Chain Signatures to sign one EIP-712 message for it. |
| Deliver | Anyone | Relays the signature to `Forseti.sol` on an EVM chain. The market there reads `verdictOf(commitmentHash)` and pays out. |

## Words used in these docs

- **Commitment**: everything the creator fixes at creation. It never changes.
- **Seal**: the picture drawn from the commitment hash. Change one character of the rules and the seal changes.
- **Snapshot**: the plain text of a source as the judge saw it. Its sha256 is stored with every ruling.
- **Ruling**: one signed answer: a preview, a verdict or a panel vote.
- **Panel**: the three different models named in the commitment that decide appeals by majority.
- **Executor**: whoever fetches the sources and submits a ruling. The contract checks its signature, request and quote; it is still trusted to fetch honest copies of the sources, and anyone who sees a forged copy can appeal or contest it. See [how a verdict is checked](verification.md).

## What runs today

- The NEAR contract [`forseti.testnet`](https://testnet.nearblocks.io/address/forseti.testnet) (Rust, near-sdk 5.29).
- NEAR AI Cloud models in Intel TDX and NVIDIA confidential computing: GLM 5.3 Flash as the judge, two Qwen models joining it on the panel. Their keys were registered after checking the Intel TDX evidence; NVIDIA's own verdict could not be fetched from our network.
- NEAR Chain Signatures (`v1.signer-prod.testnet`) signing final verdicts.
- `Forseti.sol` and a demo betting contract on Base Sepolia.
- A web page that re-runs every check in the browser, with no Forseti server in between.
- Replays of 27 real Polymarket, Kalshi and Manifold markets, five of them disputed on their platform.

Next: [Integrate Forseti into a market](integrate.md).
