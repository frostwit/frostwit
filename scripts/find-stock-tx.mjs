// Run on us1: finds a recent plain NVDA/TSLA transfer between two EOAs (for the private staging demo).
import { Lane } from '../shared/rpc/lane.mjs'; import { Chain } from '../shared/rpc/chain.mjs'; import { loadContext } from '../shared/trace/tokens.mjs';
import { TOPIC_TRANSFER, parseTransfer } from '../shared/abi.mjs';
const ctx = loadContext(), ch = new Chain(new Lane({ url: 'https://rpc.mainnet.chain.robinhood.com' }));
const head = await ch.head();
for (const sym of ['NVDA', 'TSLA', 'AAPL']) {
  const t = [...ctx.tokens.values()].find((x) => x.symbol === sym);
  for (let i = 0; i < 50; i++) {
    const to = head - 100 - i * 2000, logs = await ch.getLogs({ address: t.address, topics: [TOPIC_TRANSFER], fromBlock: to - 1999, toBlock: to });
    for (const l of logs.map(parseTransfer)) {
      if (!l || ctx.poolSet.has(l.from) || ctx.poolSet.has(l.to) || ctx.routerSet.has(l.to) || ctx.routerSet.has(l.from) || /^0x0+$/.test(l.from) || /^0x0+$/.test(l.to)) continue;
      const [cf, ct] = [await ch.code(l.from), await ch.code(l.to)];
      if (cf === '0x' && ct === '0x' && l.amount > 10n ** 18n) { console.log(JSON.stringify({ toIsEoa: ct === '0x', sym, tx: l.tx, from: l.from, to: l.to, amount: l.amount.toString(), block: l.block })); process.exit(0); }
    }
  }
}
console.log('none');
