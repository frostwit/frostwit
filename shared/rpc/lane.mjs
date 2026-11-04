// The single RPC lane. Every chain read in the process goes through here: one FIFO-per-priority queue,
// <= 1 request in flight, 350 ms minimum spacing, 10 s timeout. HTTP 429 or a JSON-RPC error matching
// /rate|too many/i pauses the WHOLE lane for 61 s and retries the same request afterwards. Never parallel.
import { createHash } from 'node:crypto';

export const PRIO = { interactive: 0, watch: 1, tail: 2, backfill: 3 };
const RATE_RE = /rate|too many/i;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const cacheKey = (method, params) => createHash('blake2s256').update(method + JSON.stringify(params)).digest('hex').slice(0, 32);

export class Lane {
  constructor(o = {}) {
    this.url = o.url; this.ua = o.userAgent || 'frostwit.pro/0.1 (+https://frostwit.pro/docs#data)';
    this.spacingMs = o.spacingMs ?? 350; this.pauseMs = o.pauseMs ?? 61000; this.timeoutMs = o.timeoutMs ?? 10000;
    this.retryDelays = o.retryDelays || [1000, 3000, 9000];
    this.fetchImpl = o.fetchImpl || fetch; this.now = o.now || Date.now; this.sleep = o.sleep || defaultSleep;
    this.cache = o.cache || null;
    this.queues = [[], [], [], []]; this.running = false; this.inFlight = 0; this.maxInFlight = 0;
    this.pausedUntil = 0; this.lastStart = 0; this.calls = []; this.failures = 0; this.lastOkAt = 0; this.totalCalls = 0;
    this.log = o.log || (() => {}); this.id = 1;
  }
  state() {
    const t = this.now();
    this.calls = this.calls.filter((c) => c > t - 60000);
    return { inFlight: this.inFlight, queued: this.queued(), pausedUntil: this.pausedUntil, pausedSec: Math.max(0, Math.ceil((this.pausedUntil - t) / 1000)), callsLastMin: this.calls.length, failures: this.failures, lastOkAt: this.lastOkAt };
  }
  queued() { return this.queues.reduce((n, q) => n + q.length, 0); }
  // ttl: 'forever' | seconds | undefined (do not cache). A cache hit costs no lane time.
  async request(method, params = [], { prio = PRIO.interactive, ttl } = {}) {
    const key = ttl != null && this.cache ? cacheKey(method, params) : null;
    if (key) { const hit = this.cache.get(key); if (hit !== undefined) return JSON.parse(hit); }
    const result = await new Promise((resolve, reject) => {
      this.queues[Math.min(3, Math.max(0, prio))].push({ method, params, resolve, reject });
      this._pump();
    });
    if (key) this.cache.set(key, JSON.stringify(result), ttl);
    return result;
  }
  async _pump() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const q = this.queues.find((x) => x.length);
        if (!q) break;
        const now = this.now();
        const wait = Math.max(this.pausedUntil - now, this.lastStart + this.spacingMs - now);
        if (wait > 0) { await this.sleep(wait); continue; } // re-evaluate: a higher priority job may have arrived
        const job = q.shift();
        await this._run(job);
      }
    } finally { this.running = false; }
  }
  async _run(job) {
    let transient = 0;
    for (;;) {
      const now = this.now();
      const wait = Math.max(this.pausedUntil - now, this.lastStart + this.spacingMs - now);
      if (wait > 0) await this.sleep(wait);
      this.lastStart = this.now(); this.calls.push(this.lastStart); this.totalCalls++;
      this.inFlight++; this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      let out;
      try { out = await this._send(job.method, job.params); } finally { this.inFlight--; }
      if (out.ok) { this.failures = 0; this.lastOkAt = this.now(); return job.resolve(out.result); }
      if (out.rate) { this.pausedUntil = this.now() + this.pauseMs; this.log('rate limit: lane paused 61 s'); continue; }
      if (out.rpcError) { this.failures = 0; this.lastOkAt = this.now(); const e = new Error(out.message); e.rpc = true; e.code = out.code; return job.reject(e); }
      // transient transport error
      this.failures++;
      if (transient >= this.retryDelays.length) return job.reject(Object.assign(new Error('rpc_unavailable: ' + out.message), { transport: true }));
      await this.sleep(this.retryDelays[transient++]);
    }
  }
  async _send(method, params) {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': this.ua }, body: JSON.stringify({ jsonrpc: '2.0', id: this.id++, method, params }), signal: ctl.signal });
      if (res.status === 429) return { rate: true };
      const text = await res.text();
      let j; try { j = JSON.parse(text); } catch { return RATE_RE.test(text) ? { rate: true } : { message: `http ${res.status} non-json` }; }
      if (j.error) { const m = String(j.error.message || ''); return RATE_RE.test(m) ? { rate: true } : { rpcError: true, message: m, code: j.error.code }; }
      if (!res.ok) return { message: `http ${res.status}` };
      return { ok: true, result: j.result };
    } catch (e) { return { message: e.name === 'AbortError' ? 'timeout' : String(e.message || e) }; } finally { clearTimeout(tm); }
  }
}
