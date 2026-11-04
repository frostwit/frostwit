// Run on us1: read-only end-to-end test of the approval check against a real address with a live allowance.
import { Lane } from '../shared/rpc/lane.mjs'; import { Chain } from '../shared/rpc/chain.mjs'; import { loadContext } from '../shared/trace/tokens.mjs';
import { TOPIC_APPROVAL, addrFromTopic, decodeUint } from '../shared/abi.mjs'; import { checkAddress } from '../shared/trace/check.mjs';
const ctx = loadContext(), ch = new Chain(new Lane({ url: 'https://rpc.mainnet.chain.robinhood.com', log: console.log }));
const head = await ch.head();
const logs = await ch.getLogs({ address: ctx.usdg, topics: [TOPIC_APPROVAL], fromBlock: head - 12000, toBlock: head - 100 });
console.log('approval logs', logs.length);
const pick = logs.filter((l) => l.topics.length === 3 && decodeUint(l.data) > (1n << 200n)).slice(0, 8);
import { readAllowances } from '../shared/trace/check.mjs';
for (const l of pick) {
  const owner = addrFromTopic(l.topics[1]), spender = addrFromTopic(l.topics[2]);
  const rows = await readAllowances(ch, ctx, owner, [spender], [l.address.toLowerCase()]);
  console.log(owner, 'spender', spender, 'logged', decodeUint(l.data).toString(), '->', JSON.stringify(rows.map((s) => [s.symbol, s.via, s.allowance, s.unlimited, s.spenderLabel, s.revoke.to, s.revoke.data.slice(0, 10)])));
  if (rows.length) break;
}
console.log('calls', ch.lane.totalCalls);
