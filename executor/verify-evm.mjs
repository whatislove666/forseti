// Checks a finalized market the way an EVM chain will: recompute the EIP-712 digest,
// recover the signer from the MPC signature and compare it with the derived address.
// Run: node --env-file=../.env verify-evm.mjs <id>
import { Near } from 'near-kit';
import { hashTypedData, recoverAddress, serializeSignature } from 'viem';
import { evmSigner } from './evm-signer.mjs';

const id = Number(process.argv[2]);
const contract = process.env.FORSETI_CONTRACT || 'forseti.testnet';
const near = new Near({ network: 'testnet' });
const m = await near.view(contract, 'get_market', { id }, { finality: 'optimistic' });
if (!m.evm_signature) throw new Error(`market ${id} has no MPC signature yet (phase ${m.phase})`);
const digest = hashTypedData({
  domain: { name: 'Forseti', version: '1' },
  types: { Verdict: [{ name: 'commitmentHash', type: 'bytes32' }, { name: 'outcome', type: 'uint8' }, { name: 'round', type: 'uint32' }] },
  primaryType: 'Verdict',
  message: { commitmentHash: m.commitment_hash, outcome: m.outcome, round: m.round },
});
const onChainDigest = await near.view(contract, 'get_verdict_digest', { id }, { finality: 'optimistic' });
const { r, s, v } = m.evm_signature;
const recovered = await recoverAddress({ hash: digest, signature: serializeSignature({ r, s, v: BigInt(v) }) });
const expected = await evmSigner(contract);
const checks = {
  'viem digest == contract digest': digest === onChainDigest,
  'recovered signer == derived MPC address': recovered.toLowerCase() === expected.toLowerCase(),
};
console.log({ outcome: m.outcome, round: m.round, digest, recovered, expected });
console.table(checks);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
