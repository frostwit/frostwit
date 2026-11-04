// Registry event tail: Blocked(address) / Unblocked(address) emitted by the stock-token access registry.
// One address => up to 10 M blocks per eth_getLogs. Backfill from block 0 is ~22 calls (11 windows x 2 topics); the tail is 1 call per 5 min.
import { TOPIC_BLOCKED, TOPIC_UNBLOCKED, addrFromTopic } from '../abi.mjs';
import { PRIO } from '../rpc/lane.mjs';

export const REGISTRY_WINDOW = 10_000_000;
export function planRegistryWindows(from, to, size = REGISTRY_WINDOW) {
  const w = []; for (let a = from; a <= to; a += size) w.push([a, Math.min(to, a + size - 1)]); return w;
}
export function parseRegistryLog(l) {
  const kind = l.topics[0] === TOPIC_BLOCKED ? 'blocked' : l.topics[0] === TOPIC_UNBLOCKED ? 'unblocked' : null;
  if (!kind) return null;
  const address = l.topics[1] ? addrFromTopic(l.topics[1]) : '0x' + l.data.slice(-40).toLowerCase();
  return { block: Number(BigInt(l.blockNumber)), tx: l.transactionHash, log_index: Number(BigInt(l.logIndex)), kind, address };
}
// -> raw parsed events (no operator/time yet) in [from, to]
export async function scanRegistry(chain, registry, from, to, { prio = PRIO.tail, onWindow } = {}) {
  const out = [];
  for (const [a, b] of planRegistryWindows(from, to)) {
    // a topic OR-array is limited like an address array (100 k blocks), so each topic is its own 10 M-block query
    for (const topic of [TOPIC_BLOCKED, TOPIC_UNBLOCKED]) {
      const logs = await chain.getLogs({ address: registry, topics: [topic], fromBlock: a, toBlock: b }, { prio });
      for (const l of logs) { const e = parseRegistryLog(l); if (e) out.push(e); }
    }
    onWindow?.(b, out.length);
  }
  return out;
}
// adds operator (= tx.from) and time (block timestamp) with one tx + one block call per distinct tx/block (cached forever by the chain layer)
export async function enrichEvents(chain, events, { prio = PRIO.tail, known = {} } = {}) {
  const txFrom = new Map(), blockTs = new Map();
  for (const e of events) {
    if (!txFrom.has(e.tx)) txFrom.set(e.tx, known[e.tx]?.operator ?? (await chain.tx(e.tx, { prio }))?.from?.toLowerCase() ?? null);
    if (!blockTs.has(e.block)) blockTs.set(e.block, known[e.tx]?.time ?? Number(BigInt((await chain.block(e.block, { prio }))?.timestamp ?? 0)));
  }
  return events.map((e) => ({ ...e, operator: txFrom.get(e.tx), time: blockTs.get(e.block) }));
}
// events: array of {block,log_index,kind,address,...} -> Set of addresses whose LAST event is 'blocked'
export function blockedNowFrom(events) {
  const last = new Map();
  for (const e of [...events].sort((a, b) => a.block - b.block || a.log_index - b.log_index)) last.set(e.address, e.kind);
  return [...last].filter(([, k]) => k === 'blocked').map(([a]) => a);
}
// cluster the pre-public batch: events within `gap` blocks of each other and the same tx-family; used by pages
export function summarizeEvents(events) {
  const sorted = [...events].sort((a, b) => b.block - a.block || b.log_index - a.log_index);
  const lastAction = sorted[0] ? { block: sorted[0].block, time: sorted[0].time, tx: sorted[0].tx, kind: sorted[0].kind } : null;
  const blockedNow = blockedNowFrom(events);
  return { eventsTotal: events.length, blockedNow: blockedNow.length, lastAction };
}

// ONE site-wide batch definition: the first batch = the earliest run of Blocked events whose consecutive gap is <= 2000 blocks
// (needs >= 10 events). Everything else is listed individually. Returns null when there is no such run.
export function firstBatch(events, gap = 2000) {
  const b = events.filter((e) => e.kind === 'blocked').sort((x, y) => x.block - y.block || x.log_index - y.log_index);
  if (!b.length) return null;
  let n = 1; while (n < b.length && b[n].block - b[n - 1].block <= gap) n++;
  if (n < 10) return null;
  const run = b.slice(0, n), times = run.map((e) => e.time).filter(Boolean);
  return { fromBlock: run[0].block, toBlock: run[n - 1].block, count: n, addresses: new Set(run.map((e) => e.address)).size, fromTime: times.length ? Math.min(...times) : null, toTime: times.length ? Math.max(...times) : null, txs: n };
}
