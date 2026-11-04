// Anonymises the recorded fixtures: every wallet/unknown-contract address and every tx hash becomes a deterministic fake
// (keccak("frostwit-fixture:"+addr)); token, pool, registry and router contracts stay real. Receivers become first_receiver.
// usage: node scripts/anonymise-fixtures.mjs   (idempotent only on raw recordings; run once on fresh fixtures)
import fs from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { loadContext } from '../shared/trace/tokens.mjs';
import { publicGraph } from '../shared/trace/public.mjs';

const dir = new URL('../fixtures/', import.meta.url), ctx = loadContext();
const hx = (s) => Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex');
const keep = new Set([...ctx.tokens.keys(), ...ctx.poolSet, ...ctx.routerSet, ...ctx.lookalikes.keys(), ctx.registry, ctx.usdg, ctx.multicall3, '0x0000000000000000000000000000000000000000']);
const files = ['case-example', 'case-partial'];
const addrs = new Set(), txs = new Set();
const scan = (txt) => {
  for (const m of txt.matchAll(/0x([0-9a-f]{64})(?![0-9a-f])/g)) { const w = m[1]; if (/^0{24}/.test(w)) { if (!/^0{8}/.test(w.slice(24))) addrs.add('0x' + w.slice(24)); } else txs.add(m[0]); }
  for (const m of txt.matchAll(/0x([0-9a-f]{40})(?![0-9a-f])/g)) if (!/^0{8}/.test(m[1])) addrs.add(m[0]);
};
const texts = {}; for (const f of files) for (const pre of ['', 'replay-']) { const n = pre + f; texts[n] = fs.readFileSync(new URL(n + '.json', dir), 'utf8'); }
// drop calldata of transactions (the engine reads only from/to/value/blockNumber): it can embed other addresses
for (const n of Object.keys(texts)) if (n.startsWith('replay-')) { const j = JSON.parse(texts[n]); for (const [k, v] of Object.entries(j.rec)) if (k.startsWith('tx:') && v) v.input = '0x'; texts[n] = JSON.stringify(j); }
for (const t of Object.values(texts)) scan(t);
// block / state hashes are not ours to map: only hashes that are tx hashes (appear as transactionHash/hash of a tx, graph tx fields, or request args)
const txSet = new Set();
for (const t of Object.values(texts)) for (const m of t.matchAll(/"(?:transactionHash|tx|value|hash)":\s*"(0x[0-9a-f]{64})"/g)) txSet.add(m[1]);
for (const t of Object.values(texts)) for (const m of t.matchAll(/(?:tx|receipt):\["(0x[0-9a-f]{64})"\]/g)) txSet.add(m[1]);
const map = new Map();
for (const a of addrs) if (!keep.has(a)) map.set(a, '0x' + hx('frostwit-fixture:' + a).slice(0, 40));
for (const h of txSet) map.set(h, '0x' + hx('frostwit-fixture-tx:' + h));
const re = new RegExp([...map.keys()].map((k) => k.slice(2)).join('|'), 'g');
for (const [n, t] of Object.entries(texts)) {
  let out = t.replace(re, (m) => map.get('0x' + m).slice(2));
  if (!n.startsWith('replay-')) {
    const g = JSON.parse(out); g._note = 'REAL trace recorded from Robinhood Chain on 2026-11-04, then anonymised: wallet addresses and tx hashes are deterministic fakes; token, pool, registry and router contracts are real. The seed is an ordinary transfer chain, NOT a theft.';
    out = JSON.stringify(publicGraph('tx', g), null, 1);
  }
  fs.writeFileSync(new URL(n + '.json', dir), out);
}
console.log('mapped', map.size, 'addresses/hashes; kept real contracts:', keep.size);
