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
5. Run `node --env-file=../.env attest.mjs` in `executor/`. For each panel model you see the checks behind
   its signing key: Intel TDX quote valid (dcap-qvl), `report_data` binds the key and our fresh nonce, the
   docker compose hash matches `mr_config`, and the NVIDIA NRAS verdict (shown as SKIP when NVIDIA blocks
   your network). `--register` adds only fully checked keys to the contract.

### Live on NEAR testnet

The contract runs at [`forseti.testnet`](https://testnet.nearblocks.io/address/forseti.testnet). Its
Chain Signatures EVM signer (path `verdict-v1`) is `0xD5f2B07870279Fd733eDadFB1e49b9Fe1f3e26e8`.

On Base Sepolia (deployed with `evm/deploy.sh`):
- `Forseti.sol` verifier: [`0x374541e22a7406E8246D0774E8994fc358232121`](https://sepolia.basescan.org/address/0x374541e22a7406E8246D0774E8994fc358232121), `signer()` returns the address above
- `DemoMarkets.sol`: [`0x9E6edEA194B835c6D100968FF5E8d5eaac3C8692`](https://sepolia.basescan.org/address/0x9E6edEA194B835c6D100968FF5E8d5eaac3C8692)

The executor (`executor/forseti.mjs`) drives a market end to end. Each step saves a proof bundle in
`executor/proofs/`: sources, snapshots, the exact request and response, the TEE signature and the tx.

```
node --env-file=../.env forseti.mjs create markets/berlin.json   # commit the judge, 1 NEAR deposit
node --env-file=../.env forseti.mjs preview <id>                 # "ask the judge" before the deadline
node --env-file=../.env forseti.mjs resolve <id>                 # after the deadline: round + verdict
node --env-file=../.env forseti.mjs appeal <id>                  # optional: bond -> panel
node --env-file=../.env forseti.mjs panel <id>                   # the three panel models vote
node --env-file=../.env forseti.mjs finalize <id>                # settle + MPC signature for EVM
node --env-file=../.env verify-evm.mjs <id>                      # recover the signer like an EVM chain
node --env-file=../.env relay.mjs <id> <Forseti.sol> [rpc]       # submit the verdict on an EVM chain
```

Recorded run, market 0 ("Is the current air temperature in Berlin above 0 °C according to Open-Meteo?"),
Nov 6 2026. Open any transaction on testnet.nearblocks.io to see the arguments and the contract's events:

| Step | Transaction | What the contract checked |
|---|---|---|
| Ask the judge (preview) | [`CnkJPPdx…`](https://testnet.nearblocks.io/txns/CnkJPPdxDP6sxZnBNcz7wZQPQDktLqz6UYvXAsLM95DN) | request rebuilt on-chain, ed25519 TEE signature of glm-5.3-flash, quote `"temperature_2m":6.1` found in the snapshot |
| Open round | [`2eS9B8Cc…`](https://testnet.nearblocks.io/txns/2eS9B8CcSFpLC7rbxRF21HfSayzi43tXMogda8KEMRaj) | deadline passed, nonce drawn from the block's random seed |
| Verdict YES | [`2nfcusbh…`](https://testnet.nearblocks.io/txns/2nfcusbhQtk1kmE67ioih56FbSWFTXq9yaWrPubxZgfF) | same checks, with the round nonce inside the signed request |
| Finalize + MPC signature | [`2Yib5c8w…`](https://testnet.nearblocks.io/txns/2Yib5c8wqrhwGEUnvSZs4oY25bpLxgE2wxRde1hdQimD) | challenge period over; `v1.signer-prod.testnet` signed digest `0xcb44c710…631e` |

`verify-evm.mjs 0` recovers `0xD5f2B07870279Fd733eDadFB1e49b9Fe1f3e26e8` from that signature. `relay.mjs`
then recorded the verdict on Base Sepolia:
[`0xafea4cdc…`](https://sepolia.basescan.org/tx/0xafea4cdc4283ffebd109f7b30bc2a4785f64631cb439a0cdd53d7026c042bdc6).
To check it yourself, run
`cast call 0x374541e22a7406E8246D0774E8994fc358232121 "verdictOf(bytes32)((uint8,uint32))" 0xe2d9227ac516e8a0e766344d21542b4365786c48fb354b3980061eefe25bd1ef --rpc-url https://sepolia.base.org`.
You see `(1, 1)`: YES, round 1. The proof bundles are in `executor/proofs/`.

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
