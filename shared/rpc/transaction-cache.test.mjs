import test from 'node:test';
import assert from 'node:assert/strict';
import { Chain, Lane } from './chain.mjs';
import { cacheKey } from './lane.mjs';

globalThis.fetch = () => { throw new Error('unexpected network request'); };
const hash = '0x' + '1'.repeat(64);
const lookups = [
  ['tx', 'eth_getTransactionByHash', { hash, blockNumber: '0x10' }],
  ['receipt', 'eth_getTransactionReceipt', { transactionHash: hash, blockNumber: '0x10', logs: [] }],
];

function fixture(results, initial = []) {
  const store = new Map(initial);
  const writes = [];
  let calls = 0;
  const cache = {
    get: (key) => store.get(key),
    set: (key, value, ttl) => { writes.push({ key, value, ttl }); store.set(key, value); },
  };
  const lane = new Lane({
    url: 'https://rpc.invalid', cache, spacingMs: 0,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.ok(calls < results.length, 'no extra provider attempts');
      const result = results[calls++];
      return { status: 200, ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) };
    },
  });
  return { chain: new Chain(lane), lane, store, writes, calls: () => calls };
}

for (const [lookup, method, found] of lookups) {
  test(`${lookup}: an explicit lookup can recover after null, then caches the result`, async () => {
    const s = fixture([null, found]);
    assert.equal(await s.chain[lookup](hash), null);
    assert.equal(s.calls(), 1, 'null does not trigger an automatic retry');
    assert.equal(s.store.size, 0, 'a new permanent miss is not written');
    assert.deepEqual(await s.chain[lookup](hash), found);
    assert.deepEqual(await s.chain[lookup](hash), found);
    assert.equal(s.calls(), 2);
    assert.equal(s.lane.totalCalls, 2);
    assert.equal(s.writes.length, 1);
    assert.equal(s.writes[0].ttl, 'forever');
  });

  test(`${lookup}: a legacy cached null is bypassed and replaced when found`, async () => {
    const key = cacheKey(method, [hash]);
    const s = fixture([found], [[key, 'null']]);
    assert.deepEqual(await s.chain[lookup](hash), found);
    assert.deepEqual(await s.chain[lookup](hash), found);
    assert.equal(s.calls(), 1);
    assert.deepEqual(JSON.parse(s.store.get(key)), found);
  });

  test(`${lookup}: a legacy miss stays recoverable while the provider still returns null`, async () => {
    const key = cacheKey(method, [hash]);
    const s = fixture([null, null], [[key, 'null']]);
    assert.equal(await s.chain[lookup](hash), null);
    assert.equal(s.calls(), 1);
    assert.equal(await s.chain[lookup](hash), null);
    assert.equal(s.calls(), 2);
    assert.equal(s.writes.length, 0);
  });

  test(`${lookup}: an explicit finite negative-cache TTL is unchanged`, async () => {
    const s = fixture([null]);
    assert.equal(await s.lane.request(method, [hash], { ttl: 60 }), null);
    assert.equal(await s.lane.request(method, [hash], { ttl: 60 }), null);
    assert.equal(s.calls(), 1);
    assert.equal(s.writes[0].ttl, 60);
  });
}

test('null caching for other methods is unchanged', async () => {
  const s = fixture([null]);
  const params = ['0x10', false];
  assert.equal(await s.lane.request('eth_getBlockByNumber', params, { ttl: 'forever' }), null);
  assert.equal(await s.lane.request('eth_getBlockByNumber', params, { ttl: 'forever' }), null);
  assert.equal(s.calls(), 1);
});
