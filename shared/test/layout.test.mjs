// LANDING: shared/layout.mjs — determinism + shape on the dev mock and (when present) APP's recorded fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { layoutGraph, layoutTimeline, hash01, sizeFromUsd, sizeFromCount } from '../layout.mjs';

const root = new URL('../../', import.meta.url);
const load = (p) => { const f = fileURLToPath(new URL(p, root)); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
const mockGraph = load('web/src/scene/dev/mock-graph.json');
const mockTl = load('web/src/scene/dev/mock-issuer-events.json');
const fxGraph = load('fixtures/case-example.json');
const fxPartial = load('fixtures/case-partial.json');
const fxTl = load('fixtures/issuer-events.json');
const graphOf = (f) => f?.graph || f;

test('hash01 is deterministic and in [0,1)', () => {
  assert.equal(hash01('0xAbC'), hash01('0xabc'));
  for (const s of ['', 'a', '0x' + 'f'.repeat(40)]) { const v = hash01(s); assert.ok(v >= 0 && v < 1); }
});

test('sizes clamp to 0.4–1.6', () => {
  assert.equal(sizeFromUsd(null), 0.4); assert.equal(sizeFromUsd(0), 0.4); assert.equal(sizeFromUsd(1e12), 1.6);
  assert.ok(sizeFromUsd(10000) > sizeFromUsd(100));
  assert.ok(sizeFromCount(247) > 1.2 && sizeFromCount(247) <= 1.6);
});

for (const [name, raw] of [['mock', mockGraph], ['case-example', fxGraph], ['case-partial', fxPartial]]) {
  const g = graphOf(raw);
  if (!g) continue;
  test(`layoutGraph(${name}): deterministic, x monotonic in block, edges sorted`, () => {
    const a = layoutGraph(g), b = layoutGraph(JSON.parse(JSON.stringify(g)));
    assert.deepEqual(a, b);
    for (const n of a.nodes) for (const k of ['x', 'y', 'z', 't', 'size']) assert.ok(Number.isFinite(n[k]), `${n.address}.${k}`);
    for (const n of a.nodes) { assert.ok(n.x >= 0 && n.x <= 1); assert.ok(n.t >= 0 && n.t <= 1); assert.ok(n.size >= 0.4 && n.size <= 1.6); }
    const byB = [...a.nodes].filter((n) => n.label !== 'exit').sort((p, q) => p.firstBlock - q.firstBlock);
    for (let i = 1; i < byB.length; i++) assert.ok(byB[i].x >= byB[i - 1].x - 1e-9);
    for (let i = 1; i < a.edges.length; i++) assert.ok(a.edges[i].block >= a.edges[i - 1].block);
    const ids = new Set(a.nodes.map((n) => n.id));
    for (const e of a.edges) { assert.ok(ids.has(e.from), 'from ' + e.from); assert.ok(ids.has(e.to), 'to ' + e.to); }
    for (const n of a.nodes) if (n.state === 'pool' || n.state === 'router') assert.ok(n.y < 0);
    for (const n of a.nodes) if (n.label === 'exit') assert.equal(n.z, 1);
  });
}

test('layoutGraph(mock): states', () => {
  const L = layoutGraph(mockGraph);
  const st = Object.fromEntries(L.nodes.filter((n) => n.label !== 'exit').map((n) => [n.label + ':' + n.address.slice(2, 4), n.state]));
  assert.equal(st['victim:ee'], 'victim'); assert.equal(st['pool:p0'], 'pool'); assert.equal(st['receiver:2b'], 'blocked');
  assert.equal(st['thief:1a'], 'freezable'); assert.equal(st['contract:3c'], 'contract');
  assert.ok(L.nodes.some((n) => n.state === 'exit-eth'));
  assert.equal(L.ticks.length, new Set([...mockGraph.edges, ...mockGraph.exits].map((e) => e.block)).size);
});

test('layoutGraph tolerates empty / missing parts', () => {
  const L = layoutGraph({ seed: { block: 5 } });
  assert.deepEqual(L.nodes, []); assert.deepEqual(L.edges, []);
  assert.doesNotThrow(() => layoutGraph(null));
});

for (const [name, raw] of [['mock', mockTl], ['fixture', fxTl]]) {
  if (!raw) continue;
  test(`layoutTimeline(${name}): cluster, 3 Nov pair, live`, () => {
    const events = raw.events || raw;
    const head = raw.head ?? Math.max(...events.map((e) => e.block)) + 1000;
    const L = layoutTimeline(events, head, { blockedNow: raw.blockedNow });
    assert.deepEqual(L, layoutTimeline(JSON.parse(JSON.stringify(events)), head, { blockedNow: raw.blockedNow }));
    const cl = L.nodes.find((n) => n.state === 'cluster');
    assert.ok(cl && cl.count >= 200, 'pre-public batch is one cluster');
    const pair = L.edges.find((e) => e.kind === 'pair' && e.address.toLowerCase() === '0xb397711c21f1a117c3c48c4443b178089bffaf94');
    assert.ok(pair, '3 Nov pair joined');
    assert.equal(pair.blockTx, '0x217695758a019ca28bfd82f9fdef442cf5628074162bcdc4fc0fdf4a1aecadc3');
    assert.equal(pair.tx, '0x8b9b17bb409c7fa5803b66cf2782882a15cb08cd342dbe95506694a77730fb0c');
    const live = L.nodes[L.nodes.length - 1];
    assert.equal(live.state, 'live'); assert.equal(live.x, 1);
    for (let i = 1; i < L.nodes.length; i++) assert.ok(L.nodes[i].x > L.nodes[i - 1].x, 'strictly left→right');
    // the pair must not collapse into the live crystal
    const unb = L.nodes.find((n) => n.state === 'unblocked');
    assert.ok(1 - unb.x > 0.05);
  });
}

test('layoutTimeline derives blockedNow and handles empty input', () => {
  const ev = [{ block: 10, tx: '0x1', kind: 'blocked', address: '0xa' }, { block: 20, tx: '0x2', kind: 'blocked', address: '0xb' }, { block: 30, tx: '0x3', kind: 'unblocked', address: '0xa' }];
  const L = layoutTimeline(ev, 100);
  assert.equal(L.blockedNow, 1);
  assert.equal(L.edges.filter((e) => e.kind === 'pair').length, 1);
  const E = layoutTimeline([], 100);
  assert.equal(E.nodes.length, 1); assert.equal(E.nodes[0].state, 'live');
});

test('layoutTimeline with a server batch summary (paged feed)', () => {
  const ev = [{ block: 104519492, tx: '0xa', kind: 'blocked', address: '0xb3', time: 1 }, { block: 104561973, tx: '0xb', kind: 'unblocked', address: '0xb3', time: 4380 }];
  const L = layoutTimeline(ev, 105750000, { blockedNow: 247, batch: { fromBlock: 43000, toBlock: 43004, count: 247, txs: ['0x1', '0x2'] } });
  assert.equal(L.nodes[0].state, 'cluster'); assert.equal(L.nodes[0].count, 247); assert.equal(L.nodes[0].txs, 2);
  assert.equal(L.nodes.length, 4);
  assert.equal(L.edges.find((e) => e.kind === 'pair').durationSec, 4379);
});

if (fxTl) test('layoutTimeline(fixture): batch = the pre-public Blocked run only, later events separate', () => {
  const L = layoutTimeline(fxTl.events, fxTl.recordedAtHead, { blockedNow: fxTl.blockedNow });
  const cl = L.nodes[0];
  const batch = fxTl.events.filter((e) => e.block < 50000);
  assert.equal(cl.state, 'cluster'); assert.equal(cl.count, batch.length); assert.equal(cl.addresses, new Set(batch.map((e) => e.address.toLowerCase())).size);
  assert.ok(cl.toBlock < 50000);
  assert.equal(L.nodes.length, 1 + (fxTl.events.length - batch.length) + 1);
  assert.equal(L.nodes.at(-1).count, fxTl.blockedNow);
});
