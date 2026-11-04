// LANDING: shared/asof.mjs — reconstruction from hops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { asOf, headOf, edgesUpTo, AS_OF_NOTE } from '../asof.mjs';

const root = new URL('../../', import.meta.url);
const load = (p) => { const f = fileURLToPath(new URL(p, root)); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
const g = load('web/src/scene/dev/mock-graph.json');
const fx = load('fixtures/case-example.json');
const row = (rows, h) => rows.find((r) => r.holder.slice(2, 4) === h);

test('at head ⇒ live panel unchanged', () => {
  const live = asOf(g, headOf(g));
  assert.equal(live.length, g.freezable.length);
  assert.equal(live[0].reconstructed, false);
  assert.deepEqual(asOf(g), live);
});

test('after the theft hop: thief holds NVDA + USDG, victim excluded', () => {
  const r = asOf(g, 105000000);
  const t = r.filter((x) => x.holder.slice(2, 4) === '1a');
  assert.equal(t.length, 2);
  assert.equal(t.find((x) => x.symbol === 'NVDA').amount, 100);
  assert.equal(t.find((x) => x.symbol === 'USDG').amount, 5000);
  assert.ok(!r.some((x) => x.holder.slice(2, 4) === 'ee'));
  assert.ok(r.every((x) => x.reconstructed && x.asOfBlock === 105000000));
});

test('swap: NVDA leaves, USDG arrives, pool never a holder', () => {
  const r = asOf(g, 105004000);
  assert.equal(r.length, 1);
  assert.equal(r[0].symbol, 'USDG'); assert.equal(r[0].amount, 22950); assert.equal(r[0].issuer, 'paxos');
});

test('later hops: split, blocked flag is current, sorted by USD', () => {
  const r = asOf(g, 105060000);
  assert.equal(row(r, '1a').amount, 6950);
  assert.equal(row(r, '2b').amount, 10000); assert.equal(row(r, '2b').blocked, true);
  assert.equal(row(r, '4d').amount, 4000);
  assert.equal(row(r, '3c').amount, 2000);
  for (let i = 1; i < r.length; i++) assert.ok((r[i - 1].usd ?? -1) >= (r[i].usd ?? -1));
});

test('before the seed: nothing', () => { assert.deepEqual(asOf(g, 104999999), []); });

test('NVDA price comes from edges (usd / amount)', () => {
  const r = asOf(g, 105000000);
  assert.equal(r.find((x) => x.symbol === 'NVDA').usd, 18000);
});

test('edgesUpTo filters t ≤ T', () => {
  assert.equal(edgesUpTo(g.edges, 105004000).length, 4);
  assert.equal(edgesUpTo(g.edges, 0).length, 0);
  assert.ok(AS_OF_NOTE.includes('reconstructed'));
});

if (fx) test('fixture case-example: asOf at every hop block is finite and non-negative', () => {
  const G = fx.graph || fx;
  for (const b of new Set((G.edges || []).map((e) => e.block))) for (const r of asOf(G, b)) { assert.ok(r.amount > 0); assert.ok(r.usd === null || Number.isFinite(r.usd)); }
});
