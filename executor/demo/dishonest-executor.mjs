// Plays a dishonest executor, the main trust assumption of the MVP: the executor picks the
// snapshots. It edits the weather value before asking the judge. The judge answers honestly
// from what it sees, and the contract accepts it: the TEE signature and the quote check out
// against the forged snapshot. The appeal path corrects it, because the panel judges the real
// source. The proof bundle is marked forged_by_dishonest_executor.
// Run from executor/ as a separate account:
//   NEAR_ACCOUNT_ID=shady.forseti.testnet NEAR_PRIVATE_KEY=... node --env-file=../.env demo/dishonest-executor.mjs <id> <fake °C>
import { call, rule, show, view } from '../forseti.mjs';
import { snapshot } from '../sources.mjs';

const id = Number(process.argv[2]);
const fake = process.argv[3];
let m = await view('get_market', { id });
if (m.phase === 'Open') {
  console.log(`  open_round tx ${(await call('open_round', { id })).hash}`);
  for (let i = 0; i < 10 && (m = await view('get_market', { id })).phase === 'Open'; i++) await new Promise((ok) => setTimeout(ok, 1000));
}
const real = await Promise.all(m.commitment.params.sources.map(snapshot));
const forged = real.map((s) => s.replace(/"temperature_2m":-?[\d.]+/, `"temperature_2m":${fake}`));
console.log(`  real snapshot:   ${real[0]}\n  forged snapshot: ${forged[0]}`);
await rule(m, 'verdict', m.commitment.params.model, forged);
show(await view('get_market', { id }));
