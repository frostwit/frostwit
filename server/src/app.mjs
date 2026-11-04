import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from '../../shared/trace/validate.mjs';
import { isAddr, isTx, norm } from '../../shared/format.mjs';
import { publicToken } from './config.mjs';
import { METRIC_KEYS } from './service.mjs';
import { casePage, packPage, packMarkdown, actionsPage, statusPage, checkPage, checkIndexPage, whatToDoPage, notFoundPage, docsPage, tokenPage } from './pages/index.mjs';
import { chrome, withCa, withRibbon, buyUrl, esc } from './pages/layout.mjs';
import { COPY } from '../../shared/copy.mjs';
import { buildPack } from '../../shared/pack.mjs';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (s) => { const d = new Date(s * 1000); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const MIME = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8', '.ico': 'image/x-icon' };

export function buildApp({ cfg, svc, db, ctx, getToken, images, log = () => {} }) {
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 4096, connectionTimeout: 30_000 });
  const pctx = { cfg, token: getToken, ctx, posterReady: false, checkLive: true };
  const refreshPoster = async () => { try { await images.load(); pctx.posterReady = images.ready(); } catch { pctx.posterReady = false; } };
  refreshPoster(); const posterTimer = setInterval(refreshPoster, 60_000); posterTimer.unref();
  app.addHook('onClose', async () => clearInterval(posterTimer));

  // JSON routes: CORS * + short cache
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api')) {
      reply.header('access-control-allow-origin', '*');
      if (req.method === 'GET' && !reply.getHeader('cache-control')) reply.header('cache-control', 'public, max-age=10');
    }
    return payload;
  });
  app.options('/api/*', async (req, reply) => reply.header('access-control-allow-origin', '*').header('access-control-allow-methods', 'GET, POST, OPTIONS').header('access-control-allow-headers', 'content-type').code(204).send());
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.code, message: err.message, ...err.extra });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'invalid_input', message: 'Bad request.' });
    log('http error', req.url, err.stack || err.message);
    return reply.code(500).send({ error: 'server_error', message: 'Something went wrong on our side.' });
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api')) return reply.code(404).send({ error: 'not_found', message: 'No such route.' });
    return reply.code(404).type('text/html; charset=utf-8').send(notFoundPage(pctx, 'Nothing here.'));
  });
  const html = (reply, s, code = 200) => reply.code(code).type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(s);
  const json = (reply, o, code = 200) => reply.code(code).send(o);
  const metric = (k) => { if (METRIC_KEYS.includes(k)) try { db.metric(k); } catch { /* ignore */ } };

  // ---------- static ----------
  const sendFile = (reply, file, cache = 'public, max-age=604800') => {
    try {
      const st = fs.statSync(file); if (!st.isFile()) throw new Error('nf');
      return reply.type(MIME[path.extname(file)] || 'application/octet-stream').header('cache-control', cache).send(fs.createReadStream(file));
    } catch { return reply.code(404).send({ error: 'not_found' }); }
  };
  app.get('/dist/*', async (req, reply) => {
    const rel = path.normalize(decodeURIComponent(req.params['*'])).replace(/^(\.\.[/\\])+/, '');
    const f = path.join(cfg.distDir, rel); if (!f.startsWith(cfg.distDir)) return reply.code(400).send();
    return sendFile(reply, f);
  });
  for (const f of ['favicon.svg', 'favicon-32.png', 'icon-192.png', 'og.jpg', 'site.webmanifest', 'apple-touch-icon.png', 'icon-512.png']) app.get('/' + f, async (req, reply) => sendFile(reply, path.join(cfg.distDir, f), 'public, max-age=86400'));
  app.get('/robots.txt', async (req, reply) => reply.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${cfg.siteUrl}/sitemap.xml\n`));
  app.get('/sitemap.xml', async (req, reply) => reply.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/issuer-actions', '/what-to-do', '/docs', '/token'].map((p) => `<url><loc>${cfg.siteUrl}${p}</loc></url>`).join('')}</urlset>`));
  app.get('/token.json', async (req, reply) => { const t = publicToken(getToken()); return reply.header('cache-control', 'no-cache').header('access-control-allow-origin', '*').send({ ...t, buyUrl: t.launched ? buyUrl(getToken()) : null }); });

  // ---------- pages ----------
  const landing = () => {
    const c = chrome(cfg.distDir); if (!c.raw) return null;
    const st = svc.stats(); let s = c.raw;
    const parts = [`<span data-k="blocked">${Number(st.blockedNow).toLocaleString('en-US')}</span> addresses blocked by Robinhood's registry`];
    if (st.lastActionAt) parts.push(`last action <span data-k="last">${day(st.lastActionAt)}</span> UTC`);
    if (st.casesTotal >= 3) parts.push(`<span data-k="cases">${st.casesTotal}</span> cases traced`);
    s = s.replace(/<!--fw:stats-->[\s\S]*?<!--\/fw:stats-->/, `<!--fw:stats-->${st.backfillDone || st.blockedNow ? parts.join(' · ') : 'indexing registry events…'}<!--/fw:stats-->`);
    return withRibbon(withCa(s, getToken()), cfg.staging);
  };
  app.get('/', async (req, reply) => { const s = landing(); if (!s) return html(reply, '<!doctype html><title>Frostwit</title><p>Frostwit is starting.</p>', 503); return html(reply, s); });
  app.get('/what-to-do', async (req, reply) => html(reply, whatToDoPage(pctx)));
  app.get('/docs', async (req, reply) => html(reply, docsPage(pctx)));
  app.get('/token', async (req, reply) => html(reply, tokenPage(pctx)));
  app.get('/404', async (req, reply) => html(reply, notFoundPage(pctx), 404));
  app.get('/issuer-actions', async (req, reply) => { metric('actions'); const d = svc.issuerActions(500); return html(reply, actionsPage(pctx, d, svc.stats(), { all: req.query.all === '1' })); });
  app.get('/status/:address', async (req, reply) => {
    if (!isAddr(req.params.address)) return html(reply, notFoundPage(pctx, 'That is not an address.'), 404);
    metric('status'); return html(reply, statusPage(pctx, await svc.addressStatus(req.params.address)));
  });
  app.get('/check', async (req, reply) => html(reply, checkIndexPage(pctx)));
  app.get('/check/:address', async (req, reply) => {
    if (!isAddr(req.params.address)) return html(reply, notFoundPage(pctx, 'That is not an address.'), 404);
    metric('check'); return html(reply, checkPage(pctx, norm(req.params.address), req.query.case));
  });
  app.get('/case/:id', async (req, reply) => {
    const v = /^[0-9a-f]{12}$/.test(req.params.id) ? svc.view(req.params.id) : null;
    if (!v) return html(reply, notFoundPage(pctx), 404);
    metric('case_view'); return html(reply, casePage(pctx, v));
  });
  app.get('/case/:id/pack', async (req, reply) => {
    const v = /^[0-9a-f]{12}$/.test(req.params.id) ? svc.view(req.params.id) : null;
    if (!v) return html(reply, notFoundPage(pctx), 404);
    metric('pack'); return html(reply, packPage(pctx, v));
  });

  // ---------- API ----------
  app.post('/api/case', async (req, reply) => {
    metric('api'); const b = req.body || {};
    if (typeof b !== 'object') throw new ApiError(400, 'invalid_input', 'Send JSON: {"input":"0x…"}');
    const r = await svc.createCase({ input: b.input, hours: b.hours, role: b.role, ip: req.ip });
    return json(reply.header('cache-control', 'no-store'), { id: r.id, status: r.status, queue: r.queue, existing: !!r.existing, url: `${cfg.siteUrl}/case/${r.id}` }, r.existing ? 200 : 201);
  });
  app.get('/api/case/:id', async (req, reply) => {
    metric('api'); const v = /^[0-9a-f]{12}$/.test(req.params.id) ? svc.view(req.params.id) : null;
    if (!v) throw new ApiError(404, 'not_found', 'No such case.');
    return json(reply.header('cache-control', 'no-cache'), v);
  });
  app.get('/api/case/:id/pack.md', async (req, reply) => {
    metric('pack'); const v = /^[0-9a-f]{12}$/.test(req.params.id) ? svc.view(req.params.id) : null;
    if (!v) throw new ApiError(404, 'not_found', 'No such case.');
    return reply.type('text/markdown; charset=utf-8').send(packMarkdown(pctx, v));
  });
  app.get('/api/issuer-actions', async (req) => { metric('api'); return svc.issuerActions(req.query.limit, req.query.cursor); });
  app.get('/api/status/:address', async (req) => { if (!isAddr(req.params.address)) throw new ApiError(400, 'invalid_input', 'Paste a Robinhood Chain address (0x + 40 hex).'); metric('api'); return svc.addressStatus(req.params.address); });
  app.get('/api/check/:address', async (req) => { if (!isAddr(req.params.address)) throw new ApiError(400, 'invalid_input', 'Paste a Robinhood Chain address (0x + 40 hex).'); metric('check'); return svc.check(req.params.address, req.query.case); });
  app.get('/api/stats', async () => { const t = getToken(); return { ...svc.stats(), head: svc.S.head || null, token: { ...publicToken(t), buyUrl: t.launched ? buyUrl(t) : null } }; });
  app.get('/api/health', async (req, reply) => json(reply.header('cache-control', 'no-cache'), svc.health()));
  app.post('/api/metric', async (req, reply) => { const k = req.body?.key; if (METRIC_KEYS.includes(k)) metric(k); return reply.code(204).send(); });
  // P2 routes: off until $FWIT exists
  app.post('/api/case/:id/priority', async (req, reply) => json(reply, await priority(req, 'priority')));
  app.post('/api/case/:id/retrace', async (req, reply) => json(reply, await priority(req, 'retrace')));
  const holderRate = new Map();
  async function priority(req, mode) {
    const t = getToken(); if (!t.launched) return { enabled: false };
    const v = svc.view(req.params.id); if (!v) throw new ApiError(404, 'not_found', 'No such case.');
    const holder = String(req.body?.holder || '').trim().toLowerCase(); if (!isAddr(holder)) throw new ApiError(400, 'invalid_input', 'Paste a holder address (0x + 40 hex).');
    const k = req.ip, arr = (holderRate.get(k) || []).filter((x) => x > Date.now() - 60_000); if (arr.length >= 5) throw new ApiError(429, 'busy', 'Too many checks, wait a minute.', { retryAfterSec: 60 }); arr.push(Date.now()); holderRate.set(k, arr);
    metric('priority');
    const bal = await svc.fwitBalance(holder); const ok = bal != null && bal >= cfg.minHold * 10n ** 18n;
    if (!ok) return { enabled: true, holder: false, balance: bal == null ? null : bal.toString(), cadenceMin: cfg.publicCadenceSec / 60, minHold: Number(cfg.minHold) };
    const n = Math.floor(Date.now() / 1000);
    if (mode === 'priority') { db.updateCase(v.id, { priority_until: n + cfg.priorityDays * 86400, priority_holder: holder, watch_until: Math.max(n + cfg.priorityDays * 86400, v.watch.until || 0) }); return { enabled: true, holder: true, balance: bal.toString(), cadenceMin: cfg.priorityCadenceSec / 60 }; }
    const last = Number(db.kv('retrace:' + v.id) || 0); if (n - last < 600) throw new ApiError(429, 'busy', 'One retrace per 10 minutes per case.', { retryAfterSec: 600 - (n - last) });
    db.setKv('retrace:' + v.id, n); db.updateCase(v.id, { status: 'queued', graph_json: null, rpc_calls: 0 }); svc.pump();
    return { enabled: true, holder: true, balance: bal.toString(), retrace: true };
  }

  // ---------- agents ----------
  const ROUTES = [
    ['POST', '/api/case', 'Open a case. Body {input, hours?: 24|72|168, role?: "thief"|"victim"}. 201 {id, status, queue}'],
    ['GET', '/api/case/:id', 'The case: seed, nodes, edges, freezable, exits, budget, checks, watch, queue, links'],
    ['GET', '/api/case/:id/pack.md', 'The freeze-request pack as markdown'],
    ['GET', '/api/issuer-actions?limit=100&cursor=', 'Every Blocked / Unblocked event of the Robinhood access registry'],
    ['GET', '/api/status/:address', "isBlocked (Robinhood registry), isFrozen (Paxos USDG) and the address's registry events"],
    ['GET', '/api/check/:address?case=', "Spenders that still hold an allowance on the address's official tokens (incl. Permit2) with the revoke calldata. Read-only: revoke sends approve(spender, 0) from your own wallet; Frostwit never signs"],
    ['GET', '/api/stats', 'Counts for the landing page'],
    ['GET', '/api/health', 'Service and RPC lane state'],
  ];
  app.get('/api', async () => ({ name: 'Frostwit', site: cfg.siteUrl, about: 'Trace stolen official Robinhood stock tokens and USDG on Robinhood Chain and see what the issuer can still freeze. ' + COPY.honesty, auth: 'none', cors: '*', limits: [COPY.limitEth, COPY.limitWindow, COPY.limitUsdg], routes: ROUTES.map(([method, p, about]) => ({ method, path: p, about })), source: 'https://github.com/frostwit/frostwit', docs: `${cfg.siteUrl}/docs#api`, llms: `${cfg.siteUrl}/llms.txt` }));
  app.get('/llms.txt', async (req, reply) => reply.type('text/plain; charset=utf-8').send([
    '# Frostwit', '', `> Drained on Robinhood Chain? Paste the theft transaction (or the thief's address). Frostwit follows official Robinhood stock tokens and USDG hop by hop, shows what the issuer can still freeze, re-checks it for 7 days and writes the freeze-request pack. ${COPY.honesty}`, '',
    `Site: ${cfg.siteUrl}`, `API index: ${cfg.siteUrl}/api`, `Docs: ${cfg.siteUrl}/docs`, 'Source: https://github.com/frostwit/frostwit', '', '## Routes', ...ROUTES.map(([m, p, a]) => `- ${m} ${p}: ${a}`), '',
    '## Limits (same words everywhere)', `- ${COPY.limitEth}`, `- ${COPY.limitWindow}`, `- ${COPY.limitUsdg}`, `- ${COPY.notAudited}`, '', '## Registry facts', "- First batch: 244 Blocked events, 175 addresses, blocks 43 543–44 953 (8–9 Jun 2026 UTC). Other events are listed individually.", '',
    '## Contacts for freeze requests', `- Robinhood: ${COPY.contacts.robinhood.url} , ${COPY.contacts.robinhood.email}`, `- Paxos (USDG): ${COPY.contacts.paxos.url}. ${COPY.paxosRule}`, '', `${COPY.noAccount}`, ''].join('\n')));

  // ---------- images ----------
  const png = (reply, buf, maxAge = 300) => reply.type('image/png').header('cache-control', `public, max-age=${maxAge}`).send(buf);
  const stats = () => { const s = svc.stats(); return { blockedNow: s.blockedNow, lastActionAt: s.lastActionAt }; };
  app.get('/og/case/:id.png', async (req, reply) => {
    const v = /^[0-9a-f]{12}$/.test(req.params.id) ? svc.view(req.params.id) : null;
    try { const buf = v && await images.ogCase(v); if (buf) return png(reply, buf); } catch (e) { log('og fail', e.message); metric('og_fail'); }
    return sendFile(reply, path.join(cfg.distDir, 'og.jpg'), 'public, max-age=300');
  });
  app.get('/img/case/:id.png', async (req, reply) => {
    const v = /^[0-9a-f]{12}$/.test(req.params.id) ? svc.view(req.params.id) : null;
    try { const buf = v && v.input.kind !== 'victim' && await images.posterGraph(v, stats()); if (buf) return png(reply, buf); } catch (e) { log('poster fail', e.message); metric('poster_fail'); }
    return reply.code(404).send({ error: 'not_found' });
  });
  app.get('/img/issuer-timeline.png', async (req, reply) => {
    try { const d = svc.issuerActions(500); const buf = await images.posterTimeline({ events: [...d.events].sort((x, y) => x.block - y.block || x.log_index - y.log_index), head: d.head || d.lastAction?.block, blockedNow: d.blockedNow, batch: d.batch }, stats()); if (buf) return png(reply, buf, 600); } catch (e) { log('timeline poster fail', e.message); metric('poster_fail'); }
    return reply.code(404).send({ error: 'not_found' });
  });
  return app;
}
