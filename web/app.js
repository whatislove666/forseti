// Forseti web: reads markets from NEAR, re-runs every check in the browser, and lets anyone
// ask the committed judge with their own NEAR AI key. No backend.
// Layout follows the Forseti design system: what a newcomer needs first, how it was decided
// second, and everything technical under "For auditors".
import { snapshot } from '../executor/sources.mjs';

const CONTRACT = 'forseti.testnet';
const MPC = 'v1.signer-prod.testnet';
// Public testnet RPCs rate-limit bursts of reads; try the next one, then retry.
// rpc.testnet.near.org is deprecated and rate-limited; it stays only as a fallback.
const NEAR_RPCS = ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'];
const FORSETI_EVM = '0x374541e22a7406E8246D0774E8994fc358232121';
const AI = 'https://cloud-api.near.ai/v1';
const CODE = { 1: 'YES', 2: 'NO', 3: 'INVALID', 4: 'TOO_EARLY' };
const WORD = { 1: 'Yes', 2: 'No', 3: 'Invalid', 4: 'Too early' };
const NUM = ['No', 'One', 'Two', 'Three'];
const { seal, mark } = window.Forseti;
const app = document.getElementById('app');
document.getElementById('lockup').insertAdjacentHTML('afterbegin', mark({ size: 40 }));

// ---------- data ----------

const utf8 = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', utf8.encode(s)));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (h, n = 6) => (h.length > 2 * n + 1 ? `${h.slice(0, n)}…${h.slice(-n)}` : h);
const ms = (ns) => Number(BigInt(ns) / 1_000_000n);
const utc = (ns) => `${new Date(ms(ns)).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`;
const nearAmount = (yocto) => `${Number(BigInt(yocto) / 10n ** 18n) / 1e6} NEAR`;
const minutes = (ns) => `${Number(BigInt(ns) / 60_000_000_000n)} minutes`;
// The contract's quote check, mirrored: typographic dashes and quotes folded to ASCII, whitespace
// collapsed, and a quote may leave text out with "..." as long as every piece is in the snapshot.
// Rust's char::is_whitespace (Unicode White_Space), not JS \s: they differ on U+0085 and U+FEFF.
const RUST_WS = new Set([0x9, 0xa, 0xb, 0xc, 0xd, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);
const normalizeWs = (s) => s.replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[\u2018\u2019\u201B\u2032]/g, "'").replace(/[\u201C\u201D\u201F\u2033]/g, '"').split('').reduce((w, c) => (RUST_WS.has(c.codePointAt(0)) ? w.push('') : (w[w.length - 1] += c), w), ['']).filter(Boolean).join(' ');
const chars = (s) => [...s].length;
function quoteFound(snapshot, quote) {
  const text = normalizeWs(snapshot);
  const pieces = quote.replace(/\u2026/g, '...').split('...').map(normalizeWs).filter(Boolean);
  return pieces.length > 0 && pieces.length <= 8
    && pieces.every((p) => chars(p) >= 8 && text.includes(p))
    && pieces.some((p) => chars(p) >= 16);
}

// The model's answer as the contract reads it (strip_fence + parse_answer, same truncation).
function stripFence(s) {
  s = s.trim();
  if (!s.startsWith('```')) return s;
  const rest = s.slice(3), nl = rest.indexOf('\n');
  let body = (nl < 0 ? rest : rest.slice(nl + 1)).trimEnd();
  while (body.endsWith('```')) body = body.slice(0, -3);
  return body.trim();
}
function parseAnswer(response) {
  const a = JSON.parse(stripFence(JSON.parse(response).choices[0].message.content));
  const field = (k, max) => [...(typeof a[k] === 'string' ? a[k] : '')].slice(0, max).join('');
  return { outcome: a.outcome, source: field('source', 16), quote: field('quote', 400), reason: field('reason', 600) };
}

// The panel's decision as the contract computes it: a contested seat and TOO_EARLY count as
// INVALID, two equal votes decide, three filled seats without a majority make INVALID.
function panelDecision(votes, dispute) {
  const outs = votes.map((v, i) => (!v ? null : dispute?.contested?.[i] || v.outcome === 4 ? 3 : v.outcome)).filter((o) => o !== null);
  for (const o of [1, 2, 3]) if (outs.filter((x) => x === o).length >= 2) return o;
  return outs.length === votes.length ? 3 : null;
}
const host = (url) => { try { return new URL(url).hostname; } catch { return url; } };
// Anyone can create a market, so URLs from the chain or from replays.json become links only when
// they are http(s); anything else (javascript:, data:) is shown as plain text.
const link = (url, text) => (/^https?:\/\//i.test(url ?? '') ? `<a href="${esc(url)}" rel="noopener noreferrer">${text}</a>` : text);

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function rel(t) {
  const d = (t - Date.now()) / 1000, a = Math.abs(d);
  if (a < 3600) return rtf.format(Math.round(d / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(d / 3600), 'hour');
  return rtf.format(Math.round(d / 86400), 'day');
}

/** A failure of the network or the RPC node, as opposed to an answer from the contract. */
class NetworkError extends Error {}

async function view(method, args = {}, account = CONTRACT) {
  const bytes = utf8.encode(JSON.stringify(args));
  const args_base64 = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
  const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'optimistic', account_id: account, method_name: method, args_base64 } });
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(NEAR_RPCS[attempt % NEAR_RPCS.length], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: req, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`RPC answered ${res.status}`);
      const body = await res.json();
      // A JSON-RPC error is the node's problem (rate limit, deprecation): try the other node.
      if (body.error) throw new Error(JSON.stringify(body.error).slice(0, 200));
      // An error inside the result is the contract's answer (e.g. "no such market"): final.
      if (body.result?.error) throw Object.assign(new Error(`${method}: ${String(body.result.error).slice(0, 300)}`), { final: true });
      return JSON.parse(new TextDecoder().decode(new Uint8Array(body.result.result)));
    } catch (e) {
      if (e.final) throw e;
      last = e;
      await new Promise((ok) => setTimeout(ok, 300 * (attempt + 1)));
    }
  }
  throw new NetworkError(`${method}: NEAR RPC unreachable (${last?.message})`);
}

/** Rejects with a NetworkError if `p` takes longer than `ms`. */
const within = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new NetworkError(`${what} took longer than ${ms / 1000} s`)), ms))]);

// The crypto libraries are only needed to verify, so pages render without waiting for them.
let libsP;
function libs() {
  libsP ??= within(Promise.all([
    import('https://esm.sh/@noble/curves@1.9.7/ed25519'),
    import('https://esm.sh/@scure/base@1.2.6'),
    import('https://esm.sh/viem@2.57.16'),
    import('https://esm.sh/viem@2.57.16/accounts'),
    import('https://esm.sh/viem@2.57.16/chains'),
  ]).then(([curves, scure, viem, accounts, chains]) => ({
    ed25519: curves.ed25519,
    base58: scure.base58,
    hashTypedData: viem.hashTypedData,
    recoverAddress: viem.recoverAddress,
    serializeSignature: viem.serializeSignature,
    publicKeyToAddress: accounts.publicKeyToAddress,
    evm: viem.createPublicClient({ chain: chains.baseSepolia, transport: viem.http() }),
    evmAbi: viem.parseAbi(['function signer() view returns (address)', 'function verdictOf(bytes32) view returns ((uint8 outcome, uint32 round))']),
  })), 30_000, 'Loading the checking libraries from esm.sh');
  // A failed load is not cached, so "Check again" retries it.
  libsP.catch(() => { libsP = undefined; });
  return libsP;
}

/** Every market, 50 per view call (the contract's page size). */
async function allMarkets() {
  const count = await view('get_markets_count');
  const pages = await Promise.all(Array.from({ length: Math.ceil(count / 50) }, (_, i) => view('get_markets', { from: i * 50, limit: 50 })));
  return pages.flat();
}

// Replays of markets from other platforms: where each came from and how it settled there.
// Display metadata written by executor/replay.mjs, matched to the chain by commitment hash.
let replaysP;
const replays = () => (replaysP ??= fetch('replays.json').then((r) => (r.ok ? r.json() : [])).catch(() => []));
const sameOutcome = (m, o) => m.phase === 'Final' && WORD[m.outcome].toLowerCase() === String(o.platform_outcome).toLowerCase();
const day = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function originLine(m, o) {
  const verdict = o.note_short ? ` ${esc(o.note_short)}` : m.phase !== 'Final' ? '' : sameOutcome(m, o) ? ' Forseti agrees.' : ` <span class="differs">Forseti says ${WORD[m.outcome]}.</span>`;
  return `<span class="origin">On ${esc(o.platform)}: ${esc(o.platform_outcome)}.${verdict}</span>`;
}

function originCard(m, o) {
  // One link per site: two articles from the same outlet read as a duplicate.
  const seen = new Set();
  const refs = (o.dispute_refs ?? []).filter((u) => !seen.has(host(u)) && seen.add(host(u))).map((u) => link(u, esc(host(u).replace(/^www\./, '')))).join(', ');
  const forseti = m.phase === 'Final' ? WORD[m.outcome] : 'Not final yet';
  return `
    <section class="origin-card" aria-labelledby="origin-h">
      <h2 class="section-title" id="origin-h">${o.contested ? 'A disputed market, judged again' : 'A real market, judged again'}</h2>
      <p class="fs-plain">This market replays ${link(o.url, esc(o.title_on_platform))} on ${esc(o.platform)}, which closed on ${esc(day(o.closed))}. Forseti sealed the same question with rules adapted to public sources and let its judge decide.</p>
      ${o.contested && o.dispute_summary ? `<p class="fs-plain">${esc(o.dispute_summary)}${refs ? ` Reported by ${refs}.` : ''}</p>` : ''}
      ${o.note ? `<p class="fs-plain origin-flag">${esc(o.note)}${o.see_market !== undefined ? ` <a href="#/m/${o.see_market}">Open market ${o.see_market}</a>.` : ''}</p>` : ''}
      <dl class="versus">
        <div><dt>${esc(o.platform)}</dt><dd>${esc(o.platform_outcome)}</dd></div>
        <div class="${m.phase === 'Final' && !sameOutcome(m, o) ? 'versus-differs' : ''}"><dt>Forseti</dt><dd>${esc(forseti)}</dd></div>
      </dl>
      <p class="origin-note">The judge read today's copy of its sources, so it knows how events turned out. A replay shows how a sealed judge reads the evidence, not what any oracle would have said on the day.${m.appellant && m.appellant === m.commitment.creator ? ' Forseti appealed its own replay so that the panel of three would rule too.' : ''}</p>
    </section>`;
}

let proofIndex;
async function proofFor(responseSha) {
  proofIndex ??= fetch('../executor/proofs/index.json').then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const entry = (await proofIndex).find((p) => p.response_sha256 === responseSha);
  return entry ? fetch(`../executor/proofs/${entry.file}`).then((r) => r.json()) : null;
}

// ---------- reading a market in plain words ----------

/** Every signed answer stored for a market, oldest first, with a plain label. */
function rulings(m) {
  const p = m.commitment.params;
  // Panel votes are asked with "<round nonce>:panel"; votes from before that change used the round nonce.
  const panel = [`${m.round_nonce}:panel`, m.round_nonce];
  const list = m.previews.map((r) => ({ r, kind: 'Asked before trading', nonces: ['preview'], model: p.model }));
  if (m.proposed) list.push({ r: m.proposed, kind: "The judge's verdict", nonces: [m.round_nonce], model: p.model });
  if (m.challenge) list.push({ r: m.challenge, kind: 'A second answer', nonces: [m.round_nonce], model: p.model });
  m.panel_votes.forEach((r, i) => r && list.push({ r, kind: `Panel judge ${i + 1} of 3`, nonces: panel, model: p.panel[i] }));
  (m.dispute?.contested ?? []).forEach((r, i) => r && list.push({ r, kind: `A vote contesting panel judge ${i + 1}`, nonces: panel, model: p.panel[i] }));
  return list.sort((a, b) => (BigInt(a.r.at) < BigInt(b.r.at) ? -1 : 1));
}

/** The final outcome the contract's rules give for this market's on-chain record. */
function expectedOutcome(m) {
  if (m.appellant || m.challenge || m.panel_votes.some(Boolean)) return panelDecision(m.panel_votes, m.dispute) ?? 3;
  if (m.proposed && m.proposed.outcome !== 4) return m.proposed.outcome;
  return 3; // expired without a verdict
}

const beforeDeadline = (m) => Date.now() < ms(m.commitment.params.resolve_after);
const overturned = (m) => m.phase === 'Final' && m.proposed && m.proposed.outcome !== m.outcome;
const panelFor = (m, o) => m.panel_votes.filter((v) => v && v.outcome === o);

function sealState(m) {
  if (m.phase === 'Final') return overturned(m) ? 'overturned' : 'final';
  return { Proposed: 'proposed', Disputed: 'disputed' }[m.phase] ?? 'open';
}

function stamp(m) {
  if (m.phase === 'Final') return overturned(m)
    ? `<span class="fs-stamp fs-stamp-overturned">Final: ${WORD[m.outcome]}, overturned</span>`
    : `<span class="fs-stamp fs-stamp-final">Final: ${WORD[m.outcome]}</span>`;
  if (m.phase === 'Proposed') return `<span class="fs-stamp fs-stamp-proposed">Verdict: ${WORD[m.proposed.outcome]}, open to appeal</span>`;
  if (m.phase === 'Disputed') return '<span class="fs-stamp fs-stamp-disputed">Before the panel</span>';
  return `<span class="fs-stamp">${beforeDeadline(m) ? 'Open for trading' : 'Being decided'}</span>`;
}

function when(m) {
  const p = m.commitment.params, last = rulings(m).at(-1)?.r;
  if (m.phase === 'Final') return `Decided ${rel(ms(last?.at ?? p.resolve_after))}`;
  if (m.phase === 'Proposed') return `Appeals close ${rel(ms(m.proposed_at) + ms(p.challenge_period))}`;
  if (m.phase === 'Disputed') return 'The appeal panel is voting';
  return beforeDeadline(m) ? `Closes ${rel(ms(p.resolve_after))}` : 'Waiting for the judge';
}

/** The ruling whose words explain the answer shown at the top. */
function deciding(m) {
  if (m.phase === 'Final') return panelFor(m, m.outcome)[0] ?? m.proposed ?? m.previews.at(-1);
  return m.proposed ?? m.previews.at(-1);
}

function answerBlock(m) {
  const r = deciding(m), agreed = m.phase === 'Final' ? panelFor(m, m.outcome).length : 0;
  let word, sentence = r?.reason ?? '';
  if (m.phase === 'Final') {
    word = `<p class="fs-answer">${WORD[m.outcome]}</p>`;
    if (agreed) sentence += agreed === 3 ? ' All three judges agreed on appeal.' : ` ${NUM[agreed]} of three judges agreed on appeal.`;
  } else if (m.phase === 'Proposed') {
    word = `<p class="fs-answer">${WORD[m.proposed.outcome]}</p>`;
  } else {
    word = `<p class="fs-answer fs-answer-pending">${m.phase === 'Disputed' ? 'Before the panel' : 'Not decided yet'}</p>`;
    if (r) sentence = `Asked ${rel(ms(r.at))}, the judge said ${WORD[r.outcome].toLowerCase()}: ${r.reason}`;
  }
  return `
    <div class="fs-verdict">
      <div id="market-seal">${seal(m.commitment_hash, { state: sealState(m), size: 112 })}</div>
      <div class="fs-stack">
        ${stamp(m)}
        <h1 class="fs-question">${esc(m.commitment.params.question)}</h1>
        ${word}
        ${sentence ? `<p class="fs-plain">${esc(sentence)}</p>` : ''}
        <span class="fs-when">${esc(when(m))}</span>
      </div>
    </div>
    ${r?.quote ? evidence(m, r) : ''}`;
}

function evidence(m, r) {
  const s = m.commitment.params.sources.find((x) => x.id === r.source);
  return `<figure class="fs-quote"><code>${esc(r.quote)}</code><figcaption>The line the judge relied on, from the ${esc(r.source)} source at ${esc(host(s?.url ?? ''))}</figcaption></figure>`;
}

function timeline(m) {
  const p = m.commitment.params, ev = [];
  for (const r of m.previews) ev.push(['', 'Someone asked the judge before trading', `The judge said ${WORD[r.outcome].toLowerCase()}, ${rel(ms(r.at))}.`]);
  if (m.proposed) ev.push(['', `The judge said ${WORD[m.proposed.outcome]}`, `${utc(m.proposed.at)}, after the deadline.`]);
  if (m.challenge) ev.push(['fs-event-appeal', 'A second signed answer disagreed', 'So the appeal panel was called.']);
  if (m.appellant) ev.push(['fs-event-appeal', 'Someone appealed', `They posted a ${nearAmount(p.appeal_bond)} bond, so three judges looked again.`]);
  const votes = m.panel_votes.filter(Boolean);
  if (votes.length) {
    const counts = Object.entries(votes.reduce((c, v) => ({ ...c, [v.outcome]: (c[v.outcome] ?? 0) + 1 }), {}));
    const title = counts.length === 1 ? `${NUM[votes.length]} judge${votes.length > 1 ? 's' : ''} said ${WORD[counts[0][0]]}` : counts.map(([o, n]) => `${NUM[n]} said ${WORD[o]}`).join(', ');
    ev.push(['', title, 'Each read the source again on its own.']);
  }
  const contested = (m.dispute?.contested ?? []).filter(Boolean).length;
  if (contested) ev.push(['fs-event-appeal', `${NUM[contested]} panel vote${contested > 1 ? 's were' : ' was'} contested`, 'A second signed vote for the same seat disagreed, so that seat counts as Invalid.']);
  if (m.phase === 'Final') {
    const note = overturned(m)
      ? `The verdict was overturned${m.appellant ? ' and the bond went back to the appellant' : ''}.`
      : m.appellant ? 'The appeal was rejected and the bond went to the market creator.' : 'Nobody appealed in time.';
    ev.push(['fs-event-final', `Final: ${WORD[m.outcome]}`, `${note}${m.evm_signature ? ' The answer is signed for other chains.' : ''}`]);
  }
  if (!ev.length) return '<p class="fs-plain fs-muted">Nothing has happened yet. Before the deadline anyone can ask the judge.</p>';
  return `<ol class="fs-timeline">${ev.map(([cls, t, n]) => `<li class="fs-event ${cls}"><div class="fs-event-title">${esc(t)}</div><div class="fs-event-note">${esc(n)}</div></li>`).join('')}</ol>`;
}

function auditors(m, attest) {
  const p = m.commitment.params;
  const models = [p.model, ...p.panel].filter((v, i, a) => a.indexOf(v) === i);
  return `
    <dl class="fs-facts">
      <dt>Judge</dt><dd>${esc(p.model)}, seed ${p.seed}, temperature 0, up to ${p.max_tokens} tokens</dd>
      <dt>Appeal panel</dt><dd>${p.panel.map(esc).join('<br>')}</dd>
      <dt>Sources</dt><dd>${p.sources.map((s) => `${link(s.url, esc(s.id))}${s.url && !/^https?:\/\//i.test(s.url) ? ` <code>${esc(s.url)}</code>` : ''}${s.extract ? `, field <code>${esc(s.extract)}</code>` : ''}`).join('<br>')}</dd>
      <dt>Deadline</dt><dd>${utc(p.resolve_after)}; settles as Invalid if not final by ${utc(p.resolve_by)}</dd>
      <dt>Appeals</dt><dd>${minutes(p.challenge_period)} after a verdict, bond ${nearAmount(p.appeal_bond)}</dd>
      <dt>Created by</dt><dd>${esc(m.commitment.creator)}</dd>
      <dt>Commitment hash</dt><dd><code>${esc(m.commitment_hash)}</code><br><span class="fs-muted">The seal is drawn from this hash.</span></dd>
      <dt>Contract</dt><dd><a href="https://testnet.nearblocks.io/address/${CONTRACT}">${CONTRACT}</a>, market ${m.commitment.id}, round ${m.round}</dd>
      ${m.evm_signature ? `<dt>Signature for EVM</dt><dd><code>r ${esc(m.evm_signature.r)}<br>s ${esc(m.evm_signature.s)}<br>v ${m.evm_signature.v}</code><br>Verifier on Base Sepolia: <a href="https://sepolia.basescan.org/address/${FORSETI_EVM}">${short(FORSETI_EVM, 6)}</a></dd>` : ''}
    </dl>
    <div class="sub">The judge's instructions, fixed at creation</div>
    <p class="instructions">${esc(p.system_prompt)}</p>
    <div class="sub">Every signed answer</div>
    <dl class="fs-facts">${rulings(m).map(({ r, kind }) => `
      <dt>${esc(kind)}</dt><dd>${CODE[r.outcome]} from ${esc(r.model)}, ${utc(r.at)}<br>key <code>${short(r.signer)}</code>, snapshot <code>${short(r.snapshot_sha256.join(), 5)}</code>, submitted by ${esc(r.submitted_by)}</dd>`).join('') || '<dt>None yet</dt><dd></dd>'}
    </dl>
    <div class="sub">Secure-hardware keys of the judges</div>
    <div class="keys">${models.map((model) => keyCard(model, attest)).join('')}</div>`;
}

function keyCard(model, attest) {
  const a = attest.find((x) => x.model === model);
  if (!a) return `<article><strong>${esc(model)}</strong><div class="fs-muted">No attestation record published.</div></article>`;
  return a.nodes.map((n) => `
    <article>
      <strong>${esc(model)}</strong><br><code>${esc(n.key)}</code>
      <ul>${Object.entries(n.checks).map(([name, ok]) => `<li>${ok === null ? 'Not reachable: ' : ok ? '' : 'Failed: '}${esc(name)}</li>`).join('')}</ul>
      <div class="fs-muted">Checked ${utc(String(BigInt(Date.parse(a.at)) * 1_000_000n))} with a fresh nonce. Re-run: <code>node --env-file=../.env attest.mjs</code></div>
    </article>`).join('');
}

// ---------- landing ----------

// The landing renders at once with market 2's seal (open until 20 Nov 2026); live data fills in after.
const HERO = { id: 2, hash: '0xd6c8b6297843e02dc952b0a795f78cccf67e008e60f440cb8b92d9e35196e70a' };

function storyHtml(story) {
  return `
      <a class="story" href="#/m/${story.commitment.id}">
        <div class="story-seal">${seal(story.commitment_hash, { state: 'overturned', size: 380 })}</div>
        <div class="story-copy">
          <p class="story-kicker">Market ${story.commitment.id}, final: ${WORD[story.outcome]}, overturned</p>
          <h2 class="story-title">A forged verdict, caught on appeal.</h2>
          <p class="story-text">A dishonest executor showed the judge a copy of the weather that said 1.8 °C instead of 6.3 °C. The judge answered No, honestly, from what it saw. Someone appealed, three judges read the real source and said Yes, and the appeal bond went back.</p>
          <code class="chip">"temperature_2m":6.3</code>
          <span class="story-link">See every check for market ${story.commitment.id}</span>
        </div>
      </a>`;
}

async function landing() {
  const heroHash = HERO.hash;
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const row = (num, title, text, art, final = false) => `
      <li class="reg-row">
        <span class="reg-n${final ? ' reg-n-final' : ''}">${num}</span>
        <h3 class="reg-title">${title}</h3>
        <p class="reg-text">${text}</p>
        <div class="reg-art">${art}</div>
      </li>`;
  app.innerHTML = `
    <section class="hero" id="top">
      <div class="hero-seal" id="hero-seal" aria-hidden="true">${seal(heroHash, { state: 'open', size: 940 })}</div>
      <div class="hero-inner"><div class="hero-copy">
        <p class="hero-kicker">Sealed on NEAR. Checked by anyone.</p>
        <h1 class="hero-title">The judge is sealed before the first trade.</h1>
        <p class="hero-lede">Forseti fixes a prediction market's AI judge before trading starts: the model, its instructions, its sources and the three judges who hear appeals. After the deadline NEAR checks that this exact judge answered this exact question. Then anyone can check it again.</p>
        <div class="hero-actions">
          <a class="btn-light" href="#/markets">Verify a market</a>
          <a class="fs-btn fs-btn-quiet" href="#how" data-scroll="how">How it works</a>
        </div>
        <p class="hero-note" id="hero-note">The seal of market ${HERO.id}, drawn from its rules. Change one rule and the seal changes.</p>
      </div></div>
    </section>

    <section class="band band-wine" aria-labelledby="problem">
      <div class="band-inner band-split">
        <div class="band-main">
          <p class="band-label">The problem</p>
          <h2 class="band-statement" id="problem">On Polymarket, disputes are settled by a vote of UMA token holders, and many of the voters trade on the same platform.</h2>
          <p class="band-side">An AI judge is faster and cheaper, but only if you can tell which model answered, what it was asked and what it read.</p>
          <p class="band-source">At least 60% of active UMA voters over the past year could be linked to Polymarket trading accounts. <a href="https://thecurrency.news/articles/227498/the-mysterious-crypto-judges-who-settle-polymarket-disputes/">The Wall Street Journal, May 2026</a></p>
        </div>
        <figure class="band-quote">
          <blockquote>“The model doesn't have to be perfect; it has to be predictable.”</blockquote>
          <figcaption>Andrew Hall, a16z, <a href="https://a16zfrontier.com/posts/article/ai-judges-scale-prediction-markets/">“How AI judges can scale prediction markets”</a>, January 2026</figcaption>
        </figure>
      </div>
    </section>

    <section class="wrap" id="how">
      <h2 class="land-h2">How a market is judged</h2>
      <ol class="register-steps">
        ${row(1, 'Sealed before trading', 'The creator fixes the AI judge, its instructions, its sources and an appeal panel of three. The seal is drawn from those rules, so they cannot change quietly.', seal(heroHash, { state: 'open', size: 140 }))}
        ${row(2, 'Ask the judge first', "Before you trade, run the sealed judge on today's sources and read its signed answer. No surprises at the deadline.", '<code class="chip">"temperature_2m":6.2</code>')}
        ${row(3, 'Judged and checked on NEAR', 'The judge answers on secure hardware and signs what it was asked and what it said. The contract rebuilds the question, checks the signature and finds the quoted evidence in the source.', seal(heroHash, { state: 'proposed', size: 140 }))}
        ${row(4, 'Appealed, then final everywhere', 'Anyone who disagrees posts a bond and three judges decide by majority. The final answer is signed once by NEAR Chain Signatures and accepted on any EVM chain. Live on Base Sepolia.', seal(heroHash, { state: 'final', size: 140 }), true)}
      </ol>
    </section>

    <section class="wrap fit" aria-labelledby="fit">
      <div class="fit-copy">
        <h2 class="land-h2" id="fit">Plug it into any prediction market</h2>
        <p class="fit-lede">Forseti only decides outcomes. Your market keeps its own trading, custody and payouts, on any EVM chain, and reads one answer at the end.</p>
        <ol class="fit-steps">
          <li><strong>Seal the judge when you list the market.</strong> You get a commitment hash that changes if any rule changes.</li>
          <li><strong>Keep the hash next to your market.</strong> Traders can check that the rules they bet on are the sealed ones.</li>
          <li><strong>Read the verdict on your chain.</strong> After the deadline anyone relays it, and your contract pays out. Invalid refunds every stake.</li>
        </ol>
        <a class="fs-btn fs-btn-quiet" href="#/docs/integrate">Read the integration guide</a>
      </div>
      <figure class="fit-code">
        <figcaption>Settling a market on any EVM chain</figcaption>
        <pre><code>IForseti.Outcome o = forseti.verdictOf(commitmentHash).outcome;

if (o == IForseti.Outcome.Yes) payYes();
else if (o == IForseti.Outcome.No) payNo();
else if (o == IForseti.Outcome.Invalid) refundEveryone();
// None: no verdict yet, keep waiting</code></pre>
      </figure>
    </section>

    <section class="wrap" id="proof">
      <div id="story"></div>
      <p class="live" id="live">Reading the live numbers from NEAR…</p>
    </section>

    <section class="wrap" id="disputes" aria-labelledby="disputes-h" hidden>
      <h2 class="land-h2" id="disputes-h">Disputed markets, judged again</h2>
      <p class="fit-lede">Real markets whose outcome was fought over, sealed on Forseti with the same question and judged from public sources. Open one to read the evidence and check every step.</p>
      <ul class="disputes"></ul>
    </section>

    <section class="wrap">
      <div class="trust">
        <div class="trust-checked">
          <h3 class="trust-title trust-title-gold">Checked in your browser</h3>
          <ul>
            <li>The rules are the ones sealed at creation</li>
            <li>Each answer is signed by a registered key of the sealed model</li>
            <li>It answered the exact question NEAR rebuilt</li>
            <li>The evidence it quoted is really in the source</li>
            <li>The final answer is signed once for every EVM chain, and Base Sepolia holds it</li>
          </ul>
        </div>
        <div class="trust-assumed">
          <h3 class="trust-title">Still trusted, for now</h3>
          <ul>
            <li>That someone is watching. A forged copy of a source can be contested during the appeal window, and a contested seat counts as Invalid, so forgery ends in a refund, not a payout.</li>
            <li>That each registered key lives in secure hardware. Its attestation is checked before it is registered.</li>
            <li>The secure hardware behind NEAR AI and the NEAR signing network.</li>
            <li>The team that can still upgrade the testnet contract. It gets locked before mainnet.</li>
          </ul>
        </div>
      </div>
    </section>

    <section class="wrap">
      <h2 class="land-h2">Questions</h2>
      <dl class="faq">
        <dt>Who is Forseti for?</dt>
        <dd>Prediction markets on any EVM chain, or anywhere a secp256k1 signature can be checked. A market uses a Forseti judge instead of a token vote and reads the final answer from a small verifier contract. The demo market on Base Sepolia pays out this way.</dd>
        <dt>Which AI does the judging?</dt>
        <dd>Open models that NEAR AI Cloud runs inside secure hardware: GLM 5.3 Flash as the judge, with two Qwen models joining it on the appeal panel. Each signs its answers with a key that never leaves the hardware.</dd>
        <dt>What if the judge is wrong?</dt>
        <dd>You can ask it before you trade, and anyone can appeal its verdict to the panel. If the sources cannot settle the question, the market settles as Invalid and every stake is returned.</dd>
        <dt>What does a ruling cost?</dt>
        <dd>A fraction of a cent in model fees, plus NEAR gas. On testnet, creating a market sets aside 2 NEAR to pay for its storage.</dd>
        <dt>Is it live?</dt>
        <dd>On NEAR testnet and Base Sepolia, built at NEAR HACKATHON in November 2026.</dd>
      </dl>
    </section>

    <section class="band band-wax" id="cta">
      <div class="band-inner band-cta">
        <h2 class="cta-title">See a sealed market for yourself.</h2>
        <a class="btn-on-wax" href="#/markets">Verify a market</a>
      </div>
    </section>`;
  document.querySelector('#hero-seal svg')?.classList.add('fs-press');
  app.querySelectorAll('[data-scroll]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById(a.dataset.scroll).scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }));

  const seq = current;
  let markets = null;
  try { markets = await allMarkets(); } catch { /* keep the page, say so below */ }
  if (seq !== current) return;
  const live = document.getElementById('live');
  if (!live) return; // the visitor already left the landing
  if (!markets) { live.textContent = 'Could not reach NEAR testnet just now. Reload to see the live markets.'; return; }
  const origins = await replays();
  if (seq !== current) return;
  const byHash = new Map(origins.map((o) => [o.commitment_hash, o]));
  const disputed = markets.filter((m) => m.phase === 'Final' && byHash.get(m.commitment_hash)?.contested);
  if (disputed.length) {
    const sec = document.getElementById('disputes');
    sec.querySelector('.disputes').innerHTML = disputed.map((m) => {
      const o = byHash.get(m.commitment_hash);
      return `
        <li><a class="dispute" href="#/m/${m.commitment.id}">
          ${seal(m.commitment_hash, { state: sealState(m), size: 72 })}
          <span class="dispute-q">${esc(m.commitment.params.question)}</span>
          <dl class="versus versus-small">
            <div><dt>${esc(o.platform)}</dt><dd>${esc(o.platform_outcome)}</dd></div>
            <div class="${sameOutcome(m, o) ? '' : 'versus-differs'}"><dt>Forseti</dt><dd>${WORD[m.outcome]}</dd></div>
          </dl>
        </a></li>`;
    }).join('');
    sec.hidden = false;
  }
  const story = markets.find(overturned);
  if (story) document.getElementById('story').outerHTML = storyHtml(story);
  const finals = markets.filter((m) => m.phase === 'Final').length;
  const replayed = markets.filter((m) => byHash.has(m.commitment_hash)).length;
  live.textContent = `On testnet now: ${n(markets.length, 'market', 'markets')} sealed${replayed ? `, ${replayed} of them replays of real markets` : ''}, ${finals} final, ${markets.filter(overturned).length} overturned on appeal. Read from the contract as this page loaded.`;
  const open = markets.find((m) => m.phase === 'Open' && beforeDeadline(m));
  if (open && open.commitment_hash !== HERO.hash) {
    document.getElementById('hero-seal').innerHTML = seal(open.commitment_hash, { state: 'open', size: 940 });
    document.getElementById('hero-note').textContent = `The seal of market ${open.commitment.id}, drawn from its rules. Change one rule and the seal changes.`;
  }
}

// ---------- register ----------

async function register() {
  const seq = current;
  const [markets, origins] = await Promise.all([allMarkets(), replays()]);
  if (seq !== current) return;
  const byHash = new Map(origins.map((o) => [o.commitment_hash, o]));
  markets.sort((a, b) => (b.phase !== 'Final') - (a.phase !== 'Final') || ms(b.commitment.params.resolve_after) - ms(a.commitment.params.resolve_after));
  const row = (m) => {
    const o = byHash.get(m.commitment_hash);
    return `
      <li><a class="fs-market" href="#/m/${m.commitment.id}">
        ${seal(m.commitment_hash, { state: sealState(m), size: 40 })}
        <span class="fs-market-body"><span class="fs-market-q">${esc(m.commitment.params.question)}</span>${o ? originLine(m, o) : ''}</span>
        <span class="fs-market-meta">${stamp(m)}<span class="fs-when">${esc(when(m))}</span></span>
      </a></li>`;
  };
  const group = (title, text, list) => (list.length ? `
    <section class="reg-group">
      <div class="reg-group-head"><h2 class="section-title">${title} <span class="reg-count">${list.length}</span></h2><p class="fs-plain fs-muted">${text}</p></div>
      <ul class="fs-register">${list.map(row).join('')}</ul>
    </section>` : '');
  const kind = (m) => (byHash.get(m.commitment_hash)?.contested ? 'disputed' : byHash.has(m.commitment_hash) ? 'replay' : 'demo');
  const platforms = [...new Set(origins.map((o) => o.platform))].join(' and ');
  app.innerHTML = `
    <div class="page-head">
      <h1 class="page-title">Markets</h1>
      <p class="fs-plain fs-muted">Every market here has its judge sealed on NEAR before it was decided. Open one to see the answer, how it was decided, and to check every step yourself.</p>
    </div>
    ${group('Disputed on their platform', 'Markets whose official outcome was fought over, sealed again here and judged from public sources, next to what the platform decided.', markets.filter((m) => kind(m) === 'disputed'))}
    ${group('Replays of real markets', `Markets that already settled${platforms ? ` on ${esc(platforms)}` : ''}, sealed again with the same question and judged by Forseti. Each links to the original.`, markets.filter((m) => kind(m) === 'replay'))}
    ${group('Demos', 'Markets made to show each path: a verdict upheld on appeal, a forged verdict overturned by the panel, and one still open where you can ask the judge.', markets.filter((m) => kind(m) === 'demo'))}
    <p class="register-note">${markets.length} markets on ${CONTRACT}. Each seal is drawn from the market's commitment, so it changes if the rules do.</p>`;
}

// ---------- market ----------

async function market(id) {
  const seq = current;
  const [m, attest, origins, dispute] = await Promise.all([view('get_market', { id }), fetch('../executor/attestations.json').then((r) => (r.ok ? r.json() : [])).catch(() => []), replays(), view('get_dispute', { id }).catch(() => null)]);
  if (seq !== current) return;
  m.dispute = dispute;
  const origin = origins.find((o) => o.commitment_hash === m.commitment_hash);
  const open = m.phase === 'Open' && beforeDeadline(m);
  app.innerHTML = `
    <a class="back" href="#/markets">All markets</a>
    <div class="case">
      <div class="case-main">
        ${answerBlock(m)}
        ${origin ? originCard(m, origin) : ''}
        <details class="fs-details" ${m.phase === 'Open' ? '' : 'open'}><summary>How it was decided</summary>${timeline(m)}</details>
        <details class="fs-details"><summary>For auditors</summary>${auditors(m, attest)}</details>
      </div>
      <aside class="case-side">
        <section class="fs-panel">
          <h2 class="section-title">Check it yourself</h2>
          <p class="fs-plain fs-muted" style="margin-top:8px">Your browser re-checks this market against NEAR and Base Sepolia, with no Forseti server in between.</p>
          <div class="check-actions" style="margin-top:16px">
            <button class="fs-btn fs-btn-primary" id="verify">Check it yourself</button>
            <button class="fs-btn fs-btn-quiet" id="details" hidden>Show details</button>
          </div>
          <ol class="fs-checks" id="checks"></ol>
          <div id="summary" role="status" aria-live="polite"></div>
        </section>
        ${open ? askPanel() : ''}
      </aside>
    </div>`;
  document.getElementById('verify').addEventListener('click', (e) => verify(m, attest, e.target));
  document.getElementById('details').addEventListener('click', (e) => {
    const shown = document.getElementById('checks').classList.toggle('show-details');
    e.target.textContent = shown ? 'Hide details' : 'Show details';
  });
  if (open) document.getElementById('ask').addEventListener('submit', (e) => ask(e, m));
}

// ---------- verification ----------

const isNetwork = (e) => e instanceof NetworkError || e instanceof TypeError || /HttpRequestError|TimeoutError|AbortError/.test(e?.name ?? '');

async function verify(m, attest, button) {
  button.disabled = true;
  button.textContent = 'Checking…';
  const list = document.getElementById('checks');
  const summary = document.getElementById('summary');
  list.innerHTML = '';
  summary.innerHTML = '';
  let total = 0, passed = 0, failed = 0, unreachable = 0;
  const group = (title) => list.insertAdjacentHTML('beforeend', `<li class="fs-check-group">${esc(title)}</li>`);
  // ok: true passed, false failed, null a note; a network failure is reported apart from a failed check.
  const check = async (title, fn) => {
    const li = document.createElement('li');
    li.className = 'fs-check';
    li.textContent = title;
    list.append(li);
    let ok, detail, net = false;
    try { [ok, detail] = await within(fn(), 20_000, 'This check'); } catch (e) { if (isNetwork(e)) [net, detail] = [true, e.message]; else [ok, detail] = [false, e.message]; }
    li.classList.add(net || ok === null ? 'fs-check-note' : ok ? 'fs-check-pass' : 'fs-check-fail');
    if (net) li.prepend('Not checked, the network did not answer: ');
    else if (ok === false) li.prepend('Failed: ');
    if (detail) li.insertAdjacentHTML('beforeend', `<small>${esc(detail)}</small>`);
    if (net) unreachable++;
    else if (ok !== null) { total++; passed += ok ? 1 : 0; failed += ok ? 0 : 1; }
  };
  const done = (html) => {
    summary.innerHTML = html;
    document.getElementById('details').hidden = false;
    button.disabled = false;
    button.textContent = 'Check again';
  };

  let L;
  try { L = await libs(); } catch (e) { return done(`<div class="fs-summary fs-summary-fail">Could not load the checking code: ${esc(e.message)}. Check again in a moment.</div>`); }
  const { ed25519, base58, hashTypedData, recoverAddress, serializeSignature, publicKeyToAddress, evm, evmAbi } = L;
  const attested = JSON.stringify(attest ?? []);

  group('The rules');
  await check('The rules are the ones fixed at creation', async () => {
    const h = `0x${await sha256(JSON.stringify(m.commitment))}`;
    return [h === m.commitment_hash, `sha256 of the terms = ${short(h, 10)}`];
  });

  const keys = {};
  for (const { r, kind, nonces, model } of rulings(m)) {
    group(`${kind}: ${WORD[r.outcome]}`);
    await check(kind.startsWith('Panel') || kind.startsWith('A vote') ? 'The model sealed for this panel seat answered' : 'The sealed judge answered', async () => [r.model === model, r.model]);
    await check('The signing hardware is registered for this judge', async () => {
      keys[r.model] ??= await view('get_signers', { model: r.model });
      if (keys[r.model].includes(r.signer)) return [true, `${r.model}, key ${short(r.signer)}`];
      // NEAR AI rotates keys; a key that was attested and registered when it signed stays valid evidence.
      if (attested.includes(r.signer)) return [null, `Key ${short(r.signer)} was attested and registered, and has since been rotated out of the registry.`];
      return [false, `${r.model}, key ${short(r.signer)} is not registered`];
    });
    await check('The answer is stored unchanged', async () => [(await sha256(r.response)) === r.response_sha256, `sha256 ${short(r.response_sha256, 8)}`]);
    await check('The answer is signed by secure hardware', async () => {
      const text = `${r.model}:${r.request_sha256}:${r.response_sha256}`;
      return [ed25519.verify(r.signature, utf8.encode(text), r.signer), `ed25519 over "${short(text, 14)}"`];
    });
    await check('The recorded answer is the signed one', async () => {
      const a = parseAnswer(r.response);
      const same = a.outcome === CODE[r.outcome] && a.source === r.source && a.quote === r.quote && a.reason === r.reason;
      return [same, `outcome, source, quote and reason match the signed response`];
    });
    const bundle = await proofFor(r.response_sha256);
    if (bundle?.forged_by_dishonest_executor) {
      await check('This copy of the source was edited before the judge saw it', async () => [null, 'Marked by the dishonest-executor demo. The checks still pass: they prove what the judge saw, not that it was true.']);
    }
    if (!bundle) {
      await check('The copy of the source is not published', async () => [null, 'The checks above use on-chain data only.']);
      continue;
    }
    await check('The published copy of the source is the one used', async () => {
      const hs = await Promise.all(bundle.snapshots.map(sha256));
      return [hs.join() === r.snapshot_sha256.join(), `${hs.length} snapshot(s), sha256 ${short(hs.join(), 5)}`];
    });
    await check('NEAR rebuilds the exact question the judge was asked', async () => {
      for (const nonce of nonces) {
        const req = await view('rebuild_request', { id: m.commitment.id, model: r.model, snapshots: bundle.snapshots, nonce });
        if ((await sha256(req)) === r.request_sha256) return [true, `rebuild_request with nonce ${nonce}`];
      }
      return [false, `no nonce of this round (${nonces.join(', ')}) gives the signed request`];
    });
    if (r.outcome === 1 || r.outcome === 2) {
      await check('The quote is really in the source', async () => {
        const i = m.commitment.params.sources.findIndex((s) => s.id === r.source);
        return [i >= 0 && quoteFound(bundle.snapshots[i], r.quote), `source "${r.source}"`];
      });
    }
  }

  const round = [m.proposed, m.challenge, ...m.panel_votes].filter(Boolean);
  if (round.length > 1) {
    group('Evidence across the round');
    const seen = [...new Set(round.map((r) => r.snapshot_sha256.join()))];
    await check(seen.length === 1 ? 'Every judge saw the same copy of the source' : 'The judges saw different copies of the source', async () => {
      if (seen.length === 1) return [true, short(seen[0], 5)];
      const by = round.map((r) => `${r === m.proposed ? 'verdict' : r.model}: ${short(r.snapshot_sha256.join(), 5)}`).join('; ');
      return [null, `The judges saw different copies (${by}). The panel's majority decided.`];
    });
  }

  if (m.phase === 'Final') {
    group('The final answer');
    await check("The final answer follows the market's rules", async () => {
      const want = expectedOutcome(m);
      return [want === m.outcome, `recomputed from the record: ${WORD[want]}`];
    });
  }

  if (m.phase === 'Final' && !m.evm_signature) {
    await check('Not signed for other chains yet', async () => [null, 'Anyone can call finalize again to ask NEAR Chain Signatures for the signature.']);
  }
  if (m.phase === 'Final' && m.evm_signature) {
    group('Other chains');
    const typed = { domain: { name: 'Forseti', version: '1' }, types: { Verdict: [{ name: 'commitmentHash', type: 'bytes32' }, { name: 'outcome', type: 'uint8' }, { name: 'round', type: 'uint32' }] }, primaryType: 'Verdict', message: { commitmentHash: m.commitment_hash, outcome: m.outcome, round: m.round } };
    const digest = hashTypedData(typed);
    const mpcAddress = view('derived_public_key', { path: 'verdict-v1', predecessor: CONTRACT, domain_id: 0 }, MPC)
      .then((pk) => publicKeyToAddress(`0x04${hex(base58.decode(pk.split(':')[1]))}`));
    mpcAddress.catch(() => {}); // each check below reports its own failure
    await check('The final answer is the one signed for other chains', async () => [digest === (await view('get_verdict_digest', { id: m.commitment.id })), `EIP-712 digest ${short(digest, 10)}`]);
    await check("The signature comes from this contract's key", async () => {
      const { r, s, v } = m.evm_signature;
      const rec = await recoverAddress({ hash: digest, signature: serializeSignature({ r, s, v: BigInt(v) }) });
      return [rec.toLowerCase() === (await mpcAddress).toLowerCase(), `Chain Signatures key ${short(rec, 8)}`];
    });
    await check('Base Sepolia trusts that key', async () => {
      const signer = await evm.readContract({ address: FORSETI_EVM, abi: evmAbi, functionName: 'signer' });
      return [signer.toLowerCase() === (await mpcAddress).toLowerCase(), `Forseti.sol signer() ${short(signer, 8)}`];
    });
    await check('Base Sepolia records the same answer', async () => {
      const v = await evm.readContract({ address: FORSETI_EVM, abi: evmAbi, functionName: 'verdictOf', args: [m.commitment_hash] });
      if (v.outcome === 0) return [null, 'Not relayed yet. Anyone can relay it with executor/relay.mjs.'];
      return [v.outcome === m.outcome && v.round === m.round, `verdictOf = ${CODE[v.outcome]}, round ${v.round}`];
    });
  }

  const notes = list.querySelectorAll('.fs-check-note').length - unreachable;
  const noteText = notes ? ` ${notes === 1 ? 'One note' : `${notes} notes`} to read.` : '';
  if (failed) return done(`<div class="fs-summary fs-summary-fail">${failed} of ${total} checks failed.</div>`);
  if (unreachable) return done(`<div class="fs-summary">${passed} checks passed. ${unreachable} could not run because the network did not answer; check again in a moment.</div>`);
  done(`<div class="fs-summary fs-summary-pass">${passed === 1 ? 'The one check' : `All ${passed} checks`} passed in your browser.${noteText}</div>`);
  const sealSvg = document.querySelector('#market-seal svg');
  sealSvg?.classList.remove('fs-press');
  void sealSvg?.getBoundingClientRect();
  sealSvg?.classList.add('fs-press');
}

// ---------- ask the judge ----------

function askPanel() {
  return `
    <form class="fs-panel ask" id="ask">
      <h2 class="section-title">Ask the judge</h2>
      <p class="fs-plain fs-muted">See how the judge reads today's sources before you trade. Your key stays in this tab and goes only to NEAR AI.</p>
      <div class="fs-field"><label for="key">NEAR AI key</label><input id="key" class="fs-input" type="password" autocomplete="off" required></div>
      <div><button class="fs-btn fs-btn-primary" type="submit">Ask the judge</button></div>
      <div class="result" id="ask-result" aria-live="polite"></div>
    </form>`;
}

async function ask(e, m) {
  e.preventDefault();
  const key = document.getElementById('key').value.trim();
  const out = document.getElementById('ask-result');
  const button = e.target.querySelector('button');
  const step = (text) => (out.innerHTML = `<p class="fs-plain fs-muted">${esc(text)}</p>`);
  const p = m.commitment.params;
  button.disabled = true;
  try {
    const { ed25519 } = await libs();
    step('Reading the sources…');
    const snapshots = await Promise.all(p.sources.map(snapshot));
    step('Getting the exact question from NEAR…');
    const request = await view('build_request', { id: m.commitment.id, model: p.model, snapshots, preview: true });
    step('Asking the judge on secure hardware…');
    const auth = { Authorization: `Bearer ${key}` };
    const res = await fetch(`${AI}/chat/completions`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'x-no-aliasing': 'true' }, body: request });
    const response = await res.text();
    if (!res.ok) throw new Error(`NEAR AI answered ${res.status}: ${response.slice(0, 200)}`);
    step('Checking the signature…');
    let sig;
    for (let i = 0; i < 8 && !sig; i++) {
      const r = await fetch(`${AI}/signature/${JSON.parse(response).id}?model=${encodeURIComponent(p.model)}&signing_algo=ed25519`, { headers: auth });
      const body = await r.text();
      if (r.ok && !body.includes('error_code')) sig = JSON.parse(body);
      else await new Promise((ok) => setTimeout(ok, 1500));
    }
    if (!sig) throw new Error('NEAR AI did not return a signature for this answer. Try again in a minute.');
    const signer = sig.signing_address.replace(/^0x/, '').toLowerCase();
    const text = `${p.model}:${await sha256(request)}:${await sha256(response)}`;
    const answer = parseAnswer(response);
    const i = p.sources.findIndex((s) => s.id === answer.source);
    const checks = [
      ['The answer is about this exact question', sig.text === text],
      ['It is signed by secure hardware', ed25519.verify(sig.signature.replace(/^0x/, ''), utf8.encode(text), signer)],
      ['That hardware is registered for this judge', (await view('get_signers', { model: p.model })).includes(signer)],
      ['The quote is really in the source', i >= 0 && quoteFound(snapshots[i], answer.quote ?? '')],
    ];
    const word = { YES: 'Yes', NO: 'No', INVALID: 'Invalid', TOO_EARLY: 'Too early' }[answer.outcome] ?? answer.outcome;
    out.innerHTML = `
      <p class="fs-plain"><strong>${esc(word)}.</strong> ${esc(answer.reason)}</p>
      ${answer.quote ? `<figure class="fs-quote"><code>${esc(answer.quote)}</code></figure>` : ''}
      <ol class="fs-checks">${checks.map(([t, ok]) => `<li class="fs-check ${ok ? 'fs-check-pass' : 'fs-check-fail'}">${ok ? '' : 'Failed: '}${esc(t)}</li>`).join('')}</ol>
      <p class="fs-when">Not binding. The verdict comes after the deadline.</p>`;
  } catch (err) {
    out.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
  button.disabled = false;
}

// ---------- routing ----------

function loading(text) {
  return `<div class="loading" role="status">${mark({ size: 56, title: 'Loading' })}<p>${esc(text)}</p></div>`;
}

// ---------- docs and roadmap: Markdown from docs/, shared with GitHub ----------

const DOCS = [['overview', 'Overview'], ['integrate', 'Integrate'], ['write-a-market', 'Write a market'], ['verification', 'How a verdict is checked'], ['reference', 'Reference']];
const REPO = 'https://github.com/whatislove666/forseti';
let markedP;
async function md(name) {
  markedP ??= import('https://esm.sh/marked@17.0.6').then((m) => m.marked);
  const [marked, text] = await Promise.all([markedP, fetch(`../docs/${name}.md`).then((r) => {
    if (!r.ok) throw new Error(`docs/${name}.md: HTTP ${r.status}`);
    return r.text();
  })]);
  // Links between the Markdown files become routes of this page.
  return marked.parse(text.replace(/\]\(([a-z-]+)\.md\)/g, (_, n) => `](#/${n === 'roadmap' ? 'roadmap' : `docs/${n}`})`));
}

async function docs(slug) {
  const name = DOCS.some(([s]) => s === slug) ? slug : 'overview';
  const seq = current;
  const html = await md(name);
  if (seq !== current) return;
  app.innerHTML = `
    <div class="docs">
      <nav class="docs-nav" aria-label="Docs">
        ${DOCS.map(([s, t]) => `<a href="#/docs/${s}"${s === name ? ' aria-current="page"' : ''}>${t}</a>`).join('')}
        <a class="docs-src" href="${REPO}/tree/main/docs">Docs on GitHub</a>
      </nav>
      <article class="doc">${html}</article>
    </div>`;
  document.title = `${DOCS.find(([s]) => s === name)[1]} · Forseti docs`;
}

async function roadmap() {
  const seq = current;
  const html = await md('roadmap');
  if (seq !== current) return;
  app.innerHTML = `<article class="doc roadmap">${html}</article>`;
  // Each horizon becomes a section on the timeline: its heading, then its items.
  const doc = app.querySelector('.roadmap');
  doc.querySelectorAll('h2').forEach((h, i) => {
    const sec = document.createElement('section');
    sec.className = `phase${i === 0 ? ' phase-done' : ''}`;
    h.before(sec);
    sec.append(h);
    while (sec.nextSibling && sec.nextSibling.nodeName !== 'H2') sec.append(sec.nextSibling);
  });
}

const TITLES = { home: 'Forseti', markets: 'Forseti markets', docs: 'Forseti docs', roadmap: 'Forseti roadmap' };

// Each navigation bumps `current`; a page whose data arrives after the visitor moved on does not paint.
let current = 0;

async function route() {
  const seq = ++current;
  const path = location.hash.slice(1);
  const id = path.match(/^[/]m[/](\d+)/)?.[1];
  const page = id !== undefined || path.startsWith('/markets') ? 'markets' : path.startsWith('/docs') ? 'docs' : path.startsWith('/roadmap') ? 'roadmap' : 'home';
  document.querySelectorAll('[data-nav]').forEach((a) => (a.dataset.nav === page ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  document.title = TITLES[page];
  app.classList.toggle('wide', page === 'home');
  window.scrollTo(0, 0);
  // Markets always read NEAR, so say so at once; docs usually arrive before a loader would help.
  let slow = 0;
  if (page === 'markets') app.innerHTML = loading(id !== undefined ? `Reading market ${id} from NEAR…` : 'Reading the markets from NEAR…');
  else if (page !== 'home') slow = setTimeout(() => { if (seq === current) app.innerHTML = loading(`Opening the ${page}…`); }, 200);
  try {
    if (id !== undefined) await market(Number(id));
    else if (page === 'markets') await register();
    else if (page === 'docs') await docs(path.split('/')[2]);
    else if (page === 'roadmap') await roadmap();
    else await landing();
  } catch (err) {
    if (seq === current) {
      app.innerHTML = /no such market/.test(err.message)
        ? `<p class="error">There is no market ${esc(id)} on ${CONTRACT}. <a href="#/markets">See all markets</a>.</p>`
        : page === 'markets' || page === 'home'
          ? `<p class="error">Could not read from NEAR testnet: ${esc(err.message)}. Reload to try again.</p>`
          : `<p class="error">Could not open this page: ${esc(err.message)}. Reload to try again.</p>`;
    }
  }
  clearTimeout(slow);
  if (seq === current) app.focus({ preventScroll: true });
}
addEventListener('hashchange', route);
route();
