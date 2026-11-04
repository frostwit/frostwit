// LANDING dev server (local only, not deployed): serves web/dist, mocks /api/stats + /api/issuer-actions + /api/case
// from the dev mocks (or fixtures/ when present), renders posters with server/src/og/templates.
// node web/src/scene/dev/serve.mjs [port]   (LIVE=1: anything not built locally is proxied from https://frostwit.pro)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPoster, ogDefault, renderOg, hEl } from '../../../../server/src/og/templates/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const at = (...p) => path.join(root, ...p);
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const tlFile = fs.existsSync(at('fixtures/issuer-events.json')) ? at('fixtures/issuer-events.json') : at('web/src/scene/dev/mock-issuer-events.json');
const graphFile = fs.existsSync(at('fixtures/case-example.json')) ? at('fixtures/case-example.json') : at('web/src/scene/dev/mock-graph.json');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const cache = new Map();
const port = Number(process.argv[2] || 4899);

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  try {
    const tl = read(tlFile);
    const events = tl.events || tl;
    const head = tl.head ?? tl.recordedAtHead ?? Math.max(...events.map((e) => e.block)) + 1000;
    if (!process.env.LIVE && u.pathname === '/api/stats') return send(200, JSON.stringify({ blockedNow: tl.blockedNow ?? 247, lastActionAt: events.at(-1)?.time, eventsTotal: events.length, casesTotal: 0, rpcOk: true, backfillDone: true, head }));
    if (!process.env.LIVE && u.pathname === '/api/issuer-actions') return send(200, JSON.stringify({ events, blockedNow: tl.blockedNow ?? 247, lastAction: events.at(-1), backfillDone: true, head }));
    if (u.pathname === '/api/case/mock') return send(200, JSON.stringify(read(graphFile)));
    if ((!process.env.LIVE && u.pathname === '/img/issuer-timeline.png') || u.pathname === '/img/case/mock.png') {
      const key = u.pathname;
      if (!cache.has(key)) {
        const g = read(graphFile);
        cache.set(key, await renderPoster(key.includes('case') ? { kind: 'graph', graph: g.graph || g } : { kind: 'timeline', events, head, blockedNow: tl.blockedNow }));
      }
      return send(200, cache.get(key), 'image/png');
    }
    if (u.pathname === '/og.png') {
      const poster = await renderPoster({ kind: 'timeline', events, head, blockedNow: tl.blockedNow }, { width: 1200 });
      return send(200, await renderOg(ogDefault(hEl, { posterPng: 'data:image/png;base64,' + poster.toString('base64'), blockedNow: tl.blockedNow, lastActionAt: events.at(-1)?.time })), 'image/png');
    }
    let p = u.pathname === '/' ? '/dist/index.html' : u.pathname;
    if (p.startsWith('/dev/')) p = '/web/src/scene/dev/' + p.slice(5); else if (!p.startsWith('/dist/')) p = '/dist' + p;
    const file = p.startsWith('/web/') ? at(p) : at('web', p);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return send(200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
    if (process.env.LIVE) {
      const r = await fetch('https://frostwit.pro' + req.url, { method: req.method, headers: { accept: req.headers.accept || '*/*', 'content-type': req.headers['content-type'] || 'application/json' }, body: req.method === 'POST' ? await new Promise((ok) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => ok(b)); }) : undefined });
      return send(r.status, Buffer.from(await r.arrayBuffer()), r.headers.get('content-type') || 'application/octet-stream');
    }
    send(404, 'not found', 'text/plain');
  } catch (e) { console.error(e); send(500, String(e.stack || e), 'text/plain'); }
}).listen(port, () => console.log('dev on http://localhost:' + port));
