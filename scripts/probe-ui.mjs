// Day-1 check (run on us1): balanceOf vs balanceOfUI vs uiMultiplier for the deepest pool of 3 stock tokens.
import { Lane } from '../shared/rpc/lane.mjs'; import { Chain } from '../shared/rpc/chain.mjs'; import { loadContext } from '../shared/trace/tokens.mjs';
import { SEL, call1, encodeBalanceOf } from '../shared/abi.mjs';
const ctx = loadContext(), ch = new Chain(new Lane({ url: 'https://rpc.mainnet.chain.robinhood.com' }));
for (const sym of ['NVDA', 'AAPL', 'TSLA', 'PLTR']) {
  const t = [...ctx.tokens.values()].find((x) => x.symbol === sym); const pool = t.pools.sort((a, b) => b.usdg - a.usdg)[0].pool;
  const r = await ch.multicall([{ target: t.address, callData: encodeBalanceOf(pool) }, { target: t.address, callData: call1(SEL.balanceOfUI, pool) }, { target: t.address, callData: SEL.uiMultiplier }]);
  const [b, u, m] = r.map((x) => BigInt(x.returnData)); console.log(sym, 'balanceOf', b, 'balanceOfUI', u, 'uiMultiplier', m, 'b*m/1e18 == ui?', (b * m) / 10n ** 18n === u, 'ratio', Number(u) / Number(b));
}
