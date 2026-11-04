// In-memory chain for engine tests. Same methods as shared/rpc/chain.mjs. Synthetic data: used ONLY by tests, never by fixtures/.
import { TOPIC_TRANSFER, TOPIC_WITHDRAWAL, SEL, topicAddr, encodeAggregate3, decodeAggregate3 } from '../../abi.mjs';
import { loadContext } from '../tokens.mjs';

const hex = (n) => '0x' + BigInt(n).toString(16);
const w = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
export const ctx = loadContext();
export const NVDA = ctx.tokens.get('0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec') ? '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec' : [...ctx.tokens.keys()][0];
export const USDG = ctx.usdg;
export const addrN = (n) => '0x' + n.toString(16).padStart(40, '0');
export const nvdaPool = ctx.tokens.get(NVDA).pools[0].pool;
export const E18 = 10n ** 18n;

export class MockChain {
  constructor({ head = 105_000_000, price = 100 } = {}) {
    this.headN = head; this.logs = []; this.txs = new Map(); this.receipts = new Map(); this.codes = new Set(); this.blocked = new Set(); this.frozen = new Set(); this.pausedTok = new Set();
    this.price = price; this.calls = 0; this.inFlight = 0; this.maxInFlight = 0; this.log = []; this.logIdx = 0; this.failBlocks = false; this.t0 = 1_793_000_000;
  }
  ts(b) { return this.t0 + Math.floor(b / 9.7); }
  transfer({ token, from, to, amount, block, tx, extra = [] }) {
    const l = { address: token, topics: [TOPIC_TRANSFER, topicAddr(from), topicAddr(to)], data: w(amount), blockNumber: hex(block), transactionHash: tx, logIndex: hex(this.logIdx++), blockTimestamp: '0x0' };
    this.logs.push(l); return l;
  }
  // tx with transfers: [{token, from, to, amount}], extra raw logs (e.g. Withdrawal), value
  addTx(hash, { from, to, block, transfers = [], extraLogs = [], value = 0n }) {
    const logs = transfers.map((t) => this.transfer({ ...t, block, tx: hash }));
    for (const x of extraLogs) logs.push({ ...x, blockNumber: hex(block), transactionHash: hash, logIndex: hex(this.logIdx++) });
    this.txs.set(hash, { hash, from, to, value: hex(value), blockNumber: hex(block) });
    this.receipts.set(hash, { transactionHash: hash, blockNumber: hex(block), status: '0x1', logs });
  }
  async enter(fn) { this.calls++; this.inFlight++; this.maxInFlight = Math.max(this.maxInFlight, this.inFlight); try { await Promise.resolve(); return fn(); } finally { this.inFlight--; } }
  head() { return this.enter(() => this.headN); }
  block(n) { return this.enter(() => ({ number: hex(n), timestamp: hex(this.ts(n)) })); }
  tx(h) { return this.enter(() => this.txs.get(h) ?? null); }
  receipt(h) { return this.enter(() => this.receipts.get(h) ?? null); }
  code(a) { return this.enter(() => (this.codes.has(a) ? '0x6080' : '0x')); }
  getLogs(f) {
    return this.enter(() => {
      const from = Number(f.fromBlock), to = Number(f.toBlock);
      this.log.push({ from, to, addr: Array.isArray(f.address) ? 'array' : f.address });
      if (Array.isArray(f.address) && to - from + 1 > 100_000) throw Object.assign(new Error('query spans too many blocks'), { rpc: true });
      const addrs = Array.isArray(f.address) ? new Set(f.address) : new Set([f.address]);
      const out = this.logs.filter((l) => {
        const b = Number(BigInt(l.blockNumber)); if (b < from || b > to || !addrs.has(l.address)) return false;
        return f.topics.every((t, i) => t == null || (Array.isArray(t) ? t.includes(l.topics[i]) : l.topics[i] === t));
      });
      if (out.length > 10000) throw Object.assign(new Error('logs matched by query exceeds limit of 10000'), { rpc: true });
      return out;
    });
  }
  balance(token, a) { let s = 0n; for (const l of this.logs) if (l.address === token && Number(BigInt(l.blockNumber)) <= this.headN) { if (l.topics[2] === topicAddr(a)) s += BigInt(l.data); if (l.topics[1] === topicAddr(a)) s -= BigInt(l.data); } return s; }
  sqrt() {
    // stock token0 if address < usdg
    const s = BigInt(NVDA) < BigInt(USDG) ? Math.sqrt(this.price * 1e-12) : Math.sqrt(1e12 / this.price);
    return BigInt(Math.round(s * 2 ** 48)) << 48n;
  }
  multicall(calls) {
    return this.enter(() => calls.map((c) => {
      const sel = c.callData.slice(0, 10), arg = '0x' + c.callData.slice(34, 74);
      const ok = (v) => ({ success: true, returnData: w(v) });
      if (sel === SEL.balanceOf || sel === SEL.balanceOfUI) return ok(this.balance(c.target, arg));
      if (sel === SEL.isBlocked) return ok(this.blocked.has(arg) ? 1 : 0);
      if (sel === SEL.isFrozen) return ok(this.frozen.has(arg) ? 1 : 0);
      if (sel === SEL.paused) return ok(this.pausedTok.has(c.target) ? 1 : 0);
      if (sel === SEL.slot0) return { success: true, returnData: w(this.sqrt()) + '00'.repeat(32 * 6) };
      return { success: false, returnData: '0x' };
    }));
  }
}
export const withdrawalLog = (weth, src) => ({ address: weth, topics: [TOPIC_WITHDRAWAL, topicAddr(src)], data: w(1n) });
export { encodeAggregate3, decodeAggregate3 };
