// Source snapshots, shared by the executor (Node) and the web page (browser): both must turn
// a source into exactly the same text, or the request hash will not match.
const MAX_SNAPSHOT_BYTES = 32 * 1024;

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
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** `extract` is a JSON path like `$.current` for JSON APIs, or empty for the whole page. */
export async function snapshot(source) {
  const res = await fetch(source.url, { headers: { Accept: 'application/json, text/html;q=0.9' } });
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
