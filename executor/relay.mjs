// Relays a final Forseti verdict from NEAR to an EVM chain. Anyone can do this: the EVM
// contract only accepts it if the NEAR MPC signature matches its fixed signer.
// The last line printed is JSON for callers: {"tx": "0x…" | null (already recorded), ...}.
// Run: node --env-file=../.env relay.mjs <market id> <Forseti.sol address> [rpc url]
import { Near } from 'near-kit';
import { createWalletClient, createPublicClient, http, parseAbi, recoverAddress, serializeSignature } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const BASE_SEPOLIA_FORSETI = '0x374541e22a7406E8246D0774E8994fc358232121';
const abi = parseAbi([
  'function submitVerdict(bytes32 commitmentHash, uint8 outcome, uint32 round, uint8 v, bytes32 r, bytes32 s)',
  'function verdictOf(bytes32 commitmentHash) view returns ((uint8 outcome, uint32 round))',
  'function signer() view returns (address)',
]);

/** Returns { tx: hash | null (already recorded), chainId, commitmentHash, outcome, round }. */
export async function relay(id, verifier = BASE_SEPOLIA_FORSETI, rpc = process.env.EVM_RPC_URL || 'https://sepolia.base.org') {
  const contract = process.env.FORSETI_CONTRACT || 'forseti.testnet';
  const near = new Near({ network: 'testnet' });
  const m = await near.view(contract, 'get_market', { id: Number(id) }, { finality: 'optimistic' });
  if (!m.evm_signature) throw new Error(`market ${id} is not signed yet (phase ${m.phase})`);

  const transport = http(rpc);
  const pub = createPublicClient({ transport });
  const chainId = await pub.getChainId();
  const read = (functionName, args) => pub.readContract({ address: verifier, abi, functionName, args });
  const result = (tx, verdict) => ({ tx, chainId, commitmentHash: m.commitment_hash, outcome: verdict.outcome, round: verdict.round });

  // Already recorded (by us or anyone else): nothing to send.
  const recorded = await read('verdictOf', [m.commitment_hash]);
  if (recorded.outcome !== 0) {
    if (recorded.outcome !== m.outcome) throw new Error(`the verifier already holds outcome ${recorded.outcome}, NEAR says ${m.outcome}`);
    return result(null, recorded);
  }

  // The verifier must trust the key that signed what NEAR asked the MPC network to sign.
  const { r, s, v } = m.evm_signature;
  const digest = await near.view(contract, 'get_verdict_digest', { id: Number(id) }, { finality: 'optimistic' });
  const recovered = await recoverAddress({ hash: digest, signature: serializeSignature({ r, s, v: BigInt(v < 27 ? v + 27 : v) }) });
  const signer = await read('signer');
  if (recovered.toLowerCase() !== signer.toLowerCase()) throw new Error(`verifier ${verifier} trusts ${signer}, but this verdict is signed by ${recovered}`);

  const chain = { id: chainId, name: 'evm', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
  const wallet = createWalletClient({ account: privateKeyToAccount(process.env.EVM_PRIVATE_KEY), chain, transport });
  const hash = await wallet.writeContract({ address: verifier, abi, functionName: 'submitVerdict', args: [m.commitment_hash, m.outcome, m.round, v, r, s] });
  // waitForTransactionReceipt also resolves for reverted transactions.
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`tx ${hash} reverted`);
  return result(hash, await read('verdictOf', [m.commitment_hash]));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [id, verifier, rpc] = process.argv.slice(2);
  const out = await relay(id, verifier, rpc);
  if (!out.tx) console.log(`market ${id}: the verdict is already recorded on chain ${out.chainId}`);
  console.log(JSON.stringify(out));
}
