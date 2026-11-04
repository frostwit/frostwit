// Typed chain reads on top of the lane. All methods take {prio}. Counting for budgets is done by the caller (engine meter).
import { Lane, PRIO } from './lane.mjs';
import { MULTICALL3, encodeAggregate3, decodeAggregate3 } from '../abi.mjs';

const hexn = (n) => '0x' + Number(n).toString(16);
export class Chain {
  constructor(lane, { immutableDepth = 64 } = {}) { this.lane = lane; this.depth = immutableDepth; this.lastHead = 0; }
  async head(o = {}) { const h = Number(BigInt(await this.lane.request('eth_blockNumber', [], { prio: o.prio ?? PRIO.interactive }))); this.lastHead = h; return h; }
  // ranges that end >= 64 blocks below head are immutable: cached forever
  async getLogs(f, o = {}) {
    const to = f.toBlock === 'latest' ? Infinity : Number(f.toBlock);
    const immutable = this.lastHead && to <= this.lastHead - this.depth;
    const filter = { ...f, fromBlock: hexn(f.fromBlock), toBlock: f.toBlock === 'latest' ? 'latest' : hexn(f.toBlock) };
    return this.lane.request('eth_getLogs', [filter], { prio: o.prio ?? PRIO.interactive, ttl: immutable ? 'forever' : undefined });
  }
  tx(hash, o = {}) { return this.lane.request('eth_getTransactionByHash', [hash], { prio: o.prio ?? PRIO.interactive, ttl: 'forever' }); }
  receipt(hash, o = {}) { return this.lane.request('eth_getTransactionReceipt', [hash], { prio: o.prio ?? PRIO.interactive, ttl: 'forever' }); }
  block(n, o = {}) { return this.lane.request('eth_getBlockByNumber', [hexn(n), false], { prio: o.prio ?? PRIO.interactive, ttl: 'forever' }); }
  code(addr, o = {}) { return this.lane.request('eth_getCode', [addr, 'latest'], { prio: o.prio ?? PRIO.interactive, ttl: 'forever' }); }
  call(to, data, o = {}) { return this.lane.request('eth_call', [{ to, data }, 'latest'], { prio: o.prio ?? PRIO.interactive, ttl: o.ttl ?? 60 }); }
  // calls [{target, callData}] -> [{success, returnData}]; chunks of <= 150, each chunk = 1 lane request
  async multicall(calls, o = {}) {
    const out = [];
    for (let i = 0; i < calls.length; i += 150) {
      const chunk = calls.slice(i, i + 150);
      const r = await this.lane.request('eth_call', [{ to: MULTICALL3, data: encodeAggregate3(chunk) }, 'latest'], { prio: o.prio ?? PRIO.interactive, ttl: o.ttl ?? 60 });
      out.push(...decodeAggregate3(r));
    }
    return out;
  }
}
export { Lane, PRIO };
