# Reference

## Deployments

| What | Where |
|---|---|
| Forseti contract | [`forseti.testnet`](https://testnet.nearblocks.io/address/forseti.testnet) on NEAR testnet |
| Chain Signatures | `v1.signer-prod.testnet`, path `verdict-v1`, domain 0 (secp256k1) |
| Verdict signer | `0xD5f2B07870279Fd733eDadFB1e49b9Fe1f3e26e8` |
| `Forseti.sol` | [`0x374541e22a7406E8246D0774E8994fc358232121`](https://sepolia.basescan.org/address/0x374541e22a7406E8246D0774E8994fc358232121) on Base Sepolia |
| `DemoMarkets.sol` | [`0x42297B4CddeC88CcF1aC989865Fd8e29570b3711`](https://sepolia.basescan.org/address/0x42297B4CddeC88CcF1aC989865Fd8e29570b3711) on Base Sepolia (v2: operator-only markets, no bets once a verdict exists, refunds 7 days after close without a verdict). The first version, [`0x9E6e…C8692`](https://sepolia.basescan.org/address/0x9E6edEA194B835c6D100968FF5E8d5eaac3C8692), holds the bets of markets 1 and 3 and is retired: it accepted bets after the verdict. |
| Models | `z-ai/glm-5.3-flash` (judge), `Qwen/Qwen3.6-35B-A3B-FP8`, `Qwen/Qwen3.8-27B` (panel) on NEAR AI Cloud |

## Outcomes

| Code | Outcome | Meaning |
|---|---|---|
| 1 | Yes | |
| 2 | No | |
| 3 | Invalid | The question cannot be settled as written, or the market expired. Markets refund. |
| 4 | Too early | Only in rulings: the event has not happened yet. It is proposed like any answer and can be challenged; if nobody challenges it, anyone can open a new round after the challenge period. Never final. |

## Phases

`Open` → `Resolving` → `Proposed` → `Final`, with `Disputed` between `Proposed` and `Final` after an appeal or a conflicting answer. A Too early proposal that nobody challenges goes back to `Resolving` when anyone opens the next round. After `resolve_by`, a market still waiting for a verdict, or whose panel has no majority, goes to `Final` as Invalid.

## NEAR contract methods

| Method | Who | Arguments | Notes |
|---|---|---|---|
| `create_market` | anyone, 2 NEAR | `params` | Returns the id. Every model in the commitment needs a registered key. |
| `get_market`, `get_markets`, `get_markets_count` | view | `id` / `from, limit` (max 50) | |
| `build_request` | view | `id, model, snapshots, preview` | The exact request body to send to NEAR AI. Send it byte for byte. |
| `rebuild_request` | view | `id, model, snapshots, nonce` | The request of any past ruling, for auditors. `nonce` is `"preview"`, the round nonce, or for panel votes the round nonce followed by `:panel` (panel votes before Nov 7 2026 used the plain round nonce). |
| `submit_preview` | anyone | `id, snapshots, response, signer, signature` | Before the deadline. Keeps the last 5; the same signed preview cannot be recorded twice. |
| `open_round` | anyone | `id` | After the deadline, or after an unchallenged Too early. Draws the round nonce. |
| `submit_ruling` | anyone | `id, model, snapshots, response, signer, signature` | The verdict (before `resolve_by`), a conflicting answer, a panel vote, or a second vote that contests a panel seat, depending on the phase. |
| `get_dispute` | view | `id` | When the panel started voting and any contesting votes. `null` if the market was never disputed. |
| `appeal` | anyone, bond | `id` | During the challenge period. |
| `finalize` | anyone | `id` | Settles and requests the MPC signature. Call again if signing failed. |
| `get_verdict_digest` | view | `id` | The 32 bytes the MPC network signs. |
| `add_signer`, `remove_signer` | owner | `model, public_key` | TEE key registry. |
| `get_signers` | view | `model` | |

Events are logged as `EVENT_JSON` with the standard `forseti`: `market_created`, `preview`, `round_opened`, `too_early`, `proposed`, `disputed`, `panel_vote`, `panel_vote_contested`, `finalized`, `signed`, `signer_added`.

## Request format

The contract builds an OpenAI-compatible chat request with temperature 0: the sealed system prompt as the system message, and a user message with the question, the rules, the event deadline, the market id, the round nonce, every snapshot wrapped in `<source id="…" url="…">` tags, and a fixed answer format. The model must answer with one JSON object:

```json
{ "outcome": "YES", "source": "weather", "quote": "\"temperature_2m\":6.1", "reason": "…" }
```

## EVM verdict

```
EIP712Domain(string name,string version)  name = "Forseti", version = "1"
Verdict(bytes32 commitmentHash,uint8 outcome,uint32 round)
```

`Forseti.sol`:

| Function | Notes |
|---|---|
| `submitVerdict(commitmentHash, outcome, round, v, r, s)` | Anyone. `v` may be 0/1 or 27/28. Reverts on a wrong signer or a second write. |
| `verdictOf(commitmentHash)` | `(outcome, round)`. Outcome 0 means no verdict yet. |
| `digest(commitmentHash, outcome, round)` | The EIP-712 digest. |
| `signer()` | The fixed signer address. |

## Executor

Run from `executor/` with a `.env` in the repository root (see `.env.example`):

```
node --env-file=../.env forseti.mjs create markets/berlin.json   # seal a market, 2 NEAR
node --env-file=../.env forseti.mjs preview <id>                 # ask the judge before the deadline
node --env-file=../.env forseti.mjs resolve <id>                 # open a round and submit the verdict
node --env-file=../.env forseti.mjs appeal <id>                  # post the appeal bond
node --env-file=../.env forseti.mjs panel <id>                   # the panel votes
node --env-file=../.env forseti.mjs finalize <id>                # settle and get the MPC signature
node --env-file=../.env relay.mjs <id> <Forseti.sol> [rpc]       # deliver to an EVM chain
node --env-file=../.env attest.mjs [--register]                  # check TEE attestation, register keys
```

Every step writes a proof bundle to `executor/proofs/`: sources, snapshots, the exact request and response, the TEE signature and the transaction.
