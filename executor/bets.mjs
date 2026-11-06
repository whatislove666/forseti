// Bets on DemoMarkets.sol (Base Sepolia) for a Forseti market. Betting closes at the NEAR
// market's deadline; payouts follow the verdict relayed into Forseti.sol.
//   node --env-file=../.env bets.mjs open <id>
//   node --env-file=../.env bets.mjs bet <id> yes|no <eth> [--as2]
//   node --env-file=../.env bets.mjs status <id>
//   node --env-file=../.env bets.mjs claim <id> [--as2]
// --as2 uses the second demo wallet (EVM2_PRIVATE_KEY).
import { Near } from 'near-kit';
import { createPublicClient, createWalletClient, formatEther, http, parseAbi, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const MARKETS = process.env.DEMO_MARKETS || '0x9E6edEA194B835c6D100968FF5E8d5eaac3C8692';
const abi = parseAbi([
  'function open(bytes32 commitmentHash, uint64 closesAt)',
  'function bet(bytes32 commitmentHash, bool yes) payable',
  'function claim(bytes32 commitmentHash)',
  'function markets(bytes32) view returns (uint64 closesAt, uint256 yes, uint256 no)',
  'function yesStake(bytes32, address) view returns (uint256)',
  'function noStake(bytes32, address) view returns (uint256)',
  'function payout(bytes32 commitmentHash, address bettor) view returns (uint256)',
]);

const args = process.argv.slice(2);
const [cmd, idArg, side, eth] = args.filter((a) => !a.startsWith('--'));
const account = privateKeyToAccount(args.includes('--as2') ? process.env.EVM2_PRIVATE_KEY : process.env.EVM_PRIVATE_KEY);
const transport = http(process.env.EVM_RPC_URL || 'https://sepolia.base.org');
const pub = createPublicClient({ chain: baseSepolia, transport });
const wallet = createWalletClient({ account, chain: baseSepolia, transport });

const near = new Near({ network: 'testnet' });
const m = await near.view(process.env.FORSETI_CONTRACT || 'forseti.testnet', 'get_market', { id: Number(idArg) }, { finality: 'optimistic' });
const c = m.commitment_hash;

async function send(functionName, fnArgs, value) {
  const hash = await wallet.writeContract({ address: MARKETS, abi, functionName, args: fnArgs, value });
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`${functionName} by ${account.address}: ${r.status} https://sepolia.basescan.org/tx/${hash}`);
}

if (cmd === 'open') {
  await send('open', [c, BigInt(m.commitment.params.resolve_after) / 1_000_000_000n]);
} else if (cmd === 'bet') {
  await send('bet', [c, side === 'yes'], parseEther(eth));
} else if (cmd === 'claim') {
  const before = await pub.getBalance({ address: account.address });
  await send('claim', [c]);
  console.log(`balance +${formatEther((await pub.getBalance({ address: account.address })) - before)} ETH (after gas)`);
} else if (cmd === 'status') {
  const [closesAt, yes, no] = await pub.readContract({ address: MARKETS, abi, functionName: 'markets', args: [c] });
  console.log(`market ${idArg} ${c}\n  closes ${new Date(Number(closesAt) * 1000).toISOString()}, pool YES ${formatEther(yes)} / NO ${formatEther(no)} ETH`);
  for (const key of [process.env.EVM_PRIVATE_KEY, process.env.EVM2_PRIVATE_KEY]) {
    const a = privateKeyToAccount(key).address;
    const [y, n] = await Promise.all(['yesStake', 'noStake'].map((f) => pub.readContract({ address: MARKETS, abi, functionName: f, args: [c, a] })));
    const payout = await pub.readContract({ address: MARKETS, abi, functionName: 'payout', args: [c, a] }).catch(() => null);
    console.log(`  ${a}: YES ${formatEther(y)}, NO ${formatEther(n)}, payout ${payout === null ? 'no verdict yet' : formatEther(payout)}`);
  }
}
