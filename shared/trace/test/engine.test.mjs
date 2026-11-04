import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { trace, Tracer } from '../engine.mjs';
import { MockChain, ctx, NVDA, USDG, addrN, nvdaPool, E18, withdrawalLog } from './mock-chain.mjs';
import { priceToken1PerToken0, stockUsd } from '../price.mjs';
import { planWindows, windowCount, hoursToBlocks } from '../windows.mjs';
import { parseInput, notWalletReason, ApiError } from '../validate.mjs';
import { scanRegistry, blockedNowFrom, parseRegistryLog } from '../../issuer/tail.mjs';
import { TOPIC_BLOCKED, TOPIC_UNBLOCKED, topicAddr } from '../../abi.mjs';

const V = addrN(0xa11ce), T1 = addrN(0xb0b1), T2 = addrN(0xb0b2), HEAD = 105_000_000, B0 = HEAD - 2000;
const tx = (n) => '0x' + n.toString(16).padStart(64, '0');
const lookalike = [...ctx.lookalikes.keys()][0];
const run = (chain, input, limits) => trace(input, { chain, ctx, limits, now: () => 1_793_000_000_000 });
const mk = () => new MockChain({ head: HEAD });

test('tx seed with 2 thieves: victim, both receivers, freezable rows', async () => {
  const c = mk();
  c.addTx(tx(1), { from: V, to: addrN(0xd0d0), block: B0, transfers: [{ token: NVDA, from: V, to: T1, amount: 50n * E18 }, { token: USDG, from: V, to: T2, amount: 7_000_000_000n }] });
  const g = await run(c, { kind: 'tx', value: tx(1) });
  assert.equal(g.status, 'done'); assert.equal(g.seed.victim, V); assert.deepEqual(g.seed.thieves.sort(), [T1, T2].sort());
  assert.equal(g.freezable.length, 2);
  const usdg = g.freezable.find((f) => f.token === USDG); assert.equal(usdg.usd, 7000); assert.equal(usdg.issuer, 'paxos');
  const nv = g.freezable.find((f) => f.token === NVDA); assert.ok(Math.abs(nv.usd - 5000) < 1, 'pool spot price 100 USD x 50'); assert.equal(nv.issuer, 'robinhood');
  assert.equal(g.edges.filter((e) => e.kind === 'transfer').length, 2); assert.ok(g.edges.every((e) => e.time > 0));
  assert.equal(c.maxInFlight, 1);
});

test('ETH-only tx: exits[0] is eth, nothing freezable', async () => {
  const c = mk(); c.addTx(tx(2), { from: V, to: T1, block: B0, value: 10n * E18 });
  const g = await run(c, { kind: 'tx', value: tx(2) });
  assert.equal(g.exits[0].kind, 'eth'); assert.equal(g.freezable.length, 0); assert.equal(g.status, 'done'); assert.deepEqual(g.seed.thieves, [T1]);
});

test('tx not found -> 404 tx_not_found', async () => {
  await assert.rejects(run(mk(), { kind: 'tx', value: tx(99) }), (e) => e instanceof ApiError && e.status === 404 && e.code === 'tx_not_found');
});

test('swap NVDA -> USDG is followed: edge kind swap, USDG held by the thief', async () => {
  const c = mk();
  c.addTx(tx(3), { from: V, to: addrN(0xd0d0), block: B0, transfers: [{ token: NVDA, from: V, to: T1, amount: 10n * E18 }] });
  c.addTx(tx(4), { from: T1, to: addrN(0xd1d1), block: B0 + 50, transfers: [{ token: NVDA, from: T1, to: nvdaPool, amount: 10n * E18 }, { token: USDG, from: nvdaPool, to: T1, amount: 990_000_000n }] });
  const g = await run(c, { kind: 'tx', value: tx(3) });
  const sw = g.edges.find((e) => e.kind === 'swap' && e.from === T1); assert.ok(sw, 'swap edge'); assert.equal(sw.swapTo[0].token, USDG);
  assert.match(sw.via, /pool/i);
  assert.deepEqual(g.freezable.map((f) => f.token), [USDG]); assert.equal(g.freezable[0].holder, T1);
  assert.ok(!g.nodes.find((n) => n.address === nvdaPool && n.label !== 'pool'));
});

test('lookalike output becomes an exit and is not followed', async () => {
  const c = mk();
  c.addTx(tx(5), { from: V, to: addrN(0xd0d0), block: B0, transfers: [{ token: NVDA, from: V, to: T1, amount: 1n * E18 }] });
  c.addTx(tx(6), { from: T1, to: addrN(0xd1d1), block: B0 + 10, transfers: [{ token: NVDA, from: T1, to: nvdaPool, amount: 1n * E18 }, { token: lookalike, from: nvdaPool, to: T1, amount: 5n * E18 }] });
  const g = await run(c, { kind: 'tx', value: tx(5) });
  assert.ok(g.exits.some((e) => e.kind === 'lookalike' && e.token === lookalike && /FAKE/.test(e.note)));
});

test('other unknown ERC-20 output -> other-token exit', async () => {
  const c = mk(); const other = addrN(0x77777);
  c.addTx(tx(7), { from: V, to: addrN(0xd0d0), block: B0, transfers: [{ token: NVDA, from: V, to: T1, amount: E18 }] });
  c.addTx(tx(8), { from: T1, to: addrN(0xd1d1), block: B0 + 10, transfers: [{ token: NVDA, from: T1, to: nvdaPool, amount: E18 }, { token: other, from: nvdaPool, to: T1, amount: 5n }] });
  const g = await run(c, { kind: 'tx', value: tx(7) });
  assert.ok(g.exits.some((e) => e.kind === 'other-token' && e.token === other));
});

test('swap to ETH (Withdrawal log) -> eth exit', async () => {
  const c = mk(); const weth = addrN(0x4242);
  c.addTx(tx(9), { from: V, to: addrN(0xd0d0), block: B0, transfers: [{ token: NVDA, from: V, to: T1, amount: E18 }] });
  c.addTx(tx(10), { from: T1, to: addrN(0xd1d1), block: B0 + 10, transfers: [{ token: NVDA, from: T1, to: nvdaPool, amount: E18 }, { token: weth, from: nvdaPool, to: ctx.knownByAddr.keys().next().value, amount: 5n }], extraLogs: [withdrawalLog(weth, nvdaPool)] });
  const g = await run(c, { kind: 'tx', value: tx(9) });
  assert.ok(g.exits.some((e) => e.kind === 'eth'));
});

test('thief is an unknown contract: node contract, listed in freezable if it holds, not followed', async () => {
  const c = mk(); const K = addrN(0xc0de); c.codes.add(K);
  c.addTx(tx(11), { from: V, to: K, block: B0, transfers: [{ token: USDG, from: V, to: K, amount: 1_000_000_000n }] });
  c.addTx(tx(12), { from: K, to: addrN(1), block: B0 + 5, transfers: [{ token: USDG, from: K, to: addrN(0x999), amount: 1n }] });
  const g = await run(c, { kind: 'tx', value: tx(11) });
  assert.equal(g.nodes.find((n) => n.address === K).label, 'contract');
  assert.ok(g.exits.some((e) => e.kind === 'contract' && e.from === K));
  assert.equal(g.edges.some((e) => e.from === K), false);
});

test('fan-out > 10: top 10 receivers followed, rest one summary row', async () => {
  const c = mk();
  c.addTx(tx(20), { from: V, to: addrN(0xd0d0), block: B0, transfers: [{ token: NVDA, from: V, to: T1, amount: 1000n * E18 }] });
  for (let i = 0; i < 40; i++) c.addTx(tx(100 + i), { from: T1, to: addrN(0x1000 + i), block: B0 + 10 + i, transfers: [{ token: NVDA, from: T1, to: addrN(0x1000 + i), amount: BigInt(10 + i) * E18 }] });
  const g = await run(c, { kind: 'tx', value: tx(20) }, { maxCalls: 400, maxReceipts: 100 });
  const fromT1 = g.edges.filter((e) => e.from === T1 && e.kind === 'transfer'); assert.equal(fromT1.length, 10);
  const fan = g.exits.find((e) => e.kind === 'fanout' && e.from === T1); assert.ok(fan); assert.match(fan.note, /\+30 smaller receivers/);
  assert.ok(fromT1.every((e) => e.amount >= 40 - 1e-9), 'largest 10 kept (amounts 40..49)');
});

test('depth > 4: chain of 6 hops yields a depth exit', async () => {
  const c = mk(); const chain = [T1, ...[1, 2, 3, 4, 5, 6].map((i) => addrN(0x2000 + i))];
  c.addTx(tx(30), { from: V, to: addrN(0xd0d0), block: B0, transfers: [{ token: USDG, from: V, to: T1, amount: 5_000_000_000n }] });
  for (let i = 0; i < chain.length - 1; i++) c.addTx(tx(31 + i), { from: chain[i], to: chain[i + 1], block: B0 + 10 * (i + 1), transfers: [{ token: USDG, from: chain[i], to: chain[i + 1], amount: 5_000_000_000n }] });
  const g = await run(c, { kind: 'tx', value: tx(30) });
  assert.ok(g.exits.some((e) => e.kind === 'depth')); assert.equal(g.edges.filter((e) => e.kind === 'transfer' && e.from !== V).length, 4);
  assert.ok(g.nodes.some((n) => n.unfinished));
});

test('window halving: > overflow logs in a window halves and still returns every log', async () => {
  const c = mk();
  for (let i = 0; i < 120; i++) c.transfer({ token: USDG, from: T1, to: addrN(0x3000 + i), amount: 1n, block: B0 + i * 800, tx: tx(500 + i) });
  const T = new Tracer({ chain: c, ctx, limits: { overflowLogs: 50, maxCalls: 500 } }, {});
  const r = await T.scanWindow([B0, B0 + 99_999], [ '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', topicAddr(T1)]);
  assert.equal(r.logs.length, 120); assert.ok(c.log.length > 3, 'halved: ' + c.log.length); assert.equal(r.overflow, false);
});

test('window halving gives up after 4 levels -> overflow flag (fanout exit)', async () => {
  const c = mk();
  for (let i = 0; i < 60; i++) c.transfer({ token: USDG, from: T1, to: addrN(0x3000 + i), amount: 1n, block: B0, tx: tx(700 + i) });
  const T = new Tracer({ chain: c, ctx, limits: { overflowLogs: 10, maxCalls: 500 } }, {});
  const r = await T.scanWindow([B0, B0 + 99_999], ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', topicAddr(T1)]);
  assert.equal(r.overflow, true);
});

test('horizon + far follow: value moved after 24 h is found with single-token queries', async () => {
  const c = new MockChain({ head: HEAD + 3_000_000 });
  c.addTx(tx(40), { from: V, to: addrN(0xd0d0), block: B0, transfers: [{ token: USDG, from: V, to: T1, amount: 9_000_000_000n }] });
  c.addTx(tx(41), { from: T1, to: T2, block: B0 + 1_500_000, transfers: [{ token: USDG, from: T1, to: T2, amount: 9_000_000_000n }] });
  const g = await run(c, { kind: 'tx', value: tx(40) });
  assert.ok(g.edges.some((e) => e.from === T1 && e.to === T2 && e.block === B0 + 1_500_000));
  assert.ok(c.log.some((l) => l.addr === USDG), 'a single-address query ran');
  assert.deepEqual(g.freezable.map((f) => f.holder), [T2]);
});

test('budget exceeded -> partial with reason and unfinished nodes', async () => {
  const c = mk();
  c.addTx(tx(50), { from: V, to: addrN(0xd0d0), block: B0, transfers: [{ token: NVDA, from: V, to: T1, amount: 1000n * E18 }] });
  for (let i = 0; i < 10; i++) c.addTx(tx(200 + i), { from: T1, to: addrN(0x4000 + i), block: B0 + 10 + i, transfers: [{ token: NVDA, from: T1, to: addrN(0x4000 + i), amount: 50n * E18 }] });
  const g = await run(c, { kind: 'tx', value: tx(50) }, { maxCalls: 20 });
  assert.equal(g.status, 'partial'); assert.equal(g.budget.truncated, true); assert.match(g.budget.reason, /rpc calls/); assert.ok(g.nodes.some((n) => n.unfinished));
});

test('address mode: incoming scan seeds the follow; node with isBlocked:true carries the chip', async () => {
  const c = mk(); c.blocked.add(T1);
  c.transfer({ token: USDG, from: V, to: T1, amount: 3_000_000_000n, block: HEAD - 5000, tx: tx(60) });
  const g = await run(c, { kind: 'address', value: T1, hours: 24 });
  assert.equal(g.seed.kind, 'address'); assert.equal(g.freezable.length, 1); assert.equal(g.freezable[0].blocked, true);
  assert.equal(g.nodes.find((n) => n.address === T1).blocked, true);
});

test('victim mode: outgoing transfers become candidates, no thief asserted', async () => {
  const c = mk();
  c.transfer({ token: USDG, from: V, to: T1, amount: 3_000_000_000n, block: HEAD - 5000, tx: tx(70) });
  c.transfer({ token: NVDA, from: V, to: T2, amount: 5n * E18, block: HEAD - 4000, tx: tx(71) });
  c.transfer({ token: NVDA, from: V, to: nvdaPool, amount: 5n * E18, block: HEAD - 3000, tx: tx(72) });
  const g = await run(c, { kind: 'victim', value: V, hours: 24 });
  assert.deepEqual(g.candidates.map((x) => x.receiver), [T1, T2]); assert.equal(g.seed.thieves.length, 0); assert.equal(g.freezable.length, 0);
});

test('victim mode with nothing -> empty candidates', async () => {
  const g = await run(mk(), { kind: 'victim', value: V, hours: 24 });
  assert.equal(g.candidates.length, 0); assert.equal(g.status, 'done');
});

test('price math: both token orders, 6-decimal precision', () => {
  // stock (18 dec) vs USDG (6 dec): price 123.456789 USD
  const p = 123.456789;
  const s0 = BigInt(Math.round(Math.sqrt(p * 1e-12) * 2 ** 48)) << 48n; // stock token0
  const lo = '0x' + '1'.padStart(40, '0'), hi = '0x' + 'f'.padStart(40, '0');
  assert.ok(Math.abs(stockUsd(s0, lo, hi) - p) / p < 1e-6);
  const s1 = BigInt(Math.round(Math.sqrt(1e12 / p) * 2 ** 48)) << 48n; // USDG token0
  assert.ok(Math.abs(stockUsd(s1, hi, lo) - p) / p < 1e-6);
  assert.equal(stockUsd(0n, lo, hi), null);
  assert.equal(priceToken1PerToken0(1n << 96n, 18, 18), 1);
});

test('price unavailable -> usd null, rows sort last', async () => {
  const c = mk(); c.sqrt = () => 0n;
  c.addTx(tx(80), { from: V, to: addrN(0xd0d0), block: B0, transfers: [{ token: NVDA, from: V, to: T1, amount: E18 }, { token: USDG, from: V, to: T1, amount: 5_000_000n }] });
  const g = await run(c, { kind: 'tx', value: tx(80) });
  const nv = g.freezable.find((f) => f.token === NVDA); assert.equal(nv.usd, null); assert.equal(g.freezable.at(-1).token, NVDA);
});

test('window planner 9 / 26 / 61 windows and too_old', () => {
  assert.equal(windowCount(24), 9); assert.equal(windowCount(72), 26); assert.equal(windowCount(168), 61);
  assert.equal(planWindows(0, 249_999).length, 3); assert.equal(hoursToBlocks(24), 864000);
  assert.throws(() => parseInput('0x' + 'a'.repeat(40), { hours: 169 }), (e) => e.code === 'too_old' && e.status === 400);
  assert.equal(parseInput('0x' + 'a'.repeat(40), { hours: 72 }).hours, 72);
  assert.equal(parseInput('0x' + 'a'.repeat(40)).hours, 24);
  assert.equal(parseInput('0x' + 'a'.repeat(40), { role: 'victim' }).kind, 'victim');
});

test('6 bad inputs -> invalid_input', () => {
  for (const bad of ['', 'vitalik.eth', '0x123', '0x' + 'g'.repeat(40), 'So11111111111111111111111111111111111111112', '0x' + 'a'.repeat(41)])
    assert.throws(() => parseInput(bad), (e) => e.status === 400 && e.code === 'invalid_input', bad);
});

test('not_a_wallet: token contract, pool, router', () => {
  assert.match(notWalletReason(NVDA, ctx), /NVDA token contract/);
  assert.match(notWalletReason(nvdaPool, ctx), /Uniswap pool/);
  assert.match(notWalletReason('0xCaf681a66D020601342297493863E78C959E5cb2', ctx), /Uniswap router/);
  assert.equal(notWalletReason(addrN(5), ctx), null);
});

test('registry backfill fixture: 247 Blocked events batch + the 3 Nov pair', () => {
  const f = JSON.parse(fs.readFileSync(new URL('../../../fixtures/issuer-events.json', import.meta.url)));
  const blocked = f.events.filter((e) => e.kind === 'blocked');
  assert.equal(blocked.length, 247);
  const b = f.events.find((e) => e.tx === '0x217695758a019ca28bfd82f9fdef442cf5628074162bcdc4fc0fdf4a1aecadc3');
  const u = f.events.find((e) => e.tx === '0x8b9b17bb409c7fa5803b66cf2782882a15cb08cd342dbe95506694a77730fb0c');
  assert.equal(b.kind, 'blocked'); assert.equal(u.kind, 'unblocked'); assert.equal(b.address, u.address); assert.equal(b.address, '0xb397711c21f1a117c3c48c4443b178089bffaf94');
  assert.equal(b.block, 104519492); assert.equal(u.block, 104561973);
  assert.equal(blockedNowFrom(f.events).includes(b.address), false);
  assert.equal(blockedNowFrom(f.events).length, f.blockedNow);
});

test('registry scan: parses Blocked/Unblocked logs, one query per topic per 10 M window', async () => {
  const addr = addrN(0x77);
  const calls = [];
  const chain = { getLogs: async (f) => { calls.push(f); const t = f.topics[0]; return f.fromBlock === 0 ? [{ topics: [t, topicAddr(addr)], data: '0x', blockNumber: '0x10', transactionHash: tx(1), logIndex: '0x0' }] : []; } };
  const ev = await scanRegistry(chain, ctx.registry, 0, 25_000_000);
  assert.equal(calls.length, 6); assert.deepEqual(ev.map((e) => e.kind).sort(), ['blocked', 'unblocked']);
  assert.equal(parseRegistryLog({ topics: ['0x00'], data: '0x', blockNumber: '0x1', logIndex: '0x0' }), null);
});

import { watchCheck } from '../watch.mjs';
test('watch: decrease triggers incremental far follow and logs the move with the tx', async () => {
  const c = mk();
  c.addTx(tx(900), { from: V, to: addrN(0xd0d0), block: B0, transfers: [{ token: USDG, from: V, to: T1, amount: 8_000_000_000n }] });
  const g = await run(c, { kind: 'tx', value: tx(900) });
  assert.equal(g.freezable[0].amount, 8000);
  // later: T1 moves 5 000 USDG to T2
  c.headN = HEAD + 500; c.addTx(tx(901), { from: T1, to: T2, block: HEAD + 100, transfers: [{ token: USDG, from: T1, to: T2, amount: 5_000_000_000n }] });
  const r = await watchCheck(g, { chain: c, ctx, now: () => 1_793_000_900_000 }, g.head);
  assert.ok(r.diff.some((d) => d.kind === 'moved' && d.tx === tx(901) && /USDG moved to/.test(d.text)), JSON.stringify(r.diff));
  const rows = Object.fromEntries(r.graph.freezable.map((f) => [f.holder, f.amount]));
  assert.equal(rows[T1], 3000); assert.equal(rows[T2], 5000);
});
test('watch: registry block flips the chip and is logged', async () => {
  const c = mk();
  c.addTx(tx(910), { from: V, to: addrN(0xd0d0), block: B0, transfers: [{ token: NVDA, from: V, to: T1, amount: 10n * E18 }] });
  const g = await run(c, { kind: 'tx', value: tx(910) });
  c.blocked.add(T1);
  const r = await watchCheck(g, { chain: c, ctx, issuerBlockedTx: () => tx(777) }, g.head);
  assert.ok(r.diff.some((d) => d.kind === 'blocked' && d.tx === tx(777))); assert.equal(r.graph.freezable[0].blocked, true); assert.equal(r.graph.freezable[0].blockedTx, tx(777));
});

import { replayChain } from '../../rpc/replay.mjs';
import { publicGraph } from '../public.mjs';
for (const name of ['case-example', 'case-partial']) {
  test(`recorded real fixture ${name}: replay reproduces the graph`, async () => {
    const rep = JSON.parse(fs.readFileSync(new URL(`../../../fixtures/replay-${name}.json`, import.meta.url)));
    const want = JSON.parse(fs.readFileSync(new URL(`../../../fixtures/${name}.json`, import.meta.url)));
    const chain = replayChain(rep.rec);
    const g = publicGraph('tx', await trace(rep.input, { chain, ctx, limits: rep.limits }));
    assert.deepEqual(chain.missing, []);
    for (const k of ['seed', 'nodes', 'edges', 'exits', 'status', 'head']) assert.deepEqual(JSON.parse(JSON.stringify(g[k])), want[k], k);
    assert.deepEqual(g.freezable.map((f) => [f.holder, f.token, f.amountRaw, f.usd]), want.freezable.map((f) => [f.holder, f.token, f.amountRaw, f.usd]));
    assert.equal(g.budget.rpcCalls, want.budget.rpcCalls);
  });
}
test('real fixture: budget is respected and the partial graph marks unfinished nodes', () => {
  const p = JSON.parse(fs.readFileSync(new URL('../../../fixtures/case-partial.json', import.meta.url)));
  assert.equal(p.status, 'partial'); assert.equal(p.budget.truncated, true); assert.match(p.budget.reason, /rpc calls/); assert.ok(p.nodes.some((n) => n.unfinished));
  const e = JSON.parse(fs.readFileSync(new URL('../../../fixtures/case-example.json', import.meta.url)));
  assert.ok(e.budget.rpcCalls <= 120 + 40); assert.ok(e.nodes.length <= 25 + 3);
});
