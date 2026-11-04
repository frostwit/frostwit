// Run ON us1 (official RPC reachable). Records a real trace through the lane and writes fixtures:
//   fixtures/case-example.json, fixtures/case-partial.json (graphs) + fixtures/replay-*.json (every RPC response, for offline tests)
// usage: node scripts/record.mjs <txhash> [outDir]
import fs from 'node:fs';
import { Lane } from '../shared/rpc/lane.mjs'; import { Chain } from '../shared/rpc/chain.mjs';
import { recordingChain } from '../shared/rpc/replay.mjs'; import { loadContext } from '../shared/trace/tokens.mjs'; import { trace } from '../shared/trace/engine.mjs';
const [hash, outDir = new URL('../fixtures/', import.meta.url).pathname] = process.argv.slice(2);
const ctx = loadContext(); const lane = new Lane({ url: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com', log: console.log });
for (const [name, limits] of [['case-example', {}], ['case-partial', { maxCalls: Number(process.env.PARTIAL_CALLS || 14) }]]) {
  const chain = new Chain(lane); const rc = recordingChain(chain);
  const t0 = Date.now();
  const g = await trace({ kind: 'tx', value: hash.toLowerCase() }, { chain: rc, ctx, limits });
  g._note = 'REAL trace recorded on us1 from the official RPC on ' + new Date().toISOString().slice(0, 10) + '. The seed is an ordinary transfer chain picked to exercise the engine, NOT a verified theft; never present it as one.';
  fs.writeFileSync(outDir + name + '.json', JSON.stringify(g, null, 1));
  fs.writeFileSync(outDir + 'replay-' + name + '.json', JSON.stringify({ input: { kind: 'tx', value: hash.toLowerCase() }, limits, rec: rc.rec }));
  console.log(name, g.status, 'calls', g.budget.rpcCalls, 'edges', g.edges.length, 'freezable', g.freezable.length, 'exits', g.exits.length, Date.now() - t0, 'ms');
}
