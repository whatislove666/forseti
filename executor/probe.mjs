// Probe: does NEAR AI sign exactly the bytes we send?
// 1. fetch the model attestation (fresh nonce) and list its ed25519 signing keys
// 2. send one non-streaming completion with exact bytes
// 3. fetch the ed25519 signature and check model id, both hashes and the signature
// Run: npm run probe            (needs NEARAI_API_KEY in ../.env)
import { createHash, randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';

const KEY = process.env.NEARAI_API_KEY;
if (!KEY) throw new Error('NEARAI_API_KEY is not set in ../.env');
const BASE = 'https://cloud-api.near.ai/v1';
const MODEL = process.argv[2] || 'z-ai/glm-5.3-flash';
const auth = { Authorization: `Bearer ${KEY}` };
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

async function get(url) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url, { headers: auth });
    const body = await r.text();
    if (r.ok && !body.includes('error_code')) return JSON.parse(body);
    console.log(`  ${r.status} ${body.slice(0, 160)} (retry ${i + 1})`);
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  throw new Error(`GET ${url} failed`);
}

const nonce = randomBytes(32).toString('hex');
const att = await get(`${BASE}/attestation/report?model=${encodeURIComponent(MODEL)}&signing_algo=ed25519&nonce=${nonce}`);
const nodes = att.model_attestations || [att];
const keys = nodes.map((n) => (n.signing_address || n.signing_public_key || '').replace(/^0x/, '').toLowerCase());
console.log(`attestation: ${nodes.length} node(s), keys:`, keys);
console.log('  attestation fields:', Object.keys(nodes[0] || {}).join(', '));

const request = JSON.stringify({
  model: MODEL,
  messages: [
    { role: 'system', content: 'You are a judge. Reply with JSON only.' },
    { role: 'user', content: 'Is 2+2=4? Answer {"outcome":"YES"|"NO","source":"math","quote":"2+2=4","reason":"..."}' },
  ],
  temperature: 0,
  seed: 7,
  max_tokens: 200,
  response_format: { type: 'json_object' },
  chat_template_kwargs: { enable_thinking: false },
  stream: false,
});
const t0 = Date.now();
const res = await fetch(`${BASE}/chat/completions`, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json', 'Accept-Encoding': 'identity', 'x-no-aliasing': 'true' },
  body: request,
});
const response = await res.text();
console.log(`completion: HTTP ${res.status} in ${Date.now() - t0} ms, ${response.length} bytes`);
if (!res.ok) throw new Error(response.slice(0, 500));
const chat = JSON.parse(response);
console.log('  content:', chat.choices?.[0]?.message?.content);

const sig = await get(`${BASE}/signature/${chat.id}?model=${encodeURIComponent(MODEL)}&signing_algo=ed25519`);
console.log('signature:', { kind: sig.signature_kind, text: sig.text, signer: sig.signing_address });
const [model, reqHash, respHash] = sig.text.split(':');
const signer = sig.signing_address.replace(/^0x/, '').toLowerCase();
const checks = {
  'model id in signed text': model === MODEL,
  'request hash == sha256(our bytes)': reqHash === sha256(request),
  'response hash == sha256(received bytes)': respHash === sha256(response),
  'signer is an attested key': keys.includes(signer),
  'ed25519 signature valid': ed25519.verify(sig.signature.replace(/^0x/, ''), Buffer.from(sig.text), signer),
};
console.table(checks);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
