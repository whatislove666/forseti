# Roadmap

Forseti today proves the core idea on testnet: a judge sealed before trading, checked on NEAR, final on any EVM chain. This is where it goes from here, from the next steps to research that would remove the last things you still have to trust.

## Built at NEAR HACKATHON

- **Sealed judges.** The model, instructions, sources and appeal panel are fixed on NEAR before trading, keyed by one commitment hash.
- **Rulings checked on-chain.** NEAR rebuilds the request, verifies the TEE signature from NEAR AI Cloud and finds the quoted evidence in the source.
- **Appeals to a panel.** Anyone can post a bond and send a verdict to three models that decide by majority. A forged verdict was overturned this way on testnet.
- **One verdict for every chain.** NEAR Chain Signatures signs the final answer once; `Forseti.sol` accepts it on any EVM chain. Live on Base Sepolia with a betting contract that pays out from it.
- **Checks in the browser.** Every market page re-runs every check with no server in between.
- **Replays of real markets.** 27 settled Polymarket, Kalshi and Manifold markets, five of them disputed on their platform, resolved again by a sealed judge next to the platform's own outcome.
- **Disputes that fail safe.** The panel votes for a full window, every seat can be contested with a second signed vote, and a contested seat counts as Invalid, so a forged source that someone notices ends in a refund rather than a wrong payout.

## Next: ready for mainnet

- **Locked contract.** Remove full-access keys or put upgrades behind a timelock and a multisig, and publish reproducible builds so anyone can match the deployed code to the source.
- **Attestation checked on-chain.** Verify the Intel TDX and NVIDIA evidence on NEAR, or a proof of that verification, so registering a model's key needs no owner.
- **Open executor network.** Anyone can run an executor with a stake, earn a fee per ruling and lose the stake when an appeal proves a forged snapshot.
- **Fees and bonds.** A judge fee paid by the market, appeal bonds that scale with the market's volume, and a pool that covers appeal costs.

## Then: inside the markets people already use

- **Drop-in oracle adapter.** A contract with the interface that Polymarket-style conditional-token markets already call for UMA, so an existing market can switch its oracle to Forseti by configuration.
- **SDKs.** A TypeScript SDK to seal, ask, verify and relay; a Solidity library; a NEAR cross-contract interface; drop-in "Ask the judge" and "Check it yourself" components.
- **Rules linter.** Before sealing, the judge and the panel read the rules against sample sources and flag ambiguity, the cause of most disputes, with a score for how predictable the market is.
- **More chains.** Solana and other ed25519 chains through the EdDSA signatures of Chain Signatures, plus settlement through NEAR Intents.
- **Forseti Bench.** Run every settled market from the major platforms through sealed judges and publish how often they agree with the official outcome and where they differ, so markets pick judges by evidence.

## Research: nothing left to trust

- **Notarized sources.** zkTLS or TLSNotary proofs that a snapshot really came from its URL at a given time. This removes the main trust assumption today: an executor that forges a source.
- **Sources fetched inside the enclave.** The model's secure hardware fetches the sources itself and signs the snapshot together with the answer.
- **Panels across vendors.** Panel models on different hardware (Intel TDX, AMD SEV-SNP, NVIDIA) and different operators, so one vendor's flaw cannot decide an appeal.
- **Exact model weights in the seal.** Commit to the measured hash of the model image, not just its name, so a model cannot change under a live market.
- **Proofs of inference.** Zero-knowledge proofs for small judge models, as an alternative to trusting hardware.
- **Agentic judges.** A judge that may search within a sealed list of sites for questions whose sources cannot be known in advance, with every page it reads notarized.

## Further out

- **Live markets.** Rulings that stream during in-play sports and other fast events.
- **Private markets.** Rules, sources or positions kept encrypted until the deadline.
- **No governance over live markets.** New judges and policies apply only to new markets; a sealed market keeps its judge forever.
- **Beyond prediction markets.** Parametric insurance, bounties, escrow and grant milestones: any contract that pays out when something happened according to written rules.
