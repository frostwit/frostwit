// Trace engine. Pure with respect to I/O: every chain read goes through `deps.chain` (shared/rpc/chain.mjs or a mock/replay with the same methods).
// One query covers all tokens: eth_getLogs({address: FREEZABLE_203, topics:[Transfer, from|null, to|null]}) per 100 000-block window.
import {
  TOPIC_TRANSFER, TOPIC_WITHDRAWAL, SEL, call1, topicAddr, parseTransfer, encodeBalanceOf, decodeUint, decodeBool, decodeSqrtPrice,
} from '../abi.mjs';
import { isAddr, norm, unitsToNumber, fmtAmount } from '../format.mjs';
import { WINDOW, planWindows, halve, hoursToBlocks } from './windows.mjs';
import { stockUsd } from './price.mjs';
import { PRIO } from '../rpc/lane.mjs';
import { ApiError, MSG } from './validate.mjs';

export const LIMITS = { maxCalls: 120, maxReceipts: 40, maxNodes: 25, maxWallMs: 180_000, maxDepth: 4, maxFanout: 10, horizonWindows: 9, dustUsd: 20, dustFrac: 0.01, overflowLogs: 9000, maxHalvings: 4, reserveCalls: 40 };
const ZERO = '0x0000000000000000000000000000000000000000';
class BudgetError extends Error { constructor(reason) { super('budget: ' + reason); this.reason = reason; } }
const key = (a, t) => a + '|' + t;
const lbl = (k) => (k === 'eoa' ? 'receiver' : k === 'burn' ? 'contract' : k);

export class Tracer {
  constructor(deps, input) {
    this.d = deps; this.chain = deps.chain; this.ctx = deps.ctx; this.input = input;
    this.L = { ...LIMITS, ...(deps.limits || {}) }; this.prio = deps.prio ?? PRIO.interactive; this.now = deps.now || Date.now;
    this.t0 = this.now(); this.calls = 0; this.receipts = 0; this.windows = 0; this.reserve = false;
    this.nodes = new Map(); this.edges = []; this.exits = []; this.exitKeys = new Set(); this.holders = new Map(); this.done = new Set();
    this.received = new Map(); this.sent = new Map(); // key(addr,token) -> BigInt
    this.prices = new Map(); this.priceTried = new Set(); this.blockTime = new Map(); this.codeCache = new Map();
    this.truncated = false; this.reason = null; this.seed = null; this.candidates = null; this.head = 0; this.headTime = null;
    this.stolenUsd = null; this.lastProgressCalls = 0;
  }
  // ---- metered chain access ----
  guard() {
    if (this.reserve) return;
    if (this.calls >= this.L.maxCalls) throw new BudgetError('rpc calls (' + this.L.maxCalls + ')');
    if (this.now() - this.t0 > this.L.maxWallMs) throw new BudgetError('timeout');
  }
  async io(kind, fn) {
    this.guard(); this.calls++;
    if (kind === 'receipt') this.receipts++;
    if (kind === 'window') this.windows++;
    const r = await fn();
    if (this.d.onProgress && this.calls - this.lastProgressCalls >= 10) { this.lastProgressCalls = this.calls; try { this.d.onProgress(this.snapshot('tracing')); } catch { /* ignore */ } }
    return r;
  }
  o() { return { prio: this.prio }; }
  getLogs(f) { return this.io('window', () => this.chain.getLogs(f, this.o())); }
  getTx(h) { return this.io('tx', () => this.chain.tx(h, this.o())); }
  getReceipt(h) {
    if (this.receipts >= this.L.maxReceipts && !this.reserve) throw new BudgetError('receipts (' + this.L.maxReceipts + ')');
    return this.io('receipt', () => this.chain.receipt(h, this.o()));
  }
  getBlock(n) { return this.io('block', () => this.chain.block(n, this.o())); }
  multicall(calls) { return this.io('multicall', () => this.chain.multicall(calls, this.o())); }

  // ---- helpers ----
  tok(a) { return this.ctx.tokens.get(a); }
  amt(token, raw) { const t = this.tok(token); return t ? unitsToNumber(raw, t.decimals) : null; }
  usd(token, raw) { const p = this.prices.get(token); if (p == null) return null; const n = this.amt(token, raw); return n == null ? null : n * p; }
  node(address, label, extra = {}) {
    let n = this.nodes.get(address);
    if (!n) { n = { address, label, code: false, blocked: false, frozen: false, depth: extra.depth ?? 0, firstBlock: extra.block ?? null, tokens: new Set() }; this.nodes.set(address, n); if (this.nodes.size > this.L.maxNodes) { this.truncated = true; this.reason = this.reason || 'nodes (' + this.L.maxNodes + ')'; } }
    if (label === 'thief' && n.label !== 'victim') n.label = 'thief';
    return n;
  }
  addExit(e) { const k = [e.from, e.kind, e.token, e.tx, e.note].join('|'); if (this.exitKeys.has(k)) return; this.exitKeys.add(k); this.exits.push(e); }
  sym(token) { return this.tok(token)?.symbol ?? this.ctx.lookalikes.get(token)?.symbol ?? null; }
  async classify(addr) {
    if (addr === ZERO) return 'burn';
    if (this.ctx.poolSet.has(addr)) return 'pool';
    if (this.ctx.routerSet.has(addr) || addr === this.ctx.registry) return 'router';
    if (this.ctx.tokens.has(addr)) return 'contract';
    if (this.codeCache.has(addr)) return this.codeCache.get(addr);
    const code = await this.io('code', () => this.chain.code(addr, this.o()));
    const k = code && code !== '0x' && code !== '0x0' ? 'contract' : 'eoa';
    this.codeCache.set(addr, k); return k;
  }
  async ensurePrices(tokens) {
    const need = [...new Set(tokens)].filter((t) => !this.prices.has(t) && !this.priceTried.has(t) && this.tok(t));
    if (!need.length) return;
    const calls = [], plan = [];
    for (const t of need) {
      this.priceTried.add(t);
      if (t === this.ctx.usdg) { this.prices.set(t, 1); continue; }
      const pools = [...this.tok(t).pools].sort((a, b) => b.usdg - a.usdg).slice(0, 2);
      plan.push({ t, pools, at: calls.length }); for (const p of pools) calls.push({ target: p.pool, callData: SEL.slot0 });
    }
    if (!calls.length) return;
    let res; try { res = await this.multicall(calls); } catch (e) { if (e instanceof BudgetError) throw e; return; }
    for (const pl of plan) for (let i = 0; i < pl.pools.length; i++) {
      const r = res[pl.at + i]; if (!r?.success) continue;
      const sq = decodeSqrtPrice(r.returnData); if (sq === 0n) continue;
      const p = stockUsd(sq, pl.t, this.ctx.usdg, 18, 6); if (p != null && p > 0) { this.prices.set(pl.t, p); break; }
    }
  }
  async blockTs(n) {
    if (this.blockTime.has(n)) return this.blockTime.get(n);
    const b = await this.getBlock(n); const ts = b ? Number(BigInt(b.timestamp)) : null; this.blockTime.set(n, ts); return ts;
  }
  // ---- log scanning with window halving ----
  async scanWindow([a, b], topics, depth = 0) {
    let logs;
    try { logs = await this.getLogs({ address: this.ctx.freezable, topics, fromBlock: a, toBlock: b }); }
    catch (e) { if (e.rpc && /10000|more than|too many results|limit/i.test(e.message) && b > a) logs = null; else throw e; }
    if (logs && logs.length <= this.L.overflowLogs) return { logs, overflow: false };
    if (depth >= this.L.maxHalvings || b <= a) return { logs: logs || [], overflow: true };
    const [l, r] = halve([a, b]); const L = await this.scanWindow(l, topics, depth + 1), R = await this.scanWindow(r, topics, depth + 1);
    return { logs: [...L.logs, ...R.logs], overflow: L.overflow || R.overflow };
  }
  async scanRange(from, to, topics) {
    const all = []; let overflow = false;
    for (const w of planWindows(from, to)) { const r = await this.scanWindow(w, topics); all.push(...r.logs); overflow ||= r.overflow; }
    return { transfers: all.map(parseTransfer).filter(Boolean), overflow };
  }

  // ---- seeds ----
  async seedTx(hash) {
    const tx = await this.getTx(hash); if (!tx) throw new ApiError(404, 'tx_not_found', MSG.tx_not_found);
    const rec = await this.getReceipt(hash); if (!rec) throw new ApiError(404, 'tx_not_found', MSG.tx_not_found);
    const block = Number(BigInt(rec.blockNumber));
    const logs = rec.logs.map(parseTransfer).filter(Boolean);
    const fz = logs.filter((l) => this.ctx.tokens.has(l.token));
    this.seed = { kind: 'tx', value: hash, block, victim: null, thieves: [], from: tx.from?.toLowerCase(), to: tx.to?.toLowerCase() ?? null };
    // other-token / lookalike transfers in the seed tx are exits
    for (const l of logs) if (!this.ctx.tokens.has(l.token)) this.addExit({ from: l.from, kind: this.ctx.lookalikes.has(l.token) ? 'lookalike' : 'other-token', token: l.token, amount: l.amount.toString(), tx: hash, note: this.ctx.lookalikes.has(l.token) ? `FAKE ${this.sym(l.token) || ''} — same name, not an official Robinhood token; not freezable` : 'token no issuer here controls; not followed' });
    if (rec.logs.some((l) => l.topics?.[0] === TOPIC_WITHDRAWAL) || (tx.value && BigInt(tx.value) > 0n)) this.addExit({ from: this.seed.from, kind: 'eth', tx: hash, note: 'native ETH is not traced in this version' });
    if (!fz.length) {
      const to = tx.to?.toLowerCase(); this.seed.thieves = to ? [to] : [];
      if (!this.exits.length) this.addExit({ from: this.seed.from, kind: 'eth', tx: hash, note: 'no official stock token or USDG moved in this transaction' });
      if (to) { this.node(this.seed.from, 'victim', { block }); const n = this.node(to, 'thief', { block, depth: 0 }); n.code = (await this.classify(to)) === 'contract'; await this.seedIncoming(to, block, Math.min(this.head, block + hoursToBlocks(24)), true); }
      return;
    }
    await this.ensurePrices(fz.map((l) => l.token));
    // victim = sender of the most USD (or most raw) among non-pool, non-router senders
    const outBy = new Map();
    for (const l of fz) if (l.from !== ZERO && !this.ctx.poolSet.has(l.from) && !this.ctx.routerSet.has(l.from)) outBy.set(l.from, (outBy.get(l.from) || 0) + (this.usd(l.token, l.amount) ?? this.amt(l.token, l.amount) ?? 0));
    const victim = [...outBy].sort((a, b) => b[1] - a[1])[0]?.[0] ?? this.seed.from; this.seed.victim = victim;
    this.node(victim, 'victim', { block });
    const arrivals = new Map();
    for (const l of fz) {
      const fromK = await this.classify(l.from), toK = await this.classify(l.to);
      const swapish = ['pool', 'router'].includes(fromK) || ['pool', 'router'].includes(toK);
      for (const [a, k] of [[l.from, fromK], [l.to, toK]]) if (a !== victim) this.node(a, lbl(k), { block }).code = k !== 'eoa';
      this.pushEdge(l, swapish ? 'swap' : 'transfer');
      if (l.to !== victim && toK === 'eoa' && l.from === victim) { this.noteArrival(arrivals, l); }
    }
    for (const [addr, arr] of arrivals) { const n = this.node(addr, 'thief', { block, depth: 0 }); n.label = 'thief'; this.seed.thieves.push(addr); this.addHolder(addr, 0, arr); }
    this.stolenUsd = [...arrivals.values()].flat().reduce((s, a) => s + (this.usd(a.token, a.amount) ?? 0), 0);
    // contracts that received value directly from the victim are shown, not followed
    for (const l of fz) if (l.from === victim && this.nodes.get(l.to)?.label === 'contract') this.addExit({ from: l.to, kind: 'contract', token: l.token, amount: l.amount.toString(), tx: hash, note: 'sent into a contract that is not a known pool or router; not followed' });
  }
  noteArrival(map, l) { const a = map.get(l.to) || []; a.push({ token: l.token, block: l.block, logIndex: l.logIndex, amount: l.amount, tx: l.tx }); map.set(l.to, a); }
  addHolder(addr, depth, arrivals) {
    const n = this.nodes.get(addr);
    for (const a of arrivals) { n.tokens.add(a.token); const k = key(addr, a.token); this.received.set(k, (this.received.get(k) || 0n) + a.amount); }
    const h = this.holders.get(addr);
    if (h) { h.arrivals.push(...arrivals); return; }
    if (this.done.has(addr)) return;
    this.holders.set(addr, { address: addr, depth, arrivals: [...arrivals] });
  }
  pushEdge(l, kind, extra = {}) {
    const usd = this.usd(l.token, l.amount);
    const e = { from: l.from, to: l.to, token: l.token, symbol: this.sym(l.token), amountRaw: l.amount.toString(), amount: this.amt(l.token, l.amount), usd, tx: l.tx, block: l.block, time: null, kind, logIndex: l.logIndex, ...extra };
    if (this.edges.some((x) => x.tx === e.tx && x.logIndex === e.logIndex && x.from === e.from && x.to === e.to && x.token === e.token)) return null;
    this.edges.push(e); return e;
  }
  // address / ETH-only seed: incoming transfers to `addr`
  async seedIncoming(addr, from, to, isEthFollow = false) {
    const { transfers, overflow } = await this.scanRange(from, to, [TOPIC_TRANSFER, null, topicAddr(addr)]);
    if (overflow) this.addExit({ from: addr, kind: 'fanout', tx: null, note: 'too many incoming transfers in one window; some were not read' });
    await this.ensurePrices(transfers.map((t) => t.token));
    const n = this.node(addr, 'thief', { block: from, depth: 0 });
    const arrivals = [];
    const senders = new Map();
    for (const t of transfers) {
      if (t.to !== addr) continue;
      arrivals.push({ token: t.token, block: t.block, logIndex: t.logIndex, amount: t.amount, tx: t.tx });
      const s = senders.get(t.from) || { usd: 0, items: [] }; s.usd += this.usd(t.token, t.amount) ?? 0; s.items.push(t); senders.set(t.from, s);
    }
    this.stolenUsd = arrivals.reduce((s, a) => s + (this.usd(a.token, a.amount) ?? 0), 0);
    // largest 10 senders as edges, the rest one summary row
    const ranked = [...senders].sort((a, b) => b[1].usd - a[1].usd);
    for (const [s, v] of ranked.slice(0, this.L.maxFanout)) {
      const k = await this.classify(s);
      this.node(s, lbl(k), { block: from }).code = k !== 'eoa';
      for (const t of v.items) this.pushEdge(t, ['pool', 'router'].includes(k) ? 'swap' : 'transfer');
    }
    if (ranked.length > this.L.maxFanout) { const rest = ranked.slice(this.L.maxFanout); this.addExit({ from: addr, kind: 'fanout', tx: null, amount: rest.reduce((s, [, v]) => s + v.usd, 0), note: `+${rest.length} smaller senders, total ${fmtUsdPlain(rest.reduce((s, [, v]) => s + v.usd, 0))}` }); }
    if (arrivals.length) { this.seed.thieves = [addr]; this.addHolder(addr, 0, arrivals); } else if (!isEthFollow) this.seed.thieves = [addr];
    n.firstBlock = arrivals.length ? Math.min(...arrivals.map((a) => a.block)) : from;
    return arrivals;
  }
  async seedVictim(addr, from, to) {
    const { transfers, overflow } = await this.scanRange(from, to, [TOPIC_TRANSFER, topicAddr(addr)]);
    await this.ensurePrices(transfers.map((t) => t.token));
    const cands = [];
    for (const t of transfers) {
      if (t.from !== addr || t.to === addr) continue;
      const k = await this.classify(t.to); if (k !== 'eoa') continue;
      cands.push({ receiver: t.to, token: t.token, symbol: this.sym(t.token), amountRaw: t.amount.toString(), amount: this.amt(t.token, t.amount), usd: this.usd(t.token, t.amount), tx: t.tx, block: t.block, time: null });
    }
    cands.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.block - a.block);
    this.candidates = cands.slice(0, 40); this.candidatesTotal = cands.length;
    if (overflow) this.truncated = true;
    this.node(addr, 'victim', { block: from });
    this.seed.victim = addr;
  }

  // ---- follow ----
  async followHolder(h) {
    this.done.add(h.address); this.holders.delete(h.address);
    const start = Math.min(...h.arrivals.map((a) => a.block));
    const horizonEnd = start + this.L.horizonWindows * WINDOW - 1;
    const scanTo = Math.min(this.head, horizonEnd);
    const { transfers, overflow } = await this.scanRange(start, scanTo, [TOPIC_TRANSFER, topicAddr(h.address)]);
    if (overflow) this.addExit({ from: h.address, kind: 'fanout', tx: null, note: 'too many outgoing transfers in one window; the busiest part was not read' });
    const arrivalPos = new Map(); for (const a of h.arrivals) arrivalPos.set(a.token, Math.min(arrivalPos.get(a.token) ?? Infinity, a.block * 1e6 + a.logIndex));
    let outs = transfers.filter((t) => t.from === h.address && t.to !== h.address && t.block * 1e6 + t.logIndex > (arrivalPos.get(t.token) ?? 0));
    // far follow: beyond the 24 h horizon
    if (scanTo < this.head) {
      outs = outs.concat(await this.farFollow(h, outs, scanTo + 1));
    }
    await this.processOuts(h, outs);
  }
  async farFollow(h, outs, from) {
    const tokens = [...this.nodes.get(h.address).tokens];
    let res; try { res = await this.multicall(tokens.map((t) => ({ target: t, callData: encodeBalanceOf(h.address) }))); }
    catch (e) { if (e instanceof BudgetError) { this.addExit({ from: h.address, kind: 'horizon', tx: null, note: 'follow stopped at the 24 h horizon (budget)' }); return []; } throw e; }
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i], k = key(h.address, t), now = res[i]?.success ? decodeUint(res[i].returnData) : null; if (now == null) continue;
      const sent = outs.filter((o) => o.token === t).reduce((s, o) => s + o.amount, 0n);
      if (now >= (this.received.get(k) || 0n) - sent) continue; // nothing left the address after the horizon
      try {
        for (const [a, b] of planWindows(from, this.head, 10_000_000)) {
          const logs = await this.getLogs0({ address: t, topics: [TOPIC_TRANSFER, topicAddr(h.address)], fromBlock: a, toBlock: b });
          out.push(...logs.map(parseTransfer).filter((x) => x && x.from === h.address && x.to !== h.address));
        }
      } catch (e) { if (e instanceof BudgetError) { this.addExit({ from: h.address, kind: 'horizon', token: t, tx: null, note: 'the rest of this balance left after the 24 h horizon; budget ended before it was followed' }); continue; } throw e; }
    }
    return out;
  }
  getLogs0(f) { return this.io('window', () => this.chain.getLogs(f, this.o())); } // single-token query (far follow)

  async processOuts(h, outs) {
    if (!outs.length) return;
    await this.ensurePrices(outs.map((o) => o.token));
    const stolen = this.stolenUsd;
    const byTx = new Map(); for (const o of outs) { const a = byTx.get(o.tx) || []; a.push(o); byTx.set(o.tx, a); }
    const plain = new Map(); // EOA receiver -> {usd, items}
    let dust = { n: 0, usd: 0 };
    for (const [txh, items] of byTx) {
      // classify receivers first (1 getCode per unknown)
      const kinds = []; for (const o of items) kinds.push(await this.classify(o.to));
      const needsReceipt = kinds.some((k) => k === 'pool' || k === 'router' || k === 'contract');
      let rec = null;
      if (needsReceipt) { try { rec = await this.getReceipt(txh); } catch (e) { if (e instanceof BudgetError) { for (const o of items) this.addExit({ from: h.address, kind: 'contract', token: o.token, amount: o.amount.toString(), tx: txh, note: 'receipt budget reached; swap not checked' }); continue; } throw e; } }
      const recLogs = rec ? rec.logs.map(parseTransfer).filter(Boolean) : [];
      for (let i = 0; i < items.length; i++) {
        const o = items[i], k = kinds[i];
        this.sent.set(key(h.address, o.token), (this.sent.get(key(h.address, o.token)) || 0n) + o.amount);
        if (k === 'eoa') {
          const usd = this.usd(o.token, o.amount);
          if (usd != null && usd < this.L.dustUsd && (!stolen || usd < this.L.dustFrac * stolen)) { dust.n++; dust.usd += usd; continue; }
          const p = plain.get(o.to) || { usd: 0, units: 0, items: [] }; p.usd += usd ?? 0; p.units += this.amt(o.token, o.amount) ?? 0; p.items.push(o); plain.set(o.to, p);
        } else if (k === 'burn') {
          this.addExit({ from: h.address, kind: 'contract', token: o.token, amount: o.amount.toString(), tx: txh, note: 'sent to the zero address' });
        } else {
          await this.handleSwap(h, o, k, recLogs, rec, txh);
        }
      }
    }
    if (dust.n) this.addExit({ from: h.address, kind: 'dust', tx: null, amount: dust.usd, note: `${dust.n} small transfer${dust.n > 1 ? 's' : ''} under $${this.L.dustUsd} ignored` });
    const ranked = [...plain].sort((a, b) => b[1].usd - a[1].usd || b[1].units - a[1].units);
    const room = Math.max(0, Math.min(this.L.maxFanout, this.L.maxNodes - this.nodes.size));
    if (room < Math.min(ranked.length, this.L.maxFanout)) { this.truncated = true; this.reason = this.reason || 'nodes (' + this.L.maxNodes + ')'; }
    for (const [to, v] of ranked.slice(0, room)) {
      const nn = this.node(to, 'receiver', { block: v.items[0].block, depth: h.depth + 1 }); nn.depth = Math.min(nn.depth || 99, h.depth + 1);
      const arr = [];
      for (const o of v.items) { this.pushEdge(o, 'transfer'); arr.push({ token: o.token, block: o.block, logIndex: o.logIndex, amount: o.amount, tx: o.tx }); }
      this.addHolder(to, h.depth + 1, arr);
      if (h.depth + 1 >= this.L.maxDepth) { this.holders.delete(to); nn.unfinished = true; this.addExit({ from: to, kind: 'depth', tx: v.items[0].tx, note: `trail continues past ${this.L.maxDepth} hops from the first address` }); }
    }
    if (ranked.length > room) {
      const rest = ranked.slice(room), tot = rest.reduce((s, [, v]) => s + v.usd, 0);
      this.addExit({ from: h.address, kind: 'fanout', tx: null, amount: tot, note: `+${rest.length} smaller receivers, total ${fmtUsdPlain(tot)}` });
    }
  }
  async handleSwap(h, o, recvKind, recLogs, rec, txh) {
    // outputs of the same tx: to the holder (swap result) or from the receiver to a third party
    const outputs = recLogs.filter((l) => l.token !== o.token && l.logIndex !== o.logIndex && !(l.from === h.address) && (l.to === h.address || (l.from === o.to && l.to !== o.to && !this.ctx.poolSet.has(l.to) && !this.ctx.routerSet.has(l.to) && l.to !== ZERO)));
    const ethOut = rec && rec.logs.some((l) => l.topics?.[0] === TOPIC_WITHDRAWAL);
    const via = recvKind === 'pool' ? `Uniswap V3 pool ${this.ctx.poolInfo.get(o.to)?.symbol || ''}/USDG`.trim() : recvKind === 'router' ? this.ctx.knownByAddr.get(o.to) || 'router' : 'contract';
    if (!outputs.length && !ethOut) {
      if (recvKind === 'contract') this.addExit({ from: h.address, kind: 'contract', token: o.token, amount: o.amount.toString(), tx: txh, note: 'sent into a contract that is not a known pool or router; not followed' });
      this.node(o.to, 'contract', { block: o.block }).code = true; this.pushEdge(o, 'contract'); return;
    }
    const swapTo = outputs.map((x) => ({ token: x.token, symbol: this.sym(x.token), amountRaw: x.amount.toString(), amount: this.amt(x.token, x.amount), to: x.to }));
    const recvNode = this.node(o.to, lbl(recvKind), { block: o.block }); recvNode.code = true;
    this.pushEdge(o, 'swap', { via, swapTo });
    const arrivals = new Map();
    for (const x of outputs) {
      if (this.tok(x.token)) { if (x.to === h.address) { this.nodes.get(h.address).tokens.add(x.token); const kk = key(h.address, x.token); this.received.set(kk, (this.received.get(kk) || 0n) + x.amount); } else this.noteArrival(arrivals, x); }
      else this.addExit({ from: h.address, kind: this.ctx.lookalikes.has(x.token) ? 'lookalike' : 'other-token', token: x.token, amount: x.amount.toString(), tx: txh, note: this.ctx.lookalikes.has(x.token) ? `FAKE ${this.sym(x.token) || ''} — same name, not an official Robinhood token; not freezable` : 'swapped into a token no issuer here controls; not followed' });
    }
    if (ethOut) this.addExit({ from: h.address, kind: 'eth', tx: txh, note: 'swapped to ETH; native ETH is not traced in this version' });
    for (const [to, arr] of arrivals) {
      const k = await this.classify(to); if (k !== 'eoa') continue;
      const nn = this.node(to, 'receiver', { block: arr[0].block, depth: h.depth + 1 }); nn.depth = Math.min(nn.depth || 99, h.depth + 1);
      this.addHolder(to, h.depth + 1, arr);
      if (h.depth + 1 >= this.L.maxDepth) { this.holders.delete(to); nn.unfinished = true; this.addExit({ from: to, kind: 'depth', tx: txh, note: `trail continues past ${this.L.maxDepth} hops from the first address` }); }
    }
  }

  async followAll() {
    for (;;) {
      const next = [...this.holders.values()].sort((a, b) => a.depth - b.depth)[0];
      if (!next) break;
      if (this.truncated) { for (const h of this.holders.values()) this.nodes.get(h.address).unfinished = true; break; }
      await this.followHolder(next);
    }
  }

  // ---- freezable now ----
  async refreshFreezable() {
    this.reserve = true;
    try {
      const rows = await freezableRows(this, [...this.nodes.values()].filter((n) => ['thief', 'receiver', 'contract'].includes(n.label) && n.tokens.size && !this.ctx.poolSet.has(n.address) && !this.ctx.routerSet.has(n.address)));
      return rows;
    } finally { this.reserve = false; }
  }
  async resolveTimes() {
    this.reserve = true;
    try {
      const blocks = [...new Set([...this.edges.map((e) => e.block), ...(this.candidates || []).map((c) => c.block), this.seed.block].filter((b) => b != null))].sort((a, b) => a - b);
      const exact = new Map();
      const headB = await this.getBlock(this.head); this.headTime = Number(BigInt(headB.timestamp)); exact.set(this.head, this.headTime);
      let budget = 24;
      for (const b of blocks) { if (budget <= 0) break; if (this.blockTime.has(b)) { exact.set(b, this.blockTime.get(b)); continue; } try { exact.set(b, await this.blockTs(b)); budget--; } catch { break; } }
      const anchors = [...exact].sort((a, b) => a[0] - b[0]);
      const at = (b) => {
        if (exact.get(b) != null) return [exact.get(b), false];
        let lo = anchors[0], hi = anchors.at(-1); for (const a of anchors) { if (a[0] <= b) lo = a; if (a[0] >= b) { hi = a; break; } }
        if (!lo || !hi || lo[0] === hi[0]) return [lo ? lo[1] : null, true];
        return [Math.round(lo[1] + ((b - lo[0]) * (hi[1] - lo[1])) / (hi[0] - lo[0])), true];
      };
      for (const e of this.edges) { const [t, ap] = at(e.block); e.time = t; if (ap) e.timeApprox = true; }
      for (const c of this.candidates || []) { const [t, ap] = at(c.block); c.time = t; if (ap) c.timeApprox = true; }
      const [st, sap] = at(this.seed.block); this.seed.time = st; if (sap) this.seed.timeApprox = true;
    } finally { this.reserve = false; }
  }
  snapshot(status) {
    return {
      seed: this.seed,
      nodes: [...this.nodes.values()].map((n) => ({ address: n.address, label: n.label, code: !!n.code, blocked: !!n.blocked, frozen: !!n.frozen, depth: n.depth, ...(n.unfinished ? { unfinished: true } : {}) })),
      edges: this.edges, freezable: this.freezable || [], exits: this.exits,
      ...(this.candidates ? { candidates: this.candidates, candidatesTotal: this.candidatesTotal } : {}),
      budget: { rpcCalls: this.calls, windows: this.windows, receipts: this.receipts, truncated: this.truncated, ...(this.reason ? { reason: this.reason } : {}) },
      head: this.head, headTime: this.headTime, status,
    };
  }
}

const fmtUsdPlain = (x) => '$' + Math.round(x).toLocaleString('en-US');

// Builds freezable rows for nodes (one multicall per <=150 calls). Used by the engine and the watch loop.
export async function freezableRows(T, nodes) {
  const ctx = T.ctx, pairs = [], calls = [], idx = {};
  for (const n of nodes) for (const t of n.tokens) pairs.push([n.address, t]);
  const stockTokens = [...new Set(pairs.map((p) => p[1]).filter((t) => ctx.tokens.get(t).issuer === 'robinhood'))];
  for (const [a, t] of pairs) { idx[a + '|' + t + '|bal'] = calls.length; calls.push({ target: t, callData: encodeBalanceOf(a) }); if (ctx.tokens.get(t).issuer === 'robinhood') { idx[a + '|' + t + '|ui'] = calls.length; calls.push({ target: t, callData: call1(SEL.balanceOfUI, a) }); } }
  for (const n of nodes) { idx[n.address + '|blocked'] = calls.length; calls.push({ target: ctx.registry, callData: call1(SEL.isBlocked, n.address) }); idx[n.address + '|frozen'] = calls.length; calls.push({ target: ctx.usdg, callData: call1(SEL.isFrozen, n.address) }); }
  for (const t of stockTokens) { idx[t + '|paused'] = calls.length; calls.push({ target: t, callData: SEL.paused }); }
  if (!calls.length) return [];
  const res = await T.multicall(calls);
  await T.ensurePrices(pairs.map((p) => p[1]));
  const checkedAt = Math.floor(T.now() / 1000), rows = [];
  for (const n of nodes) { const b = res[idx[n.address + '|blocked']], f = res[idx[n.address + '|frozen']]; n.blocked = !!(b?.success && decodeBool(b.returnData)); n.frozen = !!(f?.success && decodeBool(f.returnData)); }
  for (const [a, t] of pairs) {
    const info = ctx.tokens.get(t), bal = res[idx[a + '|' + t + '|bal']]; if (!bal?.success) continue;
    const raw = decodeUint(bal.returnData); if (raw === 0n) continue;
    const uiR = res[idx[a + '|' + t + '|ui']], ui = uiR?.success && uiR.returnData.length > 2 ? decodeUint(uiR.returnData) : null;
    const node = T.nodes.get(a), p = T.prices.get(t);
    const pr = res[idx[t + '|paused']];
    rows.push({
      holder: a, token: t, symbol: info.symbol, issuer: info.issuer, amountRaw: raw.toString(),
      amount: unitsToNumber(ui ?? raw, info.decimals), ...(ui != null && ui !== raw ? { amountRawUi: ui.toString() } : {}),
      usd: p != null ? unitsToNumber(raw, info.decimals) * p : null, blocked: node.blocked, frozen: info.issuer === 'paxos' ? node.frozen : false,
      paused: !!(pr?.success && decodeBool(pr.returnData)), checkedAt, checkedBlock: T.head,
    });
  }
  rows.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  return rows;
}

// ---- entry point ----
// input: {kind:'tx'|'address'|'victim', value, hours?}; deps: {chain, ctx, onProgress?, limits?, prio?, now?, issuerBlockedTx?(addr)->tx}
export async function trace(input, deps) {
  const T = new Tracer(deps, input);
  let status = 'done';
  try {
    T.head = await T.io('head', () => T.chain.head(T.o()));
    if (input.kind === 'tx') { await T.seedTx(input.value); }
    else {
      const from = Math.max(0, T.head - hoursToBlocks(input.hours || 24));
      T.seed = { kind: input.kind, value: input.value, block: from, victim: null, thieves: [] };
      if (input.kind === 'victim') await T.seedVictim(input.value, from, T.head); else await T.seedIncoming(input.value, from, T.head);
    }
    if (input.kind !== 'victim') await T.followAll();
  } catch (e) {
    if (e instanceof BudgetError) { status = 'partial'; T.truncated = true; T.reason = T.reason || e.reason; for (const h of T.holders.values()) { const n = T.nodes.get(h.address); if (n) n.unfinished = true; } }
    else throw e;
  }
  if (T.truncated) status = 'partial';
  if (!T.head) return T.snapshot(status);
  try { T.freezable = input.kind === 'victim' ? [] : await T.refreshFreezable(); } catch (e) { T.freezable = []; T.reason = T.reason || 'freezable check failed: ' + e.message; status = 'partial'; T.truncated = true; }
  for (const f of T.freezable) { f.blockedTx = deps.issuerBlockedTx?.(f.holder) ?? null; }
  try { await T.resolveTimes(); } catch { /* times stay null/approx */ }
  const g = T.snapshot(status);
  g.budget.rpcCalls = T.calls; g.generatedAt = Math.floor(T.now() / 1000);
  // nodes list: drop internal sets, add holdings summary
  return g;
}
export { BudgetError };
