// Record / replay chain responses so engine tests run on REAL data without touching the RPC.
const k = (m, args) => m + ':' + JSON.stringify(args, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
export function recordingChain(chain) {
  const rec = {};
  const wrap = (m) => async (...args) => { const a = args.filter((x) => !(x && typeof x === 'object' && 'prio' in x && Object.keys(x).length <= 2 && !Array.isArray(x))); const r = await chain[m](...args); rec[k(m, a)] = r === undefined ? null : r; return r; };
  const out = { rec };
  for (const m of ['head', 'getLogs', 'tx', 'receipt', 'block', 'code', 'call', 'multicall']) out[m] = wrap(m);
  return out;
}
export function replayChain(rec) {
  const out = { calls: 0, missing: [] };
  for (const m of ['head', 'getLogs', 'tx', 'receipt', 'block', 'code', 'call', 'multicall']) {
    out[m] = async (...args) => {
      const a = args.filter((x) => !(x && typeof x === 'object' && 'prio' in x && Object.keys(x).length <= 2 && !Array.isArray(x)));
      out.calls++; const key = k(m, a);
      if (!(key in rec)) { out.missing.push(key); throw new Error('replay: missing ' + key.slice(0, 120)); }
      return rec[key];
    };
  }
  return out;
}
