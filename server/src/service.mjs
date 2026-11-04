import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { Lane, PRIO } from '../../shared/rpc/lane.mjs';
import { Chain } from '../../shared/rpc/chain.mjs';
import { loadContext, buildContext } from '../../shared/trace/tokens.mjs';
import { trace } from '../../shared/trace/engine.mjs';
import { watchCheck } from '../../shared/trace/watch.mjs';
import { parseInput, notWalletReason, ApiError, MSG } from '../../shared/trace/validate.mjs';
import { windowCount } from '../../shared/trace/windows.mjs';
import { scanRegistry, enrichEvents, firstBatch } from '../../shared/issuer/tail.mjs';
import { checkAddress } from '../../shared/trace/check.mjs';
import { call1, SEL, decodeBool, encodeBalanceOf, decodeUint } from '../../shared/abi.mjs';
import { norm, isAddr } from '../../shared/format.mjs';
import { publicSeed, publicNodes } from '../../shared/trace/public.mjs';
import { readJson } from './config.mjs';

export const METRIC_KEYS = ['case_new', 'case_view', 'pack', 'api', 'status', 'actions', 'check', 'priority', 'og_fail', 'poster_fail'];
const now = () => Math.floor(Date.now() / 1000);
export const caseId = (kind, value, hours) => createHash('blake2b512').update(`${kind}|${value}|${hours ?? ''}`).digest('hex').slice(0, 12);

class Hourly {
  constructor(limit) { this.limit = limit; this.m = new Map(); }
  prune(k, t) { const a = (this.m.get(k) || []).filter((x) => x > t - 3600_000); this.m.set(k, a); return a; }
  check(k, t = Date.now()) { const a = this.prune(k, t); return a.length < this.limit ? 0 : Math.ceil((a[0] + 3600_000 - t) / 1000); }
  add(k, t = Date.now()) { this.prune(k, t).push(t); }
}

export function createService({ cfg, db, chain, lane, ctx, getToken, log = () => {} }) {
  const S = { rpcOk: true, head: 0, headAt: 0, healthFails: 0, nextHealthAt: 0, backfillDone: false, startedAt: Date.now(), running: null, timers: [], stopped: false, lastTailAt: 0 };
  const perIp = new Hourly(cfg.traceCapPerIpHour), global = new Hourly(cfg.traceCapGlobalHour), ipCase = new Map();
  const blockedTx = (a) => db.lastBlockedTx(a);

  // ---------- cases ----------
  function estimate(row) { return row.kind === 'tx' ? 70 : windowCount(row.hours || 24) + 40; }
  function queueInfo(row) {
    const q = db.queuedCases(); const lanest = lane?.state?.() || { pausedSec: 0 };
    const idx = q.findIndex((r) => r.id === row.id);
    if (idx < 0) return { position: 0, etaSec: 0, pausedSec: lanest.pausedSec, ahead: 0 };
    const callsAhead = q.slice(0, idx).reduce((s, r) => s + Math.max(0, estimate(r) - (r.rpc_calls || 0)), 0);
    const own = Math.max(0, estimate(row) - (row.rpc_calls || 0));
    return { position: row.status === 'tracing' ? 0 : idx + (q[0]?.status === 'tracing' ? 0 : 1), etaSec: Math.ceil((callsAhead + own) * 0.35 + lanest.pausedSec), pausedSec: lanest.pausedSec, ahead: idx, hours: row.hours };
  }
  async function createCase({ input, hours, role, ip = 'local' }) {
    db.metric('case_new');
    const p = parseInput(input, { hours, role });
    if (p.kind !== 'tx') { const why = notWalletReason(p.value, ctx); if (why) throw new ApiError(400, 'not_a_wallet', why); }
    const id = caseId(p.kind, p.value, p.hours);
    const existing = db.getCase(id);
    if (existing && existing.status !== 'error') return { id, status: existing.status, queue: queueInfo(existing), existing: true };
    if (!S.rpcOk) throw new ApiError(503, 'rpc_unavailable', 'Robinhood Chain RPC is not reachable right now. Existing case links keep working.');
    const waitIp = perIp.check(ip), waitG = global.check();
    if (waitIp || waitG) throw new ApiError(429, 'busy', `Too many new cases right now — try again in ${Math.max(waitIp, waitG)} s. Existing case links keep working.`, { retryAfterSec: Math.max(waitIp, waitG) });
    const prevId = ipCase.get(ip), prev = prevId ? db.getCase(prevId) : null;
    if (prev && ['queued', 'tracing'].includes(prev.status)) throw new ApiError(429, 'busy', 'One case per visitor at a time: your previous case is still queued or tracing.', { retryAfterSec: 30 });
    if (p.kind === 'tx') {
      // honest 404 before queueing; do not wait forever behind a rate-limit pause
      const found = await Promise.race([chain.tx(p.value, { prio: PRIO.interactive }).then((t) => (t ? 1 : 0)).catch((e) => (e.transport ? -1 : 0)), new Promise((r) => setTimeout(() => r(-1), 12_000))]);
      if (found === 0) throw new ApiError(404, 'tx_not_found', MSG.tx_not_found);
    }
    perIp.add(ip); global.add(); ipCase.set(ip, id);
    if (existing) db.updateCase(id, { status: 'queued', error: null, created_at: now() }); else db.insertCase({ id, kind: p.kind, value: p.value, hours: p.hours });
    setImmediate(() => pump());
    const row = db.getCase(id);
    return { id, status: 'queued', queue: queueInfo(row), existing: false };
  }
  async function runCase(row) {
    const id = row.id; db.updateCase(id, { status: 'tracing' });
    const input = { kind: row.kind, value: row.value, hours: row.hours };
    try {
      const g = await trace(input, { chain, ctx, issuerBlockedTx: blockedTx, prio: row.hours > 24 ? PRIO.interactive : PRIO.interactive, onProgress: (snap) => db.updateCase(id, { graph_json: JSON.stringify(snap), rpc_calls: snap.budget.rpcCalls }) });
      const t = now();
      db.updateCase(id, { status: g.status, graph_json: JSON.stringify(g), rpc_calls: g.budget.rpcCalls, last_check_at: t, last_check_block: g.head, since_block: g.seed.block, watch_until: t + cfg.watchDays * 86400, finished_at: t, error: g.budget.reason && g.status === 'partial' ? g.budget.reason : null });
      db.insertCheck(id, t, g.head, g.freezable, []);
    } catch (e) {
      if (e instanceof ApiError) db.updateCase(id, { status: 'error', error: e.code });
      else if (e.transport) { db.updateCase(id, { status: 'queued', error: 'rpc_unavailable' }); S.backoffUntil = Date.now() + 30_000; }
      else { log('case error', id, e.stack || e.message); db.updateCase(id, { status: 'error', error: 'trace_failed' }); }
    }
  }
  async function pump() {
    if (S.running || S.stopped) return;
    if (S.backoffUntil && Date.now() < S.backoffUntil) return;
    if (!S.rpcOk) return;
    const next = db.queuedCases().find((r) => r.status === 'queued') || null;
    if (!next) return;
    S.running = runCase(next).finally(() => { S.running = null; setImmediate(() => pump()); });
  }
  function view(id) {
    const row = db.getCase(id); if (!row) return null;
    const g = row.graph_json ? JSON.parse(row.graph_json) : null;
    const t = now(), priority = !!(row.priority_until && row.priority_until > t);
    const status = row.status === 'error' ? 'error' : (g?.status && ['done', 'partial'].includes(row.status) ? g.status : row.status);
    return {
      id: row.id, input: { kind: row.kind, value: row.value, hours: row.hours }, createdAt: row.created_at, status, error: row.error,
      seed: publicSeed(row.kind, g?.seed ?? { kind: row.kind, value: row.value, block: row.since_block, thieves: [] }),
      nodes: publicNodes(row.kind, g?.nodes ?? []),
      edges: g?.edges ?? [], freezable: g?.freezable ?? [], exits: g?.exits ?? [],
      ...(g?.candidates ? { candidates: g.candidates, candidatesTotal: g.candidatesTotal } : {}),
      budget: g?.budget ?? { rpcCalls: row.rpc_calls || 0, windows: 0, receipts: 0, truncated: false },
      head: g?.head ?? null, headTime: g?.headTime ?? null,
      checks: db.listChecks(id, 50), lastCheckAt: row.last_check_at, lastCheckBlock: row.last_check_block,
      watch: { until: row.watch_until, cadenceMin: (priority ? cfg.priorityCadenceSec : cfg.publicCadenceSec) / 60, priority },
      queue: queueInfo(row), rpcOk: S.rpcOk,
      links: { page: `${cfg.siteUrl}/case/${row.id}`, pack: `${cfg.siteUrl}/case/${row.id}/pack`, blockscout: row.kind === 'tx' ? `https://robinhoodchain.blockscout.com/tx/${row.value}` : `https://robinhoodchain.blockscout.com/address/${row.value}` },
    };
  }

  // ---------- watch ----------
  async function watchTick() {
    if (!S.rpcOk || S.stopped) return 0;
    const t = now(); let n = 0;
    for (const row of db.watchCandidates()) {
      if (n >= 20) break;
      const cad = row.priority_until && row.priority_until > t ? cfg.priorityCadenceSec : cfg.publicCadenceSec;
      if (row.last_check_at && t - row.last_check_at < cad) continue;
      if (row.kind === 'victim') continue;
      const g = row.graph_json ? JSON.parse(row.graph_json) : null; if (!g || !g.freezable) continue;
      n++;
      try {
        const r = await watchCheck(g, { chain, ctx, issuerBlockedTx: blockedTx }, row.last_check_block || g.head);
        db.updateCase(row.id, { graph_json: JSON.stringify(r.graph), last_check_at: r.checkedAt, last_check_block: r.block });
        if (r.diff.length) db.insertCheck(row.id, r.checkedAt, r.block, r.graph.freezable, r.diff);
      } catch (e) { log('watch error', row.id, e.message); if (e.transport) break; }
    }
    return n;
  }

  // ---------- issuer tail ----------
  async function loadSeed() {
    if (db.eventsMax().n > 0 || !fs.existsSync(cfg.issuerSeed)) return;
    const seed = readJson(cfg.issuerSeed, null); if (!seed?.events?.length) return;
    db.insertEvents(seed.events); db.setKv('issuer_last_block', seed.recordedAtHead); db.setKv('backfill_done', 1);
  }
  async function issuerTick() {
    if (!S.rpcOk || S.stopped) return;
    try {
      const head = await chain.head({ prio: PRIO.tail }); S.head = head; S.headAt = Date.now();
      let last = Number(db.kv('issuer_last_block') ?? -1);
      const full = last < 0;
      const from = full ? 0 : Math.max(0, last - 64);
      const raw = await scanRegistry(chain, ctx.registry, from, head, { prio: full ? PRIO.backfill : PRIO.tail, onWindow: (b) => { if (full) db.setKv('issuer_last_block', b); } });
      const known = new Set(db.allEvents().map((e) => e.tx + ':' + e.log_index));
      const fresh = raw.filter((e) => !known.has(e.tx + ':' + e.log_index));
      if (fresh.length) {
        db.insertEvents(fresh); // raw first: counts are right immediately
        const en = await enrichEvents(chain, fresh, { prio: PRIO.tail });
        for (const e of en) db.updateEvent(e);
      }
      db.setKv('issuer_last_block', head); db.setKv('backfill_done', 1); S.backfillDone = true; S.lastTailAt = Date.now();
    } catch (e) { log('issuer tick', e.message); }
  }
  async function enrichPending() {
    if (!S.rpcOk) return;
    const pend = db.pendingEvents(); if (!pend.length) return;
    try { const en = await enrichEvents(chain, pend, { prio: PRIO.backfill }); for (const e of en) db.updateEvent(e); } catch (e) { log('enrich', e.message); }
  }

  // ---------- health ----------
  async function healthTick() {
    if (S.stopped || Date.now() < S.nextHealthAt) return;
    try {
      const h = await chain.head({ prio: PRIO.watch }); S.head = h; S.headAt = Date.now(); S.healthFails = 0; if (!S.rpcOk) log('rpc back'); S.rpcOk = true; S.nextHealthAt = 0;
    } catch (e) {
      S.healthFails++; if (S.healthFails >= 3) { S.rpcOk = false; S.nextHealthAt = Date.now() + Math.min(300_000, 30_000 * 2 ** (S.healthFails - 3)); }
    }
  }

  // ---------- status / stats ----------
  async function addressStatus(address) {
    const a = norm(address); const events = db.eventsForAddress(a);
    let blocked = null, frozen = null, live = false;
    if (S.rpcOk) {
      try {
        const r = await chain.multicall([{ target: ctx.registry, callData: call1(SEL.isBlocked, a) }, { target: ctx.usdg, callData: call1(SEL.isFrozen, a) }], { prio: PRIO.interactive, ttl: 30 });
        blocked = !!(r[0].success && decodeBool(r[0].returnData)); frozen = !!(r[1].success && decodeBool(r[1].returnData)); live = true;
      } catch (e) { /* fall through to events only */ }
    }
    return { address: a, blocked, frozen, live, events: events.map((e) => ({ block: e.block, tx: e.tx, log_index: e.log_index, kind: e.kind, address: e.address, operator: e.operator, time: e.time })), checkedAt: live ? now() : null, usdgHistoryIndexed: false };
  }
  async function check(address, id) {
    if (!S.rpcOk) throw new ApiError(503, 'rpc_unavailable', 'Robinhood Chain RPC is not reachable right now.');
    const owner = norm(address), view = id && /^[0-9a-f]{12}$/.test(id) ? view_(id) : null;
    if (id && !view) throw new ApiError(404, 'not_found', 'No such case.');
    const why = notWalletReason(owner, ctx); if (why) throw new ApiError(400, 'not_a_wallet', why);
    return checkAddress(chain, ctx, owner, { view, prio: PRIO.interactive });
  }
  const view_ = (id) => view(id);
  function issuerActions(limit = 100, cursor) {
    limit = Math.min(500, Math.max(1, Number(limit) || 100));
    const rows = db.eventsPage(limit, cursor), all = db.eventsMax();
    const events = rows.map((e) => ({ block: e.block, tx: e.tx, log_index: e.log_index, kind: e.kind, address: e.address, operator: e.operator, time: e.time }));
    const last = db.eventsPage(1)[0];
    return { events, blockedNow: db.blockedNow(), eventsTotal: all.n, head: S.head || null, lastAction: last ? { block: last.block, time: last.time, tx: last.tx, kind: last.kind } : null, nextCursor: rows.length === limit ? `${rows.at(-1).block}:${rows.at(-1).log_index}` : null, backfillDone: S.backfillDone || db.kv('backfill_done') === '1', batch: firstBatch(db.allEvents()) };
  }
  function stats() {
    const c = db.caseCounts(); const last = db.eventsPage(1)[0];
    const ls = lane?.state?.() || { queued: 0, pausedSec: 0 };
    return { blockedNow: db.blockedNow(), lastActionAt: last?.time ?? null, lastActionBlock: last?.block ?? null, eventsTotal: db.eventsMax().n, casesTotal: c.total, casesToday: c.today, rpcOk: S.rpcOk, backfillDone: S.backfillDone || db.kv('backfill_done') === '1', lane: { queued: ls.queued, pausedSec: ls.pausedSec } };
  }
  function health() { const ls = lane?.state?.() || {}; return { ok: true, rpcOk: S.rpcOk, head: S.head, lane: { inFlight: ls.inFlight ?? 0, queued: ls.queued ?? 0, pausedSec: ls.pausedSec ?? 0, callsLastMin: ls.callsLastMin ?? 0 }, backfillDone: S.backfillDone || db.kv('backfill_done') === '1', uptimeSec: Math.floor((Date.now() - S.startedAt) / 1000), launched: !!getToken().launched }; }

  // ---------- P2: priority watch ----------
  async function fwitBalance(holder) {
    const t = getToken(); if (!t.launched || !isAddr(t.ca)) return null;
    const h = db.holder(holder); if (h && now() - h.checked_at < 600) return BigInt(h.fwit_raw);
    const r = await chain.multicall([{ target: t.ca, callData: encodeBalanceOf(holder) }], { prio: PRIO.interactive, ttl: 60 });
    const v = r[0].success ? decodeUint(r[0].returnData) : 0n; db.setHolder(holder, v); return v;
  }

  function start() {
    const every = (fn, ms, first = 0) => { const run = async () => { if (S.stopped) return; try { await fn(); } catch (e) { log('loop', e.message); } }; S.timers.push(setTimeout(run, first)); S.timers.push(setInterval(run, ms)); };
    every(healthTick, cfg.healthEveryMs, 200);
    every(issuerTick, cfg.tailEveryMs, 1500);
    every(enrichPending, 120_000, 20_000);
    every(watchTick, cfg.watchEveryMs, 30_000);
    every(pump, 5_000, 500);
    every(() => db.pruneCache(), 3600_000, 60_000);
  }
  function stop() { S.stopped = true; S.timers.forEach((t) => { clearTimeout(t); clearInterval(t); }); }
  return { S, createCase, view, pump, runCase, watchTick, issuerTick, healthTick, enrichPending, loadSeed, addressStatus, check, issuerActions, stats, health, fwitBalance, start, stop, queueInfo, perIp, global };
}

export function buildRuntime(cfg, { dbApi, getToken, log }) {
  const lane = new Lane({ url: cfg.rpcUrl, cache: dbApi.cache, log });
  const chain = new Chain(lane);
  const ctx = (() => { const rd = (f) => JSON.parse(fs.readFileSync(f, 'utf8')); return buildContext(rd(cfg.stocksJson), rd(cfg.knownJson)); })();
  return { lane, chain, ctx };
}
