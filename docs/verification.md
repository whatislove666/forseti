# How a verdict is checked

Forseti checks everything the person who submits a verdict sends, except whether their copies of the sources are honest; the appeal and the panel cover that. Every ruling is checked by the NEAR contract when it arrives, and the web page checks it all again in your browser.

## On NEAR, for every ruling

When an executor calls `submit_preview` or `submit_ruling`, the contract:

1. **Rebuilds the request.** From the sealed commitment, the submitted snapshots and the nonce, it builds the exact JSON body that should have been sent to the model and hashes it. The nonce is `preview` for a preview, the round nonce for a verdict or a challenge, and the round nonce followed by `:panel` for a panel vote, so an answer given for one role can never be replayed in another.
2. **Checks the signature.** NEAR AI Cloud signs `model:sha256(request):sha256(response)` with an ed25519 key that lives inside the model's secure hardware. The contract checks that signature against the keys registered for that model.
3. **Reads the answer.** It parses the model's JSON answer: outcome, source id, quote and reason.
4. **Finds the quote.** For Yes and No, the quote must appear in the snapshot of the source the model cited. Whitespace is collapsed and typographic dashes and quotation marks count as their plain versions. A quote may leave text out with `...`, as quotes do: it may have at most 8 pieces, each of at least 8 characters and one of at least 16, and every piece must be in the snapshot word for word. A model that does not copy its evidence exactly is rejected; on testnet this happened to answers in markets 9, 22 and 29.
5. **Stores the evidence.** The ruling keeps the request hash, the response, the signature and the sha256 of every snapshot.

Because the round nonce comes from the block's random seed after the deadline, a verdict cannot be prepared before the round opens. Because the request is rebuilt on-chain, the executor cannot ask the model a different question.

## Disputes

- **Too early is a proposal like any other.** If the judge answers Too early, anyone can challenge it with a signed Yes or No during the challenge period; if nobody does, anyone can open a new round. Too early is never final, and no new proposal is accepted after `resolve_by`.
- **The panel takes a full window.** An appeal or a conflicting signed answer opens the panel for one more challenge period. Each of the three sealed models votes once, and the market cannot be finalized before the window ends, so nobody can dispute and settle a market in one block.
- **A forged vote can be contested.** A second signed vote for the same panel seat with a different outcome contests that seat, and a contested seat counts as Invalid. If an executor fills the panel with votes made from forged copies, anyone who sees it submits votes made from the real sources, and the market ends Invalid, with every stake refunded, instead of paying the forger.

## In your browser

**Check it yourself** on a market page re-runs these checks with no Forseti server in between. It reads the market from NEAR, the proof bundles from the repository, and the verdict from Base Sepolia; the checking code itself loads from esm.sh. For each ruling:

- the model that answered is the sealed judge, or the model sealed for that panel seat;
- the model's key is in the contract's registry (a key that was attested and registered and has since been rotated out is shown as a note);
- the stored response matches its hash, and the ed25519 signature verifies;
- the outcome, source, quote and reason recorded on-chain are exactly the ones in the signed response;
- the published snapshots match the hashes stored on-chain;
- `rebuild_request` on NEAR returns a request whose hash is the one that was signed;
- the quote is in the snapshot.

Then, for a final market:

- the final outcome follows from the record: the proposal if nobody disputed it, otherwise the panel's majority with contested seats counted as Invalid;
- the EIP-712 digest of the verdict;
- the signer recovered from the MPC signature, compared with the address of the key NEAR Chain Signatures derives for `forseti.testnet` and the path `verdict-v1`;
- `signer()` and `verdictOf(commitmentHash)` on Base Sepolia.

A check that cannot reach the network is reported as not checked, never as passed or failed. Market 1 runs 47 checks. Market 3, the forged-snapshot demo, passes all 38 of its checks and adds two notes that point at the forgery.

## The secure hardware

A signature only means something if the key behind it lives in real secure hardware running the expected model. Before a key is registered on the contract, `executor/attest.mjs` fetches an attestation report with a fresh nonce and checks:

- the Intel TDX quote is valid (with `dcap-qvl`);
- the quote's report data binds the signing key and our nonce;
- the hash of the deployed container configuration matches the measured one;
- NVIDIA's attestation service accepts the GPU evidence.

NVIDIA's service refused requests from our network, so the three keys registered today were registered with that last check skipped; `attest.mjs` now refuses to register such a key unless it is run with `--allow-gpu-skip`. The checks prove that a key comes from a genuine TDX machine; they do not pin which container image it runs. The results are saved in `executor/attestations.json` and shown under **For auditors** on each market page.

## What is still trusted

- **The snapshots.** The executor fetches the sources. A dishonest executor can show the judge a forged copy, and the contract cannot tell, because it never sees the real page. Every snapshot's hash is public, and anyone can appeal, or contest a panel vote, with honest copies; a contested seat counts as Invalid, so forgery that someone notices ends in a refund. That needs someone watching during the challenge window, as with any optimistic oracle. Market 3 plays out the attack and its correction. Notarized snapshots are on the [roadmap](roadmap.md).
- **Key registration.** The contract owner registers TEE keys after checking attestation off-chain.
- **The contract account's key.** `forseti.testnet` still has a full-access key. Whoever holds it can upgrade the contract and can ask NEAR Chain Signatures directly for a signature over any verdict, which every chain would accept. Before mainnet that key must be removed or put behind a multisig and a timelock.
- **The hardware vendors and the NEAR signing network**, as for any TEE or Chain Signatures application.
