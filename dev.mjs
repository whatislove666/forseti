// Local stand-in for Vercel: serves the site with vercel.json's rewrites and runs api/*.js.
//   npm run dev        then open http://localhost:8787
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

// The functions sign as NEAR_ACCOUNT_ID / EVM_PRIVATE_KEY. Locally those are the owner's keys, so use
// the demo relay's keys from .env instead, as on Vercel.
if (process.env.RELAY_ACCOUNT_ID) {
  process.env.NEAR_ACCOUNT_ID = process.env.RELAY_ACCOUNT_ID;
  process.env.NEAR_PRIVATE_KEY = process.env.RELAY_PRIVATE_KEY;
  process.env.EVM_PRIVATE_KEY = process.env.EVM_RELAY_PRIVATE_KEY;
}
const root = new URL('.', import.meta.url).pathname;
const { rewrites } = JSON.parse(await readFile(join(root, 'vercel.json'), 'utf8'));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.md': 'text/markdown' };

function rewrite(path) {
  for (const { source, destination } of rewrites) {
    const prefix = source.replace('/:path*', '/');
    if (source === path) return destination;
    if (source.endsWith(':path*') && path.startsWith(prefix)) return destination.replace(':path*', path.slice(prefix.length));
  }
  return path;
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    const api = url.pathname.match(/^\/api\/([a-z-]+)$/)?.[1];
    if (api) {
      const body = req.method === 'POST' ? await new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); }) : undefined;
      const { default: fn } = await import(join(root, 'api', `${api}.js`));
      const out = await fn.fetch(new Request(url, { method: req.method, headers: req.headers, body }));
      res.writeHead(out.status, Object.fromEntries(out.headers));
      return res.end(Buffer.from(await out.arrayBuffer()));
    }
    const file = join(root, normalize(rewrite(url.pathname)));
    if (!file.startsWith(root) || /\/\.env|\/\.git\//.test(file)) throw new Error('forbidden');
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }).end(data);
  } catch (e) {
    if (!res.headersSent) res.writeHead(e.code === 'ENOENT' || e.code === 'EISDIR' ? 404 : 500).end(String(e.message));
  }
}).listen(8787, () => console.log('Forseti on http://localhost:8787'));
