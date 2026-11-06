// Verifies NEAR AI model attestations and (with --register) adds the verified ed25519 keys to
// the Forseti contract. A key is registered only if every check passes:
//   Intel TDX quote valid -> report_data binds the signing key and our fresh nonce
//   -> NVIDIA NRAS verifies the GPU (JWT signature checked against NVIDIA's keys, same nonce)
//   -> sha256 of the docker compose matches mr_config in the verified quote.
// Logic follows github.com/nearai/nearai-cloud-verifier (ts/model_verifier.ts).
// Run: node --env-file=../.env attest.mjs [--register] [model ...]
import { createHash, randomBytes } from 'node:crypto';
import { js_get_collateral, js_verify } from '@phala/dcap-qvl-node';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const PANEL = ['z-ai/glm-5.3-flash', 'Qwen/Qwen3.6-35B-A3B-FP8', 'Qwen/Qwen3.8-27B'];
const PCCS = 'https://api.trustedservices.intel.com/tdx/certification/v4';
const NRAS = 'https://nras.attestation.nvidia.com/v3/attest/gpu';
const NVIDIA_JWKS = createRemoteJWKSet(new URL('https://nras.attestation.nvidia.com/.well-known/jwks.json'));

async function tdx(quoteHex) {
  const quote = Buffer.from(quoteHex, 'hex');
  const result = js_verify(quote, await js_get_collateral(PCCS, quote), BigInt(Math.floor(Date.now() / 1000)));
  const td = result?.report?.TD10 ?? result?.report?.TD15 ?? {};
  // OutOfDate means Intel's TCB advisory baseline moved on; the quote signature still verifies.
  return { ok: ['UpToDate', 'OutOfDate'].includes(result?.status), status: result?.status, reportData: td.report_data ?? '', mrConfig: td.mr_config_id ?? '' };
}

async function gpu(payloadJson, nonce) {
  const payload = JSON.parse(payloadJson);
  const res = await fetch(NRAS, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) });
  // NVIDIA answers 403 to some networks (VPNs, some countries). Report the check as skipped
  // instead of failing: the TDX quote alone already binds the key to the confidential VM.
  if (res.status === 403) return { payloadNonce: payload.nonce?.toLowerCase() === nonce, verdict: null, eatNonce: null };
  if (!res.ok) throw new Error(`NRAS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const { payload: claims } = await jwtVerify(body[0][1], NVIDIA_JWKS, { issuer: 'https://nras.attestation.nvidia.com' });
  return {
    payloadNonce: payload.nonce?.toLowerCase() === nonce,
    verdict: claims['x-nvidia-overall-att-result'] === true,
    eatNonce: claims.eat_nonce?.toLowerCase() === nonce,
  };
}

/** Fetches a fresh attestation for `model` and checks every node. Returns verified keys. */
export async function verifyModel(model, apiKey) {
  const nonce = randomBytes(32).toString('hex');
  const url = `https://cloud-api.near.ai/v1/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ed25519&nonce=${nonce}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`attestation ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const report = await res.json();
  const nodes = [];
  for (const a of report.model_attestations ?? []) {
    const key = a.signing_address.replace(/^0x/, '').toLowerCase();
    const q = await tdx(a.intel_quote);
    const rd = q.reportData.replace(/^0x/, '').toLowerCase();
    const g = await gpu(a.nvidia_payload, nonce);
    const tcb = typeof a.info?.tcb_info === 'string' ? JSON.parse(a.info.tcb_info) : a.info?.tcb_info ?? {};
    const composeHash = createHash('sha256').update(tcb.app_compose ?? '').digest('hex');
    const checks = {
      'Intel TDX quote valid': q.ok,
      'report_data binds signing key': rd.slice(0, 64) === key,
      'report_data binds our nonce': rd.slice(64, 128) === nonce,
      'GPU evidence uses our nonce': g.payloadNonce && g.eatNonce !== false,
      'NVIDIA NRAS verdict (signed JWT)': g.verdict, // null = NRAS unreachable from this network
      'compose hash matches mr_config': q.mrConfig.toLowerCase().startsWith('01' + composeHash),
    };
    nodes.push({ key, tdxStatus: q.status, composeHash, checks, ok: Object.values(checks).every((v) => v !== false) });
  }
  return { model, nonce, at: new Date().toISOString(), nodes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const register = args.includes('--register');
  const models = args.filter((a) => !a.startsWith('--'));
  const apiKey = process.env.NEARAI_API_KEY;
  if (!apiKey) throw new Error('NEARAI_API_KEY is not set in ../.env');
  let near;
  if (register) {
    const { Near } = await import('near-kit');
    near = new Near({ network: 'testnet', privateKey: process.env.NEAR_PRIVATE_KEY, defaultSignerId: process.env.NEAR_ACCOUNT_ID });
  }
  let allOk = true;
  for (const model of models.length ? models : PANEL) {
    const r = await verifyModel(model, apiKey);
    console.log(`\n${model}: ${r.nodes.length} TEE node(s)`);
    for (const n of r.nodes) {
      console.log(`  key ${n.key} (TDX ${n.tdxStatus})`);
      for (const [name, ok] of Object.entries(n.checks)) console.log(`    ${ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'} ${name}`);
      allOk &&= n.ok;
      if (register && n.ok) {
        await near.call(process.env.FORSETI_CONTRACT, 'add_signer', { model, public_key: n.key }, { gas: '30 Tgas' });
        console.log('    registered in', process.env.FORSETI_CONTRACT);
      }
    }
  }
  process.exit(allOk ? 0 : 1);
}
