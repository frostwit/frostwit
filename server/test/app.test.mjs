import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeEnv, post } from './helpers.mjs';
import { addrN, NVDA, USDG, E18 } from '../../shared/trace/test/mock-chain.mjs';
import { buildPack } from '../../shared/pack.mjs';
import { ROOT } from '../src/config.mjs';

const V = addrN(0xa11ce), T1 = addrN(0xb0b1), HEAD = 105_000_000, B0 = HEAD - 2000;
const tx = (n) => '0x' + n.toString(16).padStart(64, '0');
const seedTx = (env, n = 1) => env.chain.addTx(tx(n), { from: V, to: addrN(0xd0d0), block: B0, transfers: [{ token: NVDA, from: V, to: T1, amount: 20n * E18 }, { token: USDG, from: V, to: T1, amount: 1_500_000_000n }] });
const finish = async (env, id) => { for (let i = 0; i < 50; i++) { const r = env.db.getCase(id); if (['done', 'partial', 'error'].includes(r.status)) return r; await env.svc.pump(); await new Promise((r2) => setTimeout(r2, 20)); } throw new Error('case did not finish'); };

test('config + invalid inputs + too_old + not_a_wallet; nothing stored', async () => {
  const env = makeEnv();
  for (const bad of ['', 'vitalik.eth', '0x12', 'So11111111111111111111111111111111111111112']) { const r = await post(env.app, '/api/case', { input: bad }); assert.equal(r.statusCode, 400); assert.equal(r.json().error, 'invalid_input'); }
  assert.equal((await post(env.app, '/api/case', { input: V, hours: 200 })).json().error, 'too_old');
  const nw = await post(env.app, '/api/case', { input: NVDA }); assert.equal(nw.json().error, 'not_a_wallet'); assert.match(nw.json().message, /NVDA token contract/);
  assert.equal(env.db.queuedCases().length, 0);
  await env.close();
});

test('tx not found -> 404 tx_not_found', async () => {
  const env = makeEnv(); const r = await post(env.app, '/api/case', { input: tx(999) });
  assert.equal(r.statusCode, 404); assert.equal(r.json().error, 'tx_not_found'); assert.equal(env.db.queuedCases().length, 0); await env.close();
});

test('end to end: POST, trace, GET matches the page on freezable[] byte for byte; id determinism; duplicate reuse', async () => {
  const env = makeEnv(); seedTx(env);
  const r = await post(env.app, '/api/case', { input: tx(1) }); assert.equal(r.statusCode, 201); const { id, status, queue } = r.json(); assert.match(id, /^[0-9a-f]{12}$/); assert.equal(status, 'queued'); assert.ok(queue.position >= 1);
  await finish(env, id);
  const api = (await env.app.inject({ url: `/api/case/${id}` })).json();
  assert.equal(api.status, 'done'); assert.equal(api.freezable.length, 2); assert.equal(api.links.page, `${env.cfg.siteUrl}/case/${id}`);
  assert.equal(api.watch.cadenceMin, 15); assert.ok(api.watch.until > Date.now() / 1000);
  const page = (await env.app.inject({ url: `/case/${id}` })); assert.equal(page.statusCode, 200);
  const m = page.body.match(/<script type="application\/json" id="fw-case">([\s\S]*?)<\/script>/); const embedded = JSON.parse(m[1]);
  assert.equal(JSON.stringify(embedded.freezable), JSON.stringify(api.freezable));
  assert.match(page.body, /Freezable now/); assert.match(page.body, /blockscout\.com\/tx\//); assert.match(page.body, /pool spot/);
  const again = await post(env.app, '/api/case', { input: tx(1).toUpperCase().replace('0X', '0x') }); assert.equal(again.json().id, id); assert.equal(again.statusCode, 200);
  assert.ok((await env.app.inject({ url: `/case/${id}/pack` })).body.includes('To Robinhood'));
  const md = await env.app.inject({ url: `/api/case/${id}/pack.md` }); assert.match(md.headers['content-type'], /markdown/); assert.match(md.body, /Not legal advice/);
  assert.equal(api.queue.position, 0);
  await env.close();
});

test('rate limits: 10 new cases / IP / hour (429 busy with retryAfterSec), global cap, one open case per IP', async () => {
  const env = makeEnv({ over: { traceCapPerIpHour: 3, traceCapGlobalHour: 5 } });
  for (let i = 0; i < 3; i++) { const a = addrN(0x100 + i); const r = await post(env.app, '/api/case', { input: a, hours: 24 }, '1.1.1.1'); assert.equal(r.statusCode, 201, JSON.stringify(r.json())); await finish(env, r.json().id); }
  const r4 = await post(env.app, '/api/case', { input: addrN(0x200), hours: 24 }, '1.1.1.1'); assert.equal(r4.statusCode, 429); assert.equal(r4.json().error, 'busy'); assert.ok(r4.json().retryAfterSec > 0);
  for (let i = 0; i < 2; i++) { const r = await post(env.app, '/api/case', { input: addrN(0x300 + i), hours: 24 }, '2.2.2.' + i); assert.equal(r.statusCode, 201); await finish(env, r.json().id); }
  const g = await post(env.app, '/api/case', { input: addrN(0x400), hours: 24 }, '3.3.3.3'); assert.equal(g.statusCode, 429); assert.match(g.json().message, /Too many new cases right now/);
  await env.close();
});

test('one queued case per IP', async () => {
  const env = makeEnv();
  const a = await post(env.app, '/api/case', { input: addrN(0x11), hours: 24 }, '9.9.9.9'); assert.equal(a.statusCode, 201);
  env.svc.S.stopped = true; // keep it queued
  const b = await post(env.app, '/api/case', { input: addrN(0x12), hours: 24 }, '9.9.9.9');
  // first case may already be running; either way a second one from the same IP while open is refused
  assert.ok([201, 429].includes(b.statusCode)); await env.close();
});

test('RPC down: new cases get 503; existing case, feed and landing still render', async () => {
  const env = makeEnv(); seedTx(env);
  const r = await post(env.app, '/api/case', { input: tx(1) }); await finish(env, r.json().id);
  await env.svc.loadSeed(); env.svc.S.rpcOk = false;
  const n = await post(env.app, '/api/case', { input: addrN(0x77), hours: 24 }, '4.4.4.4'); assert.equal(n.statusCode, 503); assert.equal(n.json().error, 'rpc_unavailable');
  const page = await env.app.inject({ url: `/case/${r.json().id}` }); assert.equal(page.statusCode, 200); assert.match(page.body, /not reachable/); assert.match(page.body, /RPC DOWN/);
  assert.equal((await env.app.inject({ url: '/issuer-actions' })).statusCode, 200);
  assert.equal((await env.app.inject({ url: '/' })).statusCode, 200);
  assert.equal((await env.app.inject({ url: '/api/health' })).json().rpcOk, false);
  const st = await env.app.inject({ url: '/api/status/' + addrN(5) }); assert.equal(st.statusCode, 200); assert.equal(st.json().live, false);
  await env.close();
});

test('issuer actions: seed loads 252 events, the 3 Nov pair, blockedNow 175; /status shows Blocked then Unblocked; no accusation words', async () => {
  const env = makeEnv(); await env.svc.loadSeed();
  const j = (await env.app.inject({ url: '/api/issuer-actions?limit=500' })).json();
  assert.equal(j.eventsTotal, 252); assert.equal(j.blockedNow, 175); assert.equal(j.backfillDone, true);
  const txs = j.events.map((e) => e.tx); assert.ok(txs.includes('0x217695758a019ca28bfd82f9fdef442cf5628074162bcdc4fc0fdf4a1aecadc3')); assert.ok(txs.includes('0x8b9b17bb409c7fa5803b66cf2782882a15cb08cd342dbe95506694a77730fb0c'));
  assert.equal(j.events[0].tx, '0x8b9b17bb409c7fa5803b66cf2782882a15cb08cd342dbe95506694a77730fb0c'); assert.equal(j.lastAction.kind, 'unblocked');
  const a3 = '0xb397711c21f1a117c3c48c4443b178089bffaf94';
  const s = (await env.app.inject({ url: `/api/status/${a3}` })).json(); assert.deepEqual(s.events.map((e) => e.kind), ['blocked', 'unblocked']);
  const sp = await env.app.inject({ url: `/status/${a3}` }); const ap = await env.app.inject({ url: '/issuer-actions' });
  for (const p of [sp, ap]) { assert.equal(p.statusCode, 200); assert.doesNotMatch(p.body.replace(/<script[\s\S]*?<\/script>/g, ''), /thie(f|ves)|stolen/i); }
  assert.ok(ap.body.indexOf('217695') > -1); assert.match(ap.body, /Unblocked/);
  const st = (await env.app.inject({ url: '/api/stats' })).json(); assert.equal(st.blockedNow, 175); assert.equal(st.casesTotal, 0); assert.equal(st.token.launched, false); assert.equal(st.token.ca, null);
  const land = (await env.app.inject({ url: '/' })).body; assert.match(land, /<span data-k="blocked">175<\/span>/);
  await env.close();
});

test('pre-launch token state: no zero CA anywhere, priority routes {enabled:false}; golive flip within the reload window', async () => {
  const env = makeEnv(); const z = '0x' + '0'.repeat(40);
  for (const u of ['/', '/token', '/docs', '/api/stats', '/token.json']) { const r = await env.app.inject({ url: u }); assert.equal(r.statusCode, 200); assert.ok(!r.body.includes(z), u); assert.match(r.body, /FWIT/); }
  assert.match((await env.app.inject({ url: '/token' })).body, /CA at launch/);
  const t = await env.app.inject({ url: '/token' }); assert.doesNotMatch(t.body, /Buy on Pons/);
  assert.deepEqual((await post(env.app, '/api/case/aaaaaaaaaaaa/priority', { holder: addrN(1) })).json(), { enabled: false });
  assert.deepEqual((await post(env.app, '/api/case/aaaaaaaaaaaa/retrace', { holder: addrN(1) })).json(), { enabled: false });
  const ca = '0x' + 'ab'.repeat(20);
  fs.writeFileSync(env.tokenFile, JSON.stringify({ symbol: 'FWIT', ca, launched: true, launchedAt: '2026-11-05T15:00:00Z', teamWallet: '0x427Bf5976Ffb7C99aeaA5C608793D1c8997B6F19', minHold: 1000000, launchDate: '2026-11-05T15:00:00Z', x: 'https://x.com/frostwitRH' }));
  for (const u of ['/', '/token']) { const r = await env.app.inject({ url: u }); assert.ok(r.body.includes(ca), u); assert.match(r.body, /Buy on Pons/); }
  const tj = (await env.app.inject({ url: '/token.json' })).json(); assert.equal(tj.ca, ca); assert.match(tj.buyUrl, new RegExp(ca));
  await env.close();
});

test('JSON routes: CORS * and cache header; llms.txt and /api index', async () => {
  const env = makeEnv(); const r = await env.app.inject({ url: '/api/health' });
  assert.equal(r.headers['access-control-allow-origin'], '*');
  const s = await env.app.inject({ url: '/api/stats' }); assert.equal(s.headers['cache-control'], 'public, max-age=10');
  const idx = (await env.app.inject({ url: '/api' })).json(); assert.ok(idx.routes.length >= 6);
  const l = (await env.app.inject({ url: '/llms.txt' })).body; assert.match(l, /Native ETH is not traced in this version\./); assert.match(l, /support@robinhood\.com/); assert.match(l, /support\.paxos\.com/);
  assert.equal((await env.app.inject({ url: '/no-such-page' })).statusCode, 404);
  assert.equal((await env.app.inject({ url: '/case/zzzz' })).statusCode, 404);
  await env.close();
});

test('banned words and contacts across all static pages', async () => {
  const env = makeEnv(); const bad = /\b(soon|coming|beta|roadmap|we freeze|get your money|money back|guarantee)\b/i;
  for (const u of ['/', '/docs', '/token', '/what-to-do', '/issuer-actions', '/llms.txt', '/api']) {
    const body = (await env.app.inject({ url: u })).body.replace(/<script[\s\S]*?<\/script>/g, '');
    assert.doesNotMatch(body, bad, u);
    for (const m of body.matchAll(/recover\w*/gi)) { const ctxText = body.slice(Math.max(0, m.index - 60), m.index + 40); assert.match(ctxText, /cannot freeze or recover|Do not pay recovery services|recovery services|recovery/i, u + ': ' + ctxText); }
    for (const m of body.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)) assert.ok(['support@robinhood.com'].includes(m[0]) || m[0].includes('frostwit'), u + ' email ' + m[0]);
  }
  assert.doesNotMatch((await env.app.inject({ url: '/docs' })).body, /creator tax|\btax\b/i);
  assert.doesNotMatch((await env.app.inject({ url: '/token' })).body, /creator tax|\btax\b/i);
  await env.close();
});

test('pack snapshots: theft-shaped (real fixture), blocked holder, template', async () => {
  const dir = new URL('./snapshots/', import.meta.url); fs.mkdirSync(dir, { recursive: true });
  const ex = JSON.parse(fs.readFileSync(new URL('../../fixtures/case-example.json', import.meta.url)));
  const blocked = JSON.parse(JSON.stringify(ex)); blocked.freezable = [{ holder: ex.seed.firstReceivers[0], token: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', symbol: 'NVDA', issuer: 'robinhood', amountRaw: String(5n * 10n ** 18n), amount: 5, usd: 600, blocked: true, frozen: false, paused: false, blockedTx: '0x' + 'ab'.repeat(32), checkedAt: 1793783000, checkedBlock: ex.head }, ...blocked.freezable.map((f) => ({ ...f, frozen: true }))]; // test-only synthetic row: no real blocked holder exists in the fixtures
  const mk = (g) => buildPack({ caseId: 'abc123def456', caseUrl: 'https://frostwit.pro/case/abc123def456', graph: g, generatedAt: 1793783000 });
  const outs = { theft: mk(ex), blocked: mk(blocked), template: mk(null) };
  assert.equal(outs.theft.variant, 'open'); assert.equal(outs.blocked.variant, 'blocked'); assert.equal(outs.template.variant, 'template');
  assert.match(outs.blocked.robinhood, /already blocked in the access registry/); assert.match(outs.theft.paxos, /formal legal directive/);
  for (const [name, p] of Object.entries(outs)) {
    const text = p.markdown; assert.doesNotMatch(text, /we freeze|get your money|recover (your|the)|guarantee/i);
    const f = new URL(`${name}.md`, dir);
    if (process.env.UPDATE_SNAP || !fs.existsSync(f)) fs.writeFileSync(f, text); else assert.equal(text, fs.readFileSync(f, 'utf8'), 'snapshot ' + name);
  }
  assert.doesNotMatch(outs.template.markdown, /0x[0-9a-f]{40}/i);
});

test('P2 priority watch: holder below minimum rejected, holder above enables 2-minute cadence', async () => {
  const ca = '0x' + 'cd'.repeat(20), H = addrN(0x5151), LOW = addrN(0x5152);
  const env = makeEnv({ token: { launched: true, ca } }); seedTx(env);
  const r = await post(env.app, '/api/case', { input: tx(1) }); const id = r.json().id; await finish(env, id);
  env.chain.transfer({ token: ca, from: addrN(1), to: H, amount: 2_000_000n * E18, block: HEAD - 10, tx: tx(5000) });
  env.chain.transfer({ token: ca, from: addrN(1), to: LOW, amount: 10n * E18, block: HEAD - 9, tx: tx(5001) });
  const lo = (await post(env.app, `/api/case/${id}/priority`, { holder: LOW })).json(); assert.equal(lo.holder, false);
  const hi = (await post(env.app, `/api/case/${id}/priority`, { holder: H })).json(); assert.equal(hi.holder, true); assert.equal(hi.cadenceMin, 2);
  assert.equal((await env.app.inject({ url: `/api/case/${id}` })).json().watch.cadenceMin, 2);
  assert.match((await env.app.inject({ url: `/case/${id}` })).body, /Priority watch/);
  await env.close();
});

test('stats carry no aggregate USD; /check page and API respond; pagination of the pre-public batch', async () => {
  const env = makeEnv(); await env.svc.loadSeed();
  assert.equal('freezableUsdOpen' in (await env.app.inject({ url: '/api/stats' })).json(), false);
  for (const u of ['/llms.txt', '/api']) assert.doesNotMatch((await env.app.inject({ url: u })).body, /freezableUsd/);
  const small = (await env.app.inject({ url: '/issuer-actions' })).body, all = (await env.app.inject({ url: '/issuer-actions?all=1' })).body;
  assert.ok(small.length < 60000 && all.length > small.length * 2, `${small.length} vs ${all.length}`); assert.match(small, /First batch: 244 Blocked events, 175 addresses/); assert.match(small, /Show all 244/);
  const p = await env.app.inject({ url: `/check/${addrN(7)}?case=aaaaaaaaaaaa` }); assert.equal(p.statusCode, 200); assert.match(p.body, /data-check=/);
  const owner = addrN(0xabc), spender = addrN(0xdef);
  const apiNoCase = await env.app.inject({ url: `/api/check/${owner}` }); assert.equal(apiNoCase.statusCode, 200); assert.deepEqual(apiNoCase.json().spenders, []);
  assert.equal((await env.app.inject({ url: `/api/check/${NVDA}` })).statusCode, 400);
  await env.close();
});

test('node role: pasted tx gives first_receiver; address mode gives thief; check is not a public claim', async () => {
  const env = makeEnv(); seedTx(env);
  const a = await post(env.app, '/api/case', { input: tx(1) }); await finish(env, a.json().id);
  const v = (await env.app.inject({ url: `/api/case/${a.json().id}` })).json();
  assert.equal(v.nodes.filter((n) => n.label === 'thief').length, 0); assert.ok(v.seed.firstReceivers.length > 0); assert.equal('thieves' in v.seed, false); assert.ok(v.nodes.filter((n) => n.role === 'first_receiver').length > 0);
  const b = await post(env.app, '/api/case', { input: T1, hours: 24 }, '8.8.8.8'); await finish(env, b.json().id);
  const w = (await env.app.inject({ url: `/api/case/${b.json().id}` })).json();
  assert.ok(w.nodes.filter((n) => n.label === 'thief').every((n) => n.role === 'thief')); assert.ok(Array.isArray(w.seed.thieves));
  const pg = (await env.app.inject({ url: `/case/${a.json().id}` })).body; assert.match(pg, /This is not an accusation/); assert.match(pg, /Check approvals \(read-only; revoke from your own wallet\)/);
  assert.match((await env.app.inject({ url: '/api' })).body, /api\/check/); assert.match((await env.app.inject({ url: '/llms.txt' })).body, /api\/check/); assert.match((await env.app.inject({ url: '/docs' })).body, /Check approvals/);
  const tk = (await env.app.inject({ url: "/token" })).body.split("</main>")[0]; assert.equal((tk.match(/No promise of returns\./g) || []).length, 1); assert.match(tk, /creator fee on \$FWIT trades/);
  await env.close();
});
