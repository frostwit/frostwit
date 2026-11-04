// Watch tick for one open case: one multicall for all freezable rows; on a DECREASE run an incremental far follow for that (holder, token)
// from the last checked block to head (+ swap rule) so the change log can say where the value went, with the transaction.
import { Tracer, freezableRows, BudgetError } from './engine.mjs';
import { TOPIC_TRANSFER, topicAddr, parseTransfer } from '../abi.mjs';
import { planWindows } from './windows.mjs';
import { PRIO } from '../rpc/lane.mjs';
import { fmtAmount, shortAddr } from '../format.mjs';

const key = (a, t) => a + '|' + t;
export function rebuildTracer(graph, deps) {
  const T = new Tracer({ prio: PRIO.watch, ...deps, limits: { maxCalls: 40, maxReceipts: 10, maxNodes: 60, ...(deps.limits || {}) } }, graph.seed);
  T.seed = graph.seed; T.edges = graph.edges.map((e) => ({ ...e })); T.exits = graph.exits.map((e) => ({ ...e }));
  for (const e of T.exits) T.exitKeys.add([e.from, e.kind, e.token, e.tx, e.note].join('|'));
  for (const n of graph.nodes) T.nodes.set(n.address, { ...n, tokens: new Set() });
  for (const f of graph.freezable || []) T.nodes.get(f.holder)?.tokens.add(f.token);
  for (const e of T.edges) { const n = T.nodes.get(e.to); if (n && ['thief', 'receiver', 'contract'].includes(n.label) && T.ctx.tokens.has(e.token) && e.kind === 'transfer') n.tokens.add(e.token); }
  return T;
}
const text = (T, f, e) => `${fmtAmount(e.amountRaw, T.tok(e.token)?.decimals ?? 18)} ${e.symbol} moved to ${shortAddr(e.to)}${e.kind === 'swap' ? ` (swapped${e.via ? ' via ' + e.via : ''})` : ''}`;

// deps: {chain, ctx, issuerBlockedTx?(addr), now?}; returns {graph, diff[], checkedAt, block}
export async function watchCheck(graph, deps, lastBlock) {
  const T = rebuildTracer(graph, deps);
  T.head = await T.io('head', () => T.chain.head(T.o()));
  const prev = graph.freezable || [];
  const nodes = [...T.nodes.values()].filter((n) => n.tokens.size && ['thief', 'receiver', 'contract'].includes(n.label));
  let rows = await freezableRows(T, nodes);
  const diff = [], by = new Map(rows.map((r) => [key(r.holder, r.token), r]));
  for (const p of prev) {
    const now = by.get(key(p.holder, p.token)), a = BigInt(p.amountRaw), b = now ? BigInt(now.amountRaw) : 0n;
    if (b < a) {
      // incremental far follow for this pair
      const outs = [];
      try {
        for (const [x, y] of planWindows(Math.max(lastBlock + 1, 0), T.head, 10_000_000)) {
          const logs = await T.getLogs0({ address: p.token, topics: [TOPIC_TRANSFER, topicAddr(p.holder)], fromBlock: x, toBlock: y });
          outs.push(...logs.map(parseTransfer).filter((t) => t && t.from === p.holder && t.to !== p.holder));
        }
        const before = T.edges.length;
        T.reserve = false; await T.processOuts({ address: p.holder, depth: (T.nodes.get(p.holder)?.depth ?? 0) }, outs);
        for (const e of T.edges.slice(before)) diff.push({ kind: 'moved', holder: p.holder, token: p.token, symbol: p.symbol, text: text(T, p, e), tx: e.tx, to: e.to, block: e.block });
        if (T.edges.length === before) diff.push({ kind: 'decreased', holder: p.holder, token: p.token, symbol: p.symbol, text: `${p.symbol} balance of ${shortAddr(p.holder)} went down; the transaction was not found within the check budget` });
      } catch (e) { if (!(e instanceof BudgetError)) throw e; diff.push({ kind: 'decreased', holder: p.holder, token: p.token, symbol: p.symbol, text: `${p.symbol} balance of ${shortAddr(p.holder)} went down; follow stopped at the check budget` }); }
    } else if (b > a) diff.push({ kind: 'received', holder: p.holder, token: p.token, symbol: p.symbol, text: `${shortAddr(p.holder)} received more ${p.symbol}` });
    if (now && !p.blocked && now.blocked) diff.push({ kind: 'blocked', holder: p.holder, text: `${shortAddr(p.holder)} was blocked by the Robinhood registry`, tx: deps.issuerBlockedTx?.(p.holder) ?? null });
    if (p.blocked && now && !now.blocked) diff.push({ kind: 'unblocked', holder: p.holder, text: `${shortAddr(p.holder)} is no longer blocked by the Robinhood registry` });
    if (now && !p.frozen && now.frozen) diff.push({ kind: 'frozen', holder: p.holder, text: `${shortAddr(p.holder)} was frozen by Paxos (USDG isFrozen)` });
  }
  // new receivers created by the follow: include them in the panel
  const fresh = [...T.nodes.values()].filter((n) => n.tokens.size && ['thief', 'receiver', 'contract'].includes(n.label));
  if (fresh.length > nodes.length || T.edges.length > graph.edges.length) { for (const e of T.edges.slice(graph.edges.length)) { const n = T.nodes.get(e.to); if (n && T.tok(e.token) && !['pool', 'router'].includes(n.label)) n.tokens.add(e.token); } T.reserve = true; try { rows = await freezableRows(T, [...T.nodes.values()].filter((n) => n.tokens.size && ['thief', 'receiver', 'contract'].includes(n.label))); } finally { T.reserve = false; } }
  for (const r of rows) r.blockedTx = deps.issuerBlockedTx?.(r.holder) ?? null;
  const g2 = T.snapshot(graph.status === 'queued' ? 'done' : graph.status);
  g2.freezable = rows; g2.generatedAt = Math.floor(T.now() / 1000); g2.budget = { ...graph.budget, truncated: graph.budget.truncated };
  g2.head = T.head;
  if (T.edges.length > graph.edges.length) { try { await T.resolveTimes(); } catch { /* keep null times */ } g2.edges = T.edges; g2.headTime = T.headTime; }
  return { graph: g2, diff, checkedAt: g2.generatedAt, block: T.head };
}
