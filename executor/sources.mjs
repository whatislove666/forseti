// Source snapshots and answer parsing, shared by the executor (Node) and the web page (browser):
// both must turn a source into exactly the same text, or the request hash will not match.
const MAX_SNAPSHOT_BYTES = 32 * 1024;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Cleans fetched text before the model sees it: strips invisible and smuggled characters
 *  and defuses anything that looks like our <source> delimiter (prompt injection). */
export function normalize(text) {
  let t = text
    .normalize('NFKC')
    .replace(/[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFE00-\uFE0F\uFEFF]/g, '') // zero-width, bidi, soft hyphen, variation selectors
    .replace(/[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu, '') // tag characters ("ASCII smuggling"), more variation selectors
    .replace(/\u0085/g, '\n') // NEL: whitespace to the contract (Rust), not to JS \s, so make it a newline first
    // Defuses "<source", "</source", "< / SOURCE"...: the contract rejects any snapshot that still has one.
    .replace(/<(\s*\/?\s*source)/gi, '‹$1')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const bytes = new TextEncoder().encode(t);
  if (bytes.length > MAX_SNAPSHOT_BYTES) t = new TextDecoder().decode(bytes.subarray(0, MAX_SNAPSHOT_BYTES)).replace(/�$/, '');
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
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&'); // last, so "&amp;lt;" stays "&lt;"
}

/** res.text() with a size cap, so a huge page cannot exhaust memory. Same UTF-8 decoding. */
async function readText(res, source) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (let r, size = 0; !(r = await reader.read()).done; ) {
    if ((size += r.value.length) > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error(`${source.id}: response over ${MAX_BODY_BYTES >> 20} MB from ${source.url}`);
    }
    text += decoder.decode(r.value, { stream: true });
  }
  return text + decoder.decode();
}

/** `extract` is a JSON path like `$.current` for JSON APIs, or empty for the whole page. */
export async function snapshot(source) {
  // Wikipedia throttles clients that do not name themselves (other sites, like bls.gov, block
  // unknown names, so only Wikipedia gets one). Browsers always send their own User-Agent.
  const headers = { Accept: 'application/json, text/html;q=0.9' };
  if (typeof window === 'undefined' && /(^|\.)wikipedia\.org$/.test(new URL(source.url).hostname)) {
    headers['User-Agent'] = 'ForsetiExecutor/0.1 (https://github.com/whatislove666/forseti)';
  }
  // A fresh 20 s timeout per attempt; it also covers reading the body.
  const get = () => fetch(source.url, { headers, signal: AbortSignal.timeout(20_000) });
  let res = await get();
  for (let i = 0; i < 3 && (res.status === 429 || res.status >= 500); i++) {
    await new Promise((ok) => setTimeout(ok, 5000 * (i + 1)));
    res = await get();
  }
  if (!res.ok) throw new Error(`${source.id}: HTTP ${res.status} from ${source.url}`);
  const body = await readText(res, source);
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

/** Reads the judge's answer the way the contract's parse_answer and strip_fence do (trim, drop a
 *  ``` line with any tag, drop trailing ```), so the executor never rejects what the chain accepts. */
export function parseAnswer(response) {
  const content = JSON.parse(response).choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('response has no message content');
  let s = content.trim();
  if (s.startsWith('```')) {
    const rest = s.slice(3);
    const nl = rest.indexOf('\n');
    s = (nl < 0 ? rest : rest.slice(nl + 1)).trimEnd().replace(/(```)+$/, '').trim();
  }
  let a;
  try {
    a = JSON.parse(s);
  } catch {
    throw new Error("the model's answer is not JSON");
  }
  if (!['YES', 'NO', 'INVALID', 'TOO_EARLY'].includes(a?.outcome)) throw new Error("the model's answer has no valid outcome");
  return a;
}
