// Run on us1. Looks for A->B then B->C forwarding of USDG where B is an EOA (for the recorded fixture). Small windows only: the RPC rate-limits on response size.
import { Lane } from '../shared/rpc/lane.mjs'; import { Chain } from '../shared/rpc/chain.mjs';
import { TOPIC_TRANSFER, parseTransfer } from '../shared/abi.mjs'; import { loadContext } from '../shared/trace/tokens.mjs';
const ctx = loadContext(); const lane = new Lane({ url: 'https://rpc.mainnet.chain.robinhood.com', log: console.log }); const ch = new Chain(lane);
const head = await ch.head(); const N = Number(process.env.WINDOWS || 12), W = Number(process.env.W || 500);
const all = [];
for (let i = 0; i < N; i++) { const to = head - 200 - i * W, from = to - W + 1; try { const l = await ch.getLogs({ address: ctx.usdg, topics: [TOPIC_TRANSFER], fromBlock: from, toBlock: to }); all.push(...l.map(parseTransfer).filter(Boolean)); } catch (e) { console.log('skip', e.message); } }
console.log('transfers', all.length, 'lane calls', lane.totalCalls);
const skip = (x) => ctx.poolSet.has(x) || ctx.routerSet.has(x) || x === '0x0000000000000000000000000000000000000000';
const ins = new Map(); for (const t of all) if (!skip(t.to) && !skip(t.from)) { const a = ins.get(t.to) || []; a.push(t); ins.set(t.to, a); }
const cands = [];
for (const t of all) { if (skip(t.from) || skip(t.to)) continue; const arr = ins.get(t.from); if (!arr) continue; const prev = arr.find((x) => x.block < t.block); if (prev) cands.push({ prev, next: t }); }
console.log('forward candidates', cands.length);
const seen = new Set(); let n = 0, tried = 0;
cands.sort((a, b) => Number(b.next.amount - a.next.amount));
for (const c of cands) {
  const b = c.next.from; if (seen.has(b) || c.prev.amount < 50_000_000n || c.next.amount < 50_000_000n || c.prev.from === c.next.to) continue; seen.add(b); if (++tried > 40) break;
  const codes = []; for (const x of [b, c.next.to]) codes.push(await ch.code(x));
  if (codes.some((x) => x !== '0x')) continue;
  console.log(JSON.stringify({ tx: c.prev.tx, A: c.prev.from, B: b, C: c.next.to, amt: c.prev.amount.toString(), next: c.next.amount.toString(), blockIn: c.prev.block, blockOut: c.next.block })); if (++n >= 4) break;
}
