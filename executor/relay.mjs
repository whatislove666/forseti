// Relays a final Forseti verdict from NEAR to an EVM chain. Anyone can do this: the EVM
// contract only accepts it if the NEAR MPC signature matches its fixed signer.
// Run: node --env-file=../.env relay.mjs <market id> <Forseti.sol address> [rpc url]
import { Near } from 'near-kit';
import { createWalletClient, createPublicClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const [idArg, verifier, rpc = process.env.EVM_RPC_URL || 'https://sepolia.base.org'] = process.argv.slice(2);
const near = new Near({ network: 'testnet' });
const m = await near.view(process.env.FORSETI_CONTRACT || 'forseti.testnet', 'get_market', { id: Number(idArg) }, { finality: 'optimistic' });
if (!m.evm_signature) throw new Error(`market ${idArg} is not signed yet (phase ${m.phase})`);

const abi = parseAbi([
  'function submitVerdict(bytes32 commitmentHash, uint8 outcome, uint32 round, uint8 v, bytes32 r, bytes32 s)',
  'function verdictOf(bytes32 commitmentHash) view returns ((uint8 outcome, uint32 round))',
]);
const transport = http(rpc);
const pub = createPublicClient({ transport });
const chain = { id: await pub.getChainId(), name: 'evm', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const wallet = createWalletClient({ account: privateKeyToAccount(process.env.EVM_PRIVATE_KEY), chain, transport });

const { r, s, v } = m.evm_signature;
const hash = await wallet.writeContract({ address: verifier, abi, functionName: 'submitVerdict', args: [m.commitment_hash, m.outcome, m.round, v, r, s] });
await pub.waitForTransactionReceipt({ hash });
const verdict = await pub.readContract({ address: verifier, abi, functionName: 'verdictOf', args: [m.commitment_hash] });
console.log({ chainId: chain.id, tx: hash, commitmentHash: m.commitment_hash, verdict });
