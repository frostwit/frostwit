// Hand-rolled ABI helpers (read only): ERC-20, Multicall3 aggregate3, registry, USDG, Uniswap V3 pool.
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const TOPIC_BLOCKED = '0x75e91ce73c1d3352d8dd3610443539cd33dfe13b1de8f8caae54ec26dd0dc9cb';
export const TOPIC_UNBLOCKED = '0x5c272fb29e21b46870af1850afe89126704c55a7781cc100da3f733e15446c7d';
export const TOPIC_WITHDRAWAL = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
export const TOPIC_APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
export const SEL = {
  balanceOf: '0x70a08231', balanceOfUI: '0x437a9958', paused: '0x5c975abb', isBlocked: '0xfbac3951', isFrozen: '0xe5839836',
  allowance: '0xdd62ed3e', slot0: '0x3850c7bd', liquidity: '0x1a686502', token0: '0x0dfe1681', token1: '0xd21220a7',
  decimals: '0x313ce567', uiMultiplier: '0xa60bf13d',
};
const hex32 = (n) => BigInt(n).toString(16).padStart(64, '0');
export const addr32 = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
export const topicAddr = (a) => '0x' + addr32(a);
export const addrFromTopic = (t) => '0x' + t.slice(-40).toLowerCase();
export const call1 = (sel, a) => sel + addr32(a);
export const encodeBalanceOf = (holder) => call1(SEL.balanceOf, holder);
export const encodeAllowance = (owner, spender) => SEL.allowance + addr32(owner) + addr32(spender);

// calls: [{ target, callData, allowFailure? }] -> calldata hex
export function encodeAggregate3(calls) {
  const elems = calls.map((c) => {
    const data = c.callData.replace(/^0x/, ''), len = data.length / 2, padded = data.padEnd(Math.ceil(len / 32) * 64, '0');
    return addr32(c.target) + hex32(1) + hex32(0x60) + hex32(len) + padded;
  });
  let off = calls.length * 32; const offs = [];
  for (const e of elems) { offs.push(hex32(off)); off += e.length / 2; }
  return '0x82ad56cb' + hex32(0x20) + hex32(calls.length) + offs.join('') + elems.join('');
}
// -> [{ success, returnData(hex) }]
export function decodeAggregate3(hex) {
  const d = hex.replace(/^0x/, ''), word = (i) => BigInt('0x' + d.slice(i * 2, i * 2 + 64));
  const base = Number(word(0)), n = Number(word(base)), start = base + 32, out = [];
  for (let i = 0; i < n; i++) {
    const t = start + Number(word(start + i * 32));
    const success = word(t) === 1n, bo = t + Number(word(t + 32)), len = Number(word(bo));
    out.push({ success, returnData: '0x' + d.slice((bo + 32) * 2, (bo + 32 + len) * 2) });
  }
  return out;
}
export const decodeUint = (hex) => (hex && hex.length > 2 ? BigInt(hex) : 0n);
export const decodeBool = (hex) => !!hex && hex.length > 2 && BigInt(hex) !== 0n;
// slot0() -> sqrtPriceX96 (first word)
export const decodeSqrtPrice = (hex) => (hex && hex.length >= 66 ? BigInt('0x' + hex.slice(2, 66)) : 0n);
// Transfer log -> {token, from, to, amount(BigInt), block, tx, logIndex}
export function parseTransfer(l) {
  if (!l.topics || l.topics.length !== 3 || l.topics[0] !== TOPIC_TRANSFER) return null;
  return {
    token: l.address.toLowerCase(), from: addrFromTopic(l.topics[1]), to: addrFromTopic(l.topics[2]),
    amount: decodeUint(l.data), block: Number(BigInt(l.blockNumber)), tx: l.transactionHash, logIndex: Number(BigInt(l.logIndex)),
    ts: l.blockTimestamp ? Number(BigInt(l.blockTimestamp)) : null,
  };
}
