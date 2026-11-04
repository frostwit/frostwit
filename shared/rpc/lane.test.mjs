import test from 'node:test';
import assert from 'node:assert/strict';
import { Lane, PRIO } from './lane.mjs';

function fake() {
  const c = { t: 1_000_000, inFlight: 0, maxIn: 0, starts: [], sleeps: [] };
  c.now = () => c.t; c.sleep = async (ms) => { c.sleeps.push(ms); c.t += ms; };
  return c;
}
const ok = (result) => ({ status: 200, ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result }) });

test('spacing 350 ms and single in flight', async () => {
  const c = fake();
  const fetchImpl = async () => { c.inFlight++; c.maxIn = Math.max(c.maxIn, c.inFlight); c.starts.push(c.t); await Promise.resolve(); c.inFlight--; return ok('0x1'); };
  const lane = new Lane({ url: 'x', fetchImpl, now: c.now, sleep: c.sleep });
  await Promise.all([1, 2, 3, 4].map((i) => lane.request('eth_blockNumber', [i])));
  assert.equal(c.maxIn, 1); assert.equal(lane.maxInFlight, 1);
  for (let i = 1; i < c.starts.length; i++) assert.ok(c.starts[i] - c.starts[i - 1] >= 350);
});

test('429 pauses the lane 61 s, exactly one retry, never two in flight', async () => {
  const c = fake(); let n = 0; const starts = [];
  const fetchImpl = async () => { starts.push(c.t); n++; if (n === 1) return { status: 429, ok: false, text: async () => 'Too Many Requests' }; return ok('0x2'); };
  const lane = new Lane({ url: 'x', fetchImpl, now: c.now, sleep: c.sleep });
  const [a, b] = await Promise.all([lane.request('eth_blockNumber', []), lane.request('eth_chainId', [])]);
  assert.equal(a, '0x2'); assert.equal(b, '0x2');
  assert.equal(n, 3); // 1 rate-limited + retry + second job
  assert.ok(starts[1] - starts[0] >= 61000, 'retry after >= 61 s');
  assert.equal(lane.maxInFlight, 1);
});

test('JSON-RPC rate message also pauses; other rpc errors are not retried', async () => {
  const c = fake(); let n = 0;
  const fetchImpl = async () => { n++; if (n === 1) return { status: 200, ok: true, text: async () => JSON.stringify({ error: { code: -32005, message: 'Rate Limit Hit, limit will reset in 60 seconds' } }) }; return { status: 200, ok: true, text: async () => JSON.stringify({ error: { code: -32000, message: 'execution reverted' } }) }; };
  const lane = new Lane({ url: 'x', fetchImpl, now: c.now, sleep: c.sleep });
  await assert.rejects(lane.request('eth_call', []), /reverted/);
  assert.equal(n, 2); assert.ok(c.sleeps.some((s) => s >= 61000 - 400));
});

test('transport errors retry 3x (1,3,9 s) then reject rpc_unavailable', async () => {
  const c = fake(); let n = 0;
  const lane = new Lane({ url: 'x', fetchImpl: async () => { n++; throw new Error('ECONNREFUSED'); }, now: c.now, sleep: c.sleep });
  await assert.rejects(lane.request('eth_blockNumber', []), /rpc_unavailable/);
  assert.equal(n, 4); assert.ok(c.sleeps.includes(1000) && c.sleeps.includes(3000) && c.sleeps.includes(9000));
});

test('priority order: interactive > watch > tail > backfill', async () => {
  const c = fake(); const order = [];
  const fetchImpl = async (u, o) => { order.push(JSON.parse(o.body).params[0]); return ok('0x1'); };
  const lane = new Lane({ url: 'x', fetchImpl, now: c.now, sleep: c.sleep });
  const first = lane.request('m', ['first']); // starts immediately
  const ps = [lane.request('m', ['backfill'], { prio: PRIO.backfill }), lane.request('m', ['tail'], { prio: PRIO.tail }), lane.request('m', ['watch'], { prio: PRIO.watch }), lane.request('m', ['interactive'], { prio: PRIO.interactive })];
  await Promise.all([first, ...ps]);
  assert.deepEqual(order, ['first', 'interactive', 'watch', 'tail', 'backfill']);
});

test('cache: forever entries cost no lane call', async () => {
  const c = fake(); let n = 0; const store = new Map();
  const cache = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
  const lane = new Lane({ url: 'x', fetchImpl: async () => { n++; return ok('0xabc'); }, now: c.now, sleep: c.sleep, cache });
  await lane.request('eth_getTransactionReceipt', ['0x1'], { ttl: 'forever' });
  await lane.request('eth_getTransactionReceipt', ['0x1'], { ttl: 'forever' });
  assert.equal(n, 1);
});
