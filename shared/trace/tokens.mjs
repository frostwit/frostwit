// Static context: freezable token set, pools, routers, lookalikes. Built once from data/*.json.
import fs from 'node:fs';
const lc = (s) => s.toLowerCase();
export function buildContext(stocks, known) {
  const usdg = lc(known.usdg);
  const tokens = new Map(); // address -> {symbol,name,decimals,issuer,pools}
  for (const o of stocks.official) tokens.set(lc(o.address), { address: lc(o.address), symbol: o.symbol, name: o.name, decimals: 18, issuer: 'robinhood', pools: o.pools.map((p) => ({ fee: p.fee, pool: lc(p.pool), usdg: p.usdg })) });
  tokens.set(usdg, { address: usdg, symbol: 'USDG', name: 'Global Dollar', decimals: 6, issuer: 'paxos', pools: [] });
  const freezable = [...tokens.keys()];
  const poolSet = new Set(); const poolInfo = new Map();
  for (const t of tokens.values()) for (const p of t.pools) { poolSet.add(p.pool); poolInfo.set(p.pool, { token: t.address, symbol: t.symbol, fee: p.fee }); }
  const lookalikes = new Map((stocks.lookalikes || []).map((l) => [lc(l.address), l]));
  // known contracts (routers etc.): every known.json value that is an address, except the token/registry entries which are handled apart
  const knownByAddr = new Map();
  const names = { uniswapV3Factory: 'Uniswap V3 factory', uniswapSwapRouter02: 'Uniswap router', uniswapQuoterV2: 'Uniswap quoter', uniswapV4PoolManager: 'Uniswap V4 pool manager', uniswapV4PositionManager: 'Uniswap V4 position manager', permit2: 'Permit2', ponsV2Factory: 'Pons factory', ponsRouter: 'Pons router', multicall3: 'Multicall3', stockRegistry: 'Robinhood access registry' };
  for (const [k, v] of Object.entries(known)) if (names[k] && /^0x[0-9a-fA-F]{40}$/.test(v)) knownByAddr.set(lc(v), names[k]);
  const routerSet = new Set([...knownByAddr.keys()].filter((a) => a !== lc(known.stockRegistry)));
  const tokenBySym = new Map([...tokens].map(([a, t]) => [a, t.symbol]));
  return { tokens, freezable, usdg, registry: lc(known.stockRegistry), poolSet, poolInfo, lookalikes, knownByAddr, routerSet, tokenBySym, multicall3: lc(known.multicall3) };
}
export function loadContext(dir = new URL('../../data/', import.meta.url)) {
  const rd = (f) => JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8'));
  return buildContext(rd('stocks-rc.json'), rd('known.json'));
}
