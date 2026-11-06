// Forseti executor: fetches the committed sources, asks the committed judge on NEAR AI Cloud,
// and submits the signed answer to the Forseti contract. Anyone can run it; the contract
// re-checks everything (request bytes, TEE signature, quote), so the executor is not trusted
// with the verdict, only with picking honest snapshots (see README, trust assumptions).
//
//   node --env-file=../.env forseti.mjs create markets/berlin.json
//   node --env-file=../.env forseti.mjs preview <id>     ask the judge before the deadline
//   node --env-file=../.env forseti.mjs resolve <id>     open a round and submit the verdict
//   node --env-file=../.env forseti.mjs appeal <id>      post the appeal bond
//   node --env-file=../.env forseti.mjs panel <id>       collect the panel's votes
//   node --env-file=../.env forseti.mjs finalize <id>    settle and get the MPC signature
//   node --env-file=../.env forseti.mjs show <id>
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519';
import { Near } from 'near-kit';

const AI = 'https://cloud-api.near.ai/v1';
const CONTRACT = process.env.FORSETI_CONTRACT || 'forseti.testnet';
const SIGNER = process.env.NEAR_ACCOUNT_ID;
const near = new Near({ network: 'testnet', privateKey: process.env.NEAR_PRIVATE_KEY, defaultSignerId: SIGNER });
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const MAX_SNAPSHOT_BYTES = 32 * 1024;

// ---------- sources ----------

/** Cleans fetched text before the model sees it: strips invisible and smuggled characters
 *  and defuses anything that looks like our <source> delimiter (prompt injection). */
export function normalize(text) {
  let t = text
    .normalize('NFKC')
    .replace(/[­​-‏‪-‮⁠-⁤﻿]/g, '') // zero-width, bidi, soft hyphen
    .replace(/[\u{E0000}-\u{E007F}]/gu, '') // Unicode tag characters ("ASCII smuggling")
    .replace(/<(\/?)source/gi, '‹$1source')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const bytes = Buffer.from(t);
  if (bytes.length > MAX_SNAPSHOT_BYTES) t = bytes.subarray(0, MAX_SNAPSHOT_BYTES).toString().replace(/�$/, '');
  return t;
}

// ponytail: regex HTML stripping (drops scripts, styles and elements marked hidden); swap for a
// real DOM parser if demo pages need CSS selectors.
function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|template|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<([a-z0-9]+)[^>]*(\shidden\b|aria-hidden="true"|display:\s*none|visibility:\s*hidden)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** `extract` is a JSON path like `$.current` for JSON APIs, or empty for the whole page. */
export async function snapshot(source) {
  const res = await fetch(source.url, { headers: { 'User-Agent': 'forseti-executor/0.1', Accept: 'application/json, text/html;q=0.9' } });
  if (!res.ok) throw new Error(`${source.id}: HTTP ${res.status} from ${source.url}`);
  const body = await res.text();
  let text;
  if (source.extract.startsWith('$')) {
    let v = JSON.parse(body);
    for (const k of source.extract.slice(1).match(/[^.[\]]+/g) ?? []) v = v?.[k];
    if (v === undefined) throw new Error(`${source.id}: ${source.extract} not found`);
    text = typeof v === 'string' ? v : JSON.stringify(v);
  } else {
    text = /html/.test(res.headers.get('content-type') ?? '') ? htmlToText(body) : body;
  }
  return normalize(text);
}

// ---------- NEAR AI ----------

/** Sends the exact request bytes, fetches the TEE signature and checks it locally first. */
export async function judge(model, request) {
  const auth = { Authorization: `Bearer ${process.env.NEARAI_API_KEY}` };
  const res = await fetch(`${AI}/chat/completions`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', 'Accept-Encoding': 'identity', 'x-no-aliasing': 'true' },
    body: request,
  });
  const response = await res.text();
  if (!res.ok) throw new Error(`NEAR AI ${res.status}: ${response.slice(0, 300)}`);
  const chatId = JSON.parse(response).id;
  let sig;
  for (let i = 0; i < 8 && !sig; i++) {
    const r = await fetch(`${AI}/signature/${chatId}?model=${encodeURIComponent(model)}&signing_algo=ed25519`, { headers: auth });
    const body = await r.text();
    if (r.ok && !body.includes('error_code')) sig = JSON.parse(body);
    else await new Promise((ok) => setTimeout(ok, 1500)); // the signature lives on the node that served us; retry
  }
  if (!sig) throw new Error(`no signature for chat ${chatId}`);
  const signer = sig.signing_address.replace(/^0x/, '').toLowerCase();
  const signature = sig.signature.replace(/^0x/, '').toLowerCase();
  const expected = `${model}:${sha256(request)}:${sha256(response)}`;
  if (sig.text !== expected) throw new Error(`signed text mismatch:\n  got  ${sig.text}\n  want ${expected}`);
  if (!ed25519.verify(signature, Buffer.from(expected), signer)) throw new Error('ed25519 signature does not verify');
  return { response, signer, signature, chatId, signedText: expected, signatureKind: sig.signature_kind };
}

// ---------- contract ----------

// Optimistic finality so a view right after our own transaction already sees it.
const view = (method, args) => near.view(CONTRACT, method, args, { finality: 'optimistic' });

async function call(method, args, { gas = '100 Tgas', deposit = '0 NEAR' } = {}) {
  const r = await near.transaction(SIGNER).functionCall(CONTRACT, method, args, { gas, attachedDeposit: deposit }).send();
  const failure = r.status?.Failure ?? r.receipts_outcome?.find((o) => o.outcome.status?.Failure)?.outcome.status.Failure;
  if (failure) throw new Error(`${method} failed: ${JSON.stringify(failure).slice(0, 400)}`);
  const ret = r.status?.SuccessValue;
  return { hash: r.transaction.hash, value: ret ? JSON.parse(Buffer.from(ret, 'base64').toString()) : undefined };
}

const ns = (minutes) => String(BigInt(Date.now() + minutes * 60_000) * 1_000_000n);
const yocto = (near) => String(BigInt(Math.round(Number(near) * 1e6)) * 10n ** 18n);
const OUTCOME = { 1: 'YES', 2: 'NO', 3: 'INVALID', 4: 'TOO_EARLY' };

function saveProof(m, kind, model, data) {
  mkdirSync('proofs', { recursive: true });
  const file = `proofs/m${m.commitment.id}-r${m.round}-${kind}-${model.replace(/[^a-z0-9]+/gi, '-')}.json`;
  writeFileSync(file, JSON.stringify({ contract: CONTRACT, market: m.commitment.id, commitment_hash: m.commitment_hash, round: m.round, kind, model, ...data }, null, 2));
  return file;
}

/** Fetch sources, build the request on-chain, ask the model, submit, save the proof bundle. */
async function rule(m, kind, model) {
  const sources = m.commitment.params.sources;
  const snapshots = await Promise.all(sources.map(snapshot));
  const request = await view('build_request', { id: m.commitment.id, model, snapshots, preview: kind === 'preview' });
  const t0 = Date.now();
  const j = await judge(model, request);
  const answer = JSON.parse(JSON.parse(j.response).choices[0].message.content.replace(/^```(json)?|```$/g, ''));
  console.log(`  ${model}: ${answer.outcome} (${Date.now() - t0} ms)\n    quote: ${answer.quote}\n    reason: ${answer.reason}`);
  const args = { id: m.commitment.id, snapshots, response: j.response, signer: j.signer, signature: j.signature };
  const { hash: tx } = kind === 'preview' ? await call('submit_preview', args) : await call('submit_ruling', { ...args, model });
  const file = saveProof(m, kind, model, { tx, sources, snapshots, request, ...j, answer });
  console.log(`    tx ${tx}\n    proof ${file}`);
}

function show(m) {
  const p = m.commitment.params;
  const t = (x) => new Date(Number(BigInt(x) / 1_000_000n)).toISOString();
  console.log(`market ${m.commitment.id} ${m.commitment_hash}\n  ${p.question}\n  phase ${m.phase}, round ${m.round}, deadline ${t(p.resolve_after)}`);
  if (m.proposed) console.log(`  proposed ${OUTCOME[m.proposed.outcome]} by ${m.proposed.model}: "${m.proposed.quote}"`);
  m.panel_votes.forEach((v, i) => v && console.log(`  panel ${p.panel[i]}: ${OUTCOME[v.outcome]}`));
  if (m.outcome) console.log(`  FINAL ${OUTCOME[m.outcome]}`);
  if (m.evm_signature) console.log(`  EVM signature r=${m.evm_signature.r} s=${m.evm_signature.s} v=${m.evm_signature.v}`);
}

// ---------- CLI ----------

const [cmd, arg] = process.argv.slice(2);
const id = Number(arg);
const market = () => view('get_market', { id });

if (cmd === 'create') {
  const spec = JSON.parse(readFileSync(arg, 'utf8'));
  const params = {
    question: spec.question,
    rules: spec.rules,
    model: spec.model,
    system_prompt: spec.system_prompt,
    sources: spec.sources,
    seed: spec.seed,
    max_tokens: spec.max_tokens,
    panel: spec.panel,
    resolve_after: ns(spec.resolve_after_minutes),
    resolve_by: ns(spec.resolve_by_minutes),
    challenge_period: String(BigInt(spec.challenge_minutes * 60) * 1_000_000_000n),
    appeal_bond: yocto(spec.appeal_bond_near),
  };
  const { hash, value: newId } = await call('create_market', { params }, { deposit: '1 NEAR' });
  console.log(`created market ${newId} (tx ${hash})`);
  show(await view('get_market', { id: newId }));
} else if (cmd === 'preview') {
  const m = await market();
  await rule(m, 'preview', m.commitment.params.model);
} else if (cmd === 'resolve') {
  let m = await market();
  if (m.phase === 'Open') {
    console.log(`  open_round tx ${(await call('open_round', { id })).hash}`);
    m = await market();
  }
  await rule(m, 'verdict', m.commitment.params.model);
  show(await market());
} else if (cmd === 'appeal') {
  const m = await market();
  const bond = BigInt(m.commitment.params.appeal_bond);
  console.log(`  appeal tx ${(await call('appeal', { id }, { deposit: `${bond} yocto` })).hash}`);
  show(await market());
} else if (cmd === 'panel') {
  const m = await market();
  for (const [i, model] of m.commitment.params.panel.entries()) {
    if (!m.panel_votes[i]) await rule(m, 'panel', model);
  }
  show(await market());
} else if (cmd === 'finalize') {
  console.log(`  finalize tx ${(await call('finalize', { id }, { gas: '300 Tgas' })).hash}`);
  const m = await market();
  show(m);
  if (m.phase === 'Final') console.log(`  digest ${await view('get_verdict_digest', { id })}`);
} else if (cmd === 'show') {
  show(await market());
} else {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 13).join('\n'));
}
