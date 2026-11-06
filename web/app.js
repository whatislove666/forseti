// Forseti web: reads markets from NEAR, re-runs every check in the browser, and lets anyone
// ask the committed judge with their own NEAR AI key. No backend.
import { ed25519 } from 'https://esm.sh/@noble/curves@1.9.7/ed25519';
import { base58 } from 'https://esm.sh/@scure/base@1.2.6';
import { createPublicClient, hashTypedData, http, parseAbi, recoverAddress, serializeSignature } from 'https://esm.sh/viem@2.57.16';
import { publicKeyToAddress } from 'https://esm.sh/viem@2.57.16/accounts';
import { baseSepolia } from 'https://esm.sh/viem@2.57.16/chains';
import { snapshot } from '../executor/sources.mjs';

const CONTRACT = 'forseti.testnet';
const MPC = 'v1.signer-prod.testnet';
const NEAR_RPC = 'https://rpc.testnet.near.org';
const FORSETI_EVM = '0x374541e22a7406E8246D0774E8994fc358232121';
const AI = 'https://cloud-api.near.ai/v1';
const OUTCOME = { 1: 'YES', 2: 'NO', 3: 'INVALID', 4: 'TOO_EARLY' };
const app = document.getElementById('app');

// ---------- data ----------

const utf8 = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', utf8.encode(s)));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (h, n = 6) => (h.length > 2 * n + 1 ? `${h.slice(0, n)}…${h.slice(-n)}` : h);
const toDate = (ns) => new Date(Number(BigInt(ns) / 1_000_000n));
const fmt = (ns) => `${toDate(ns).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`;
const nearAmount = (yocto) => `${Number(BigInt(yocto) / 10n ** 18n) / 1e6} NEAR`;
const minutes = (ns) => `${Number(BigInt(ns) / 60_000_000_000n)} min`;
const normalizeWs = (s) => s.split(/\s+/).filter(Boolean).join(' ');

async function view(method, args = {}, account = CONTRACT) {
  const bytes = utf8.encode(JSON.stringify(args));
  const args_base64 = btoa(String.fromCharCode(...bytes));
  const res = await fetch(NEAR_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'optimistic', account_id: account, method_name: method, args_base64 } }),
  });
  const body = await res.json();
  if (body.error || body.result?.error) throw new Error(`${method}: ${JSON.stringify(body.error ?? body.result.error).slice(0, 300)}`);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(body.result.result)));
}

const evm = createPublicClient({ chain: baseSepolia, transport: http() });
const evmAbi = parseAbi(['function signer() view returns (address)', 'function verdictOf(bytes32) view returns ((uint8 outcome, uint32 round))']);

let proofIndex;
async function proofFor(responseSha) {
  proofIndex ??= fetch('../executor/proofs/index.json').then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const entry = (await proofIndex).find((p) => p.response_sha256 === responseSha);
  return entry ? fetch(`../executor/proofs/${entry.file}`).then((r) => r.json()) : null;
}

/** Every signed answer stored for a market, oldest first. */
function rulings(m) {
  const list = m.previews.map((r) => ({ r, kind: 'Preview', nonce: 'preview' }));
  if (m.proposed) list.push({ r: m.proposed, kind: `Verdict, round ${m.round}`, nonce: m.round_nonce, key: true });
  if (m.challenge) list.push({ r: m.challenge, kind: 'Conflicting answer', nonce: m.round_nonce });
  m.panel_votes.forEach((r) => r && list.push({ r, kind: 'Panel vote', nonce: m.round_nonce }));
  return list.sort((a, b) => (BigInt(a.r.at) < BigInt(b.r.at) ? -1 : 1));
}

function statusOf(m) {
  if (m.phase === 'Final') return `<span class="status final">Final: ${OUTCOME[m.outcome]}</span>`;
  const label = { Open: Date.now() < toDate(m.commitment.params.resolve_after) ? 'Open for trading' : 'Awaiting verdict', Resolving: 'Judge is deciding', Proposed: `Proposed ${OUTCOME[m.proposed?.outcome]}, open to appeal`, Disputed: 'Before the panel' }[m.phase];
  return `<span class="status">${esc(label)}</span>`;
}

// ---------- docket ----------

async function docket() {
  const n = await view('get_markets_count');
  const markets = (await view('get_markets', { from: 0, limit: 50 })).reverse();
  app.innerHTML = `
    <table class="docket">
      <thead><tr><th>No.</th><th>Question</th><th>Status</th><th class="when">Deadline</th></tr></thead>
      <tbody>${markets.map((m) => `
        <tr data-id="${m.commitment.id}">
          <td class="no">${m.commitment.id}</td>
          <td class="q"><a href="#/m/${m.commitment.id}">${esc(m.commitment.params.question)}</a></td>
          <td>${statusOf(m)}</td>
          <td class="when">${fmt(m.commitment.params.resolve_after)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <p class="muted">${n} market${n === 1 ? '' : 's'} on <code>${CONTRACT}</code>. Open one to see its judge, its rulings and the checks behind them.</p>`;
  app.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => (location.hash = `#/m/${tr.dataset.id}`)));
}

// ---------- market ----------

async function market(id) {
  const [m, attest] = await Promise.all([view('get_market', { id }), fetch('../executor/attestations.json').then((r) => (r.ok ? r.json() : [])).catch(() => [])]);
  const p = m.commitment.params;
  const open = m.phase === 'Open' && Date.now() < toDate(p.resolve_after);
  app.innerHTML = `
    <a class="back" href="#/">All markets</a>
    <div class="case">
      <article>
        ${statusOf(m)}
        <h1>${esc(p.question)}</h1>
        <p class="rules">${esc(p.rules)}</p>
        <dl class="terms">
          <dt>Judge</dt><dd>${esc(p.model)}, seed ${p.seed}, temperature 0</dd>
          <dt>Appeal panel</dt><dd>${p.panel.map(esc).join('<br>')}</dd>
          <dt>Sources</dt><dd><ul>${p.sources.map((s) => `<li><a href="${esc(s.url)}">${esc(s.id)}</a>${s.extract ? `, field <code>${esc(s.extract)}</code>` : ''}</li>`).join('')}</ul></dd>
          <dt>Deadline</dt><dd>${fmt(p.resolve_after)}</dd>
          <dt>Appeals</dt><dd>${minutes(p.challenge_period)} after a verdict, bond ${nearAmount(p.appeal_bond)}</dd>
          <dt>Created by</dt><dd>${esc(m.commitment.creator)}</dd>
          <dt>Commitment</dt><dd class="hash">${esc(m.commitment_hash)}</dd>
        </dl>
        <details class="prompt"><summary>Judge's instructions, fixed at creation</summary><p>${esc(p.system_prompt)}</p></details>

        <h2>Rulings</h2>
        ${rulings(m).length ? `<ol class="timeline">${rulings(m).map(({ r, kind, key }) => `
          <li class="${key ? 'key' : ''}">
            <div class="event">${esc(kind)}<span class="when">${fmt(r.at)}</span></div>
            <div><span class="verdict-word">${OUTCOME[r.outcome]}</span> <span class="muted">from ${esc(r.model)}</span></div>
            ${r.quote ? `<blockquote>${esc(r.quote)}</blockquote>` : ''}
            <p class="reason">${esc(r.reason)}</p>
            <div class="meta">Signed in a TEE by key <span class="hash">${short(r.signer)}</span>, submitted by ${esc(r.submitted_by)}, snapshot <span class="hash">${short(r.snapshot_sha256.join(), 5)}</span></div>
          </li>${r === m.proposed && m.appellant ? `
          <li><div class="event">Appeal</div><div class="meta">${esc(m.appellant)} posted the bond, so the panel decides.</div></li>` : ''}`).join('')}
          ${m.phase === 'Final' ? `<li class="key"><div class="event">Final: <span class="verdict-word">${OUTCOME[m.outcome]}</span></div><div class="meta">${m.proposed && m.proposed.outcome !== m.outcome ? `The panel overturned the verdict ${OUTCOME[m.proposed.outcome]}${m.appellant ? `, so the bond went back to ${esc(m.appellant)}` : ''}. ` : ''}${m.evm_signature ? 'Signed for EVM chains by the NEAR MPC network.' : 'Waiting for the MPC signature.'}</div></li>` : ''}
        </ol>` : `<p class="muted">No rulings yet. Before the deadline anyone can ask the judge.</p>`}

        <h2>The judges' keys</h2>
        <div class="keys">${[p.model, ...p.panel].filter((v, i, a) => a.indexOf(v) === i).map((model) => keyCard(model, attest)).join('')}</div>
      </article>

      <aside class="chain">
        <h2>Verify it yourself</h2>
        <p>Your browser re-checks this market against NEAR and Base Sepolia. Nothing here trusts our server: there is none.</p>
        <button id="verify">Verify in this browser</button>
        <ol class="checks" id="checks"></ol>
        <div id="summary"></div>
        ${open ? askPanel(m) : ''}
      </aside>
    </div>`;
  document.getElementById('verify').addEventListener('click', (e) => verify(m, e.target));
  if (open) document.getElementById('ask').addEventListener('submit', (e) => ask(e, m));
}

function keyCard(model, attest) {
  const a = attest.find((x) => x.model === model);
  if (!a) return `<article><h3>${esc(model)}</h3><p class="muted">No attestation record published.</p></article>`;
  return a.nodes.map((n) => `
    <article>
      <h3>${esc(model)}</h3>
      <div class="hash">${esc(n.key)}</div>
      <ul>${Object.entries(n.checks).map(([name, ok]) => `<li>${ok === null ? 'Not reachable: ' : ok ? '' : 'Failed: '}${esc(name)}</li>`).join('')}</ul>
      <div class="meta muted">Checked ${`${new Date(a.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`} with a fresh nonce. Re-run: <code>node --env-file=../.env attest.mjs</code></div>
    </article>`).join('');
}

// ---------- verification ----------

async function verify(m, button) {
  button.disabled = true;
  const list = document.getElementById('checks');
  const summary = document.getElementById('summary');
  list.innerHTML = '';
  summary.innerHTML = '';
  let total = 0, passed = 0, failed = 0;
  const group = (title) => list.insertAdjacentHTML('beforeend', `<li class="group">${esc(title)}</li>`);
  const check = async (title, fn) => {
    const li = document.createElement('li');
    li.textContent = title;
    list.append(li);
    let ok, detail;
    try { [ok, detail] = await fn(); } catch (e) { [ok, detail] = [false, e.message]; }
    li.className = ok === null ? 'skip' : ok ? 'pass' : 'fail';
    if (detail) li.insertAdjacentHTML('beforeend', `<span class="detail">${esc(detail)}</span>`);
    total += ok === null ? 0 : 1; passed += ok ? 1 : 0; failed += ok === false ? 1 : 0;
  };

  group('The terms');
  await check('Terms hash to the commitment', async () => {
    const h = `0x${await sha256(JSON.stringify(m.commitment))}`;
    return [h === m.commitment_hash, short(h, 10)];
  });

  const keys = {};
  for (const { r, kind, nonce } of rulings(m)) {
    group(`${kind}: ${r.model}`);
    keys[r.model] ??= await view('get_signers', { model: r.model });
    await check('TEE key is registered for this model', async () => [keys[r.model].includes(r.signer), short(r.signer)]);
    await check('Response matches its recorded hash', async () => [(await sha256(r.response)) === r.response_sha256]);
    await check('TEE signature over model, request and response', async () => {
      const text = `${r.model}:${r.request_sha256}:${r.response_sha256}`;
      return [ed25519.verify(r.signature, utf8.encode(text), r.signer), `ed25519 over "${short(text, 14)}"`];
    });
    await check('Answer inside the response is the recorded one', async () => {
      const a = JSON.parse(JSON.parse(r.response).choices[0].message.content.replace(/^```(json)?|```$/g, ''));
      return [a.outcome === OUTCOME[r.outcome] && (a.quote ?? '').startsWith(r.quote.slice(0, 50))];
    });
    const bundle = await proofFor(r.response_sha256);
    if (bundle?.forged_by_dishonest_executor) {
      await check('Bundle is marked as forged by the dishonest-executor demo', async () => [null, 'The snapshot was edited before the judge saw it. The checks below still pass: they prove what the judge saw, not that it was true.']);
    }
    if (!bundle) {
      await check('Source snapshots', async () => [null, 'Not published for this ruling; the checks above use on-chain data only.']);
      continue;
    }
    await check('Published snapshots match the on-chain hashes', async () => {
      const hs = await Promise.all(bundle.snapshots.map(sha256));
      return [hs.join() === r.snapshot_sha256.join(), `${hs.length} snapshot(s)`];
    });
    await check('NEAR rebuilds the exact signed request', async () => {
      const req = await view('rebuild_request', { id: m.commitment.id, model: r.model, snapshots: bundle.snapshots, nonce });
      return [(await sha256(req)) === r.request_sha256, `nonce ${nonce}`];
    });
    if (r.outcome === 1 || r.outcome === 2) {
      await check('Quote appears in the cited snapshot', async () => {
        const i = m.commitment.params.sources.findIndex((s) => s.id === r.source);
        return [i >= 0 && normalizeWs(bundle.snapshots[i]).includes(normalizeWs(r.quote)), `source "${r.source}"`];
      });
    }
  }

  const round = [m.proposed, m.challenge, ...m.panel_votes].filter(Boolean);
  if (round.length > 1) {
    group('Evidence across the round');
    await check('Every ruling in the round saw the same snapshots', async () => {
      const seen = [...new Set(round.map((r) => r.snapshot_sha256.join()))];
      if (seen.length === 1) return [true, short(seen[0], 5)];
      const by = round.map((r) => `${r === m.proposed ? 'verdict' : r.model}: ${short(r.snapshot_sha256.join(), 5)}`).join('; ');
      return [null, `They differ (${by}). The panel's majority decides, which is how a bad snapshot gets corrected.`];
    });
  }

  if (m.phase === 'Final' && m.evm_signature) {
    group('Settlement on EVM chains');
    const typed = { domain: { name: 'Forseti', version: '1' }, types: { Verdict: [{ name: 'commitmentHash', type: 'bytes32' }, { name: 'outcome', type: 'uint8' }, { name: 'round', type: 'uint32' }] }, primaryType: 'Verdict', message: { commitmentHash: m.commitment_hash, outcome: m.outcome, round: m.round } };
    const digest = hashTypedData(typed);
    let mpcAddress;
    await check('EIP-712 digest matches the contract', async () => [digest === (await view('get_verdict_digest', { id: m.commitment.id })), short(digest, 10)]);
    await check('MPC signature comes from this contract\'s key', async () => {
      const pk = await view('derived_public_key', { path: 'verdict-v1', predecessor: CONTRACT, domain_id: 0 }, MPC);
      mpcAddress = publicKeyToAddress(`0x04${hex(base58.decode(pk.split(':')[1]))}`);
      const { r, s, v } = m.evm_signature;
      const rec = await recoverAddress({ hash: digest, signature: serializeSignature({ r, s, v: BigInt(v) }) });
      return [rec.toLowerCase() === mpcAddress.toLowerCase(), short(rec, 8)];
    });
    await check('Base Sepolia verifier trusts that key', async () => {
      const signer = await evm.readContract({ address: FORSETI_EVM, abi: evmAbi, functionName: 'signer' });
      return [signer.toLowerCase() === mpcAddress?.toLowerCase(), short(signer, 8)];
    });
    await check('Base Sepolia records the same verdict', async () => {
      const v = await evm.readContract({ address: FORSETI_EVM, abi: evmAbi, functionName: 'verdictOf', args: [m.commitment_hash] });
      if (v.outcome === 0) return [null, 'Not relayed yet. Anyone can relay it with executor/relay.mjs.'];
      return [v.outcome === m.outcome && v.round === m.round, `${OUTCOME[v.outcome]}, round ${v.round}`];
    });
  }

  summary.innerHTML = failed
    ? `<div class="summary fail">${failed} of ${total} checks failed.</div>`
    : `<div class="summary pass">All ${passed} checks passed in your browser.${list.querySelector('.skip') ? ' Read the notes with hollow markers.' : ''}</div>`;
  button.disabled = false;
  button.textContent = 'Verify again';
}

// ---------- ask the judge ----------

function askPanel(m) {
  return `
    <form class="ask" id="ask">
      <h2>Ask the judge</h2>
      <p>Runs the committed judge on today's sources before you trade. Your key stays in this tab and goes only to cloud-api.near.ai.</p>
      <label for="key">NEAR AI Cloud API key</label>
      <input id="key" type="password" autocomplete="off" placeholder="sk-…" required>
      <button type="submit">Ask the judge</button>
      <div class="result" id="ask-result" aria-live="polite"></div>
    </form>`;
}

async function ask(e, m) {
  e.preventDefault();
  const key = document.getElementById('key').value.trim();
  const out = document.getElementById('ask-result');
  const button = e.target.querySelector('button');
  const step = (text) => (out.innerHTML = `<p class="muted">${esc(text)}</p>`);
  const p = m.commitment.params;
  button.disabled = true;
  try {
    step('Fetching the committed sources…');
    const snapshots = await Promise.all(p.sources.map(snapshot));
    step('Building the exact request on NEAR…');
    const request = await view('build_request', { id: m.commitment.id, model: p.model, snapshots, preview: true });
    step(`Asking ${p.model} inside its TEE…`);
    const auth = { Authorization: `Bearer ${key}` };
    const res = await fetch(`${AI}/chat/completions`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'x-no-aliasing': 'true' }, body: request });
    const response = await res.text();
    if (!res.ok) throw new Error(`NEAR AI answered ${res.status}: ${response.slice(0, 200)}`);
    step('Fetching the TEE signature…');
    let sig;
    for (let i = 0; i < 8 && !sig; i++) {
      const r = await fetch(`${AI}/signature/${JSON.parse(response).id}?model=${encodeURIComponent(p.model)}&signing_algo=ed25519`, { headers: auth });
      const body = await r.text();
      if (r.ok && !body.includes('error_code')) sig = JSON.parse(body);
      else await new Promise((ok) => setTimeout(ok, 1500));
    }
    if (!sig) throw new Error('NEAR AI did not return a signature for this answer.');
    const signer = sig.signing_address.replace(/^0x/, '').toLowerCase();
    const text = `${p.model}:${await sha256(request)}:${await sha256(response)}`;
    const answer = JSON.parse(JSON.parse(response).choices[0].message.content.replace(/^```(json)?|```$/g, ''));
    const i = p.sources.findIndex((s) => s.id === answer.source);
    const checks = [
      ['Signed text covers this exact request and response', sig.text === text],
      ['ed25519 signature is valid', ed25519.verify(sig.signature.replace(/^0x/, ''), utf8.encode(text), signer)],
      ['Key is registered for this model on NEAR', (await view('get_signers', { model: p.model })).includes(signer)],
      ['Quote appears in the snapshot', i >= 0 && normalizeWs(snapshots[i]).includes(normalizeWs(answer.quote ?? ''))],
    ];
    out.innerHTML = `
      <p><span class="verdict-word">${esc(answer.outcome)}</span> <span class="muted">from ${esc(p.model)}</span></p>
      ${answer.quote ? `<blockquote>${esc(answer.quote)}</blockquote>` : ''}
      <p>${esc(answer.reason)}</p>
      <ol class="checks">${checks.map(([t, ok]) => `<li class="${ok ? 'pass' : 'fail'}">${esc(t)}</li>`).join('')}</ol>
      <p class="muted">This answer is not binding. To record a preview on-chain run <code>node --env-file=../.env forseti.mjs preview ${m.commitment.id}</code>.</p>`;
  } catch (err) {
    out.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
  button.disabled = false;
}

// ---------- routing ----------

async function route() {
  const id = location.hash.match(/^#\/m\/(\d+)/)?.[1];
  try {
    await (id === undefined ? docket() : market(Number(id)));
  } catch (err) {
    app.innerHTML = `<p class="error">Could not load from NEAR testnet: ${esc(err.message)}</p>`;
  }
  app.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
addEventListener('hashchange', route);
route();
