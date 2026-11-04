// Day-1 probe, run ON us1 through the lane. Prints facts for BUILD-LOG.
import fs from 'node:fs';
import { Lane, PRIO } from '../shared/rpc/lane.mjs';
import { Chain } from '../shared/rpc/chain.mjs';
import { TOPIC_TRANSFER, TOPIC_BLOCKED, TOPIC_UNBLOCKED, SEL, call1, encodeBalanceOf } from '../shared/abi.mjs';
const lane = new Lane({ url: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com', log: console.log });
const ch = new Chain(lane);
const stocks = JSON.parse(fs.readFileSync(new URL('../data/stocks-rc.json', import.meta.url)));
const known = JSON.parse(fs.readFileSync(new URL('../data/known.json', import.meta.url)));
const tokens = [...stocks.official.map((o) => o.address), known.usdg];
const head = await ch.head(); console.log('head', head);
const blk = await ch.block(head - 10); console.log('block ts', parseInt(blk.timestamp, 16), 'keys', Object.keys(blk).join(','));
const blk2 = await ch.block(head - 1000010); const dt = parseInt(blk.timestamp, 16) - parseInt(blk2.timestamp, 16); console.log('blocks/s over 1M:', (1e6 / dt).toFixed(2));
const t0 = Date.now();
const logs = await ch.getLogs({ address: tokens, topics: [TOPIC_TRANSFER], fromBlock: head - 5000, toBlock: head - 100 });
console.log('5k-block array window', logs.length, 'logs', Date.now() - t0, 'ms; sample keys', logs[0] && Object.keys(logs[0]).join(','));
console.log('sample', JSON.stringify(logs[0]));
// balanceOf vs balanceOfUI vs uiMultiplier on 3 tokens, for a holder with a balance
const holders = [...new Set(logs.map((l) => '0x' + l.topics[2].slice(26)))].slice(0, 3);
for (const sym of ['NVDA', 'AAPL', 'TSLA']) {
  const t = stocks.official.find((o) => o.symbol === sym); if (!t) continue;
  const calls = []; for (const h of holders) { calls.push({ target: t.address, callData: encodeBalanceOf(h) }, { target: t.address, callData: call1(SEL.balanceOfUI, h) }); }
  calls.push({ target: t.address, callData: SEL.uiMultiplier }, { target: t.address, callData: SEL.paused });
  const r = await ch.multicall(calls);
  console.log(sym, JSON.stringify(r.map((x) => x.success + ':' + x.returnData.slice(0, 66))));
}
const rg = await ch.multicall([{ target: known.stockRegistry, callData: call1(SEL.isBlocked, '0xb397711c21f1a117c3c48c4443b178089bffaf94') }, { target: known.usdg, callData: call1(SEL.isFrozen, '0xb397711c21f1a117c3c48c4443b178089bffaf94') }]);
console.log('isBlocked/isFrozen(3Nov addr)', JSON.stringify(rg));
console.log('lane', JSON.stringify(lane.state()));
