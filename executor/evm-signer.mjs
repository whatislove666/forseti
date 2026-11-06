// Prints the EVM address that signs Forseti verdicts: the MPC key derived for
// (contract account, path "verdict-v1"). Deploy Forseti.sol with this address.
import { Near } from 'near-kit';
import { publicKeyToAddress } from 'viem/accounts';
import { base58 } from '@scure/base';

export async function evmSigner(contract = process.env.FORSETI_CONTRACT || 'forseti.testnet', mpc = 'v1.signer-prod.testnet') {
  const near = new Near({ network: 'testnet' });
  const pk = await near.view(mpc, 'derived_public_key', { path: 'verdict-v1', predecessor: contract, domain_id: 0 });
  // "secp256k1:<base58 of 64-byte x||y>"
  const xy = base58.decode(pk.split(':')[1]);
  return publicKeyToAddress(`0x04${Buffer.from(xy).toString('hex')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(await evmSigner());
