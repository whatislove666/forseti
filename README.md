# Forseti

A judge for prediction markets that is fixed before trading starts and checked on NEAR.

A market commits to a model, a system prompt, its sources and a three-model appeal panel. After the
event deadline the NEAR contract builds the exact request for the model, verifies the NEAR AI Cloud
TEE signature over that request and the answer, and checks that the quoted evidence is in the source
snapshot. The final verdict is signed once through Chain Signatures, and any EVM chain verifies it with
`ecrecover`.

Built at NEAR HACKATHON (Nov 1–14, 2026). Work in progress: this README only describes what runs today.

## Problem

Prediction markets settle disputes with token votes (UMA on Polymarket): large holders vote, often with
positions in the same market. Models can already settle most of these questions, but traders need to know
in advance which model will judge, on what sources, and be able to check afterwards that it really did.

## How it works

1. `create_market` stores the commitment: question, rules, model, system prompt, sources, seed, panel,
   deadlines, appeal bond. `commitment_hash = sha256(commitment JSON)` keys the market on other chains.
2. Before the deadline, anyone can "ask the judge": `submit_preview` records a signed, non-binding answer.
3. After the deadline, `open_round` draws a nonce from the block's random seed.
4. The executor fetches the sources, gets the exact request bytes from the `build_request` view, sends them
   to NEAR AI Cloud and fetches the ed25519 signature over `model:sha256(request):sha256(response)`.
5. `submit_ruling` rebuilds the request, checks the signature against the model's registered TEE keys,
   parses the answer and checks that the quote is in the cited snapshot.
6. During the challenge period, an appeal (with a bond) or a second signed answer with a different outcome
   sends the market to the committed panel. The panel decides by majority.
7. `finalize` settles the outcome (YES=1, NO=2, INVALID=3) and asks the MPC signer for an ECDSA signature
   over one EIP-712 digest: domain `{name:"Forseti", version:"1"}`, no chainId,
   `Verdict(bytes32 commitmentHash,uint8 outcome,uint32 round)`.
8. Anyone relays the signature to `Forseti.sol` on an EVM chain. `DemoMarkets.sol` pays out from it.

## Try it

Requirements: Rust (the toolchain in `contract/rust-toolchain.toml` installs itself through rustup),
Foundry, Node 20.6+.

1. Run `cd contract && cargo test`. You see 17 passing tests: the happy path (preview, verdict, finalize),
   rejection of a tampered response, a key of another model, an answer signed for other snapshots, a quote
   that is not in the snapshot and a snapshot that tries to escape its `<source>` tag, plus the panel,
   appeal, TOO_EARLY and expiry paths.
2. Run `cd evm && forge test`. You see 9 passing tests: the verifier accepts the MPC signature (recovery
   id 0/1 or 27/28), rejects a changed outcome, another signer and a second write, and the demo market pays
   winners or refunds on INVALID.
3. Both test suites assert the same EIP-712 digest vector, produced independently with viem's
   `hashTypedData`, so the NEAR contract and the EVM verifier agree on the bytes that get signed.
4. With a NEAR AI Cloud key in `.env` (copy `.env.example`), run `cd executor && npm i && npm run probe`.
   It fetches a model attestation with a fresh nonce, sends one completion and checks the model id, both
   hashes and the ed25519 signature.

## NEAR technology used

- **NEAR AI Cloud** (TEE inference): models run in Intel TDX + NVIDIA TEE and sign every response.
- **Smart contract on NEAR** (Rust, near-sdk 5.29): commitment registry, request builder, `ed25519_verify`
  of model signatures, quote check, appeals.
- **Chain Signatures** (`v1.signer-prod.testnet`): the contract signs the final verdict for EVM chains.

## Trust assumptions (MVP)

- The executor chooses the snapshots. Each ruling stores their sha256, and conflicting signed answers or
  appeals go to the panel, but a dishonest snapshot is not detected on-chain.
- The contract owner registers model TEE keys after checking attestation off-chain.
- Whoever can upgrade the NEAR contract can sign any verdict for every chain. After deployment the
  contract's full-access keys must be removed or put behind a timelock.

## Layout

- `contract/`: NEAR contract and unit tests
- `evm/`: `Forseti.sol` verifier, `DemoMarkets.sol`, Foundry tests
- `executor/`: NEAR AI probe (the full executor is next)

## License

MIT
