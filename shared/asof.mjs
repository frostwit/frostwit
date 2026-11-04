// shared/asof.mjs — pure "freezable as of block T" reconstruction (BRIEF §4.0.3).
// Owner: LANDING. Used by the scene's Freezable panel and by APP's no-3D as-of panel (same function).
//
// asOf(graph, block) → freezable rows as of `block`:
//   - block ≥ head (or omitted) ⇒ the live panel from §2.6 (graph.freezable, unchanged order)
//   - otherwise balances are reconstructed from the hops: received − sent per holder × token for edges with block ≤ T.
//     Status flags (blocked/frozen) are the CURRENT ones (the UI says so: AS_OF_NOTE).
//     USD = reconstructed amount × the token's current unit price (from graph.freezable or the edges), else null.
// Pools, routers and the victim are not holders here (the victim's pre-theft balance is unknown to the graph).

export const AS_OF_NOTE = 'Status flags (blocked/frozen) are current; balances are reconstructed from the hops.';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const lc = (a) => String(a ?? '').toLowerCase();
const nnum = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

function toRaw(e, dec) {
  if (e.amountRaw != null && /^-?\d+$/.test(String(e.amountRaw))) return BigInt(e.amountRaw);
  const a = nnum(e.amount);
  if (a == null) return 0n;
  const [i, f = ''] = a.toFixed(Math.min(dec, 12)).split('.');
  return BigInt(i + f.padEnd(dec, '0').slice(0, dec));
}
function fromRaw(raw, dec) {
  const neg = raw < 0n, r = neg ? -raw : raw, base = 10n ** BigInt(dec);
  const i = r / base, f = (r % base).toString().padStart(dec, '0').slice(0, 6).replace(/0+$/, '');
  return (neg ? -1 : 1) * Number(f ? `${i}.${f}` : `${i}`);
}

export function headOf(graph) {
  const bs = [Number(graph?.seed?.block), ...(graph?.edges || []).map((e) => Number(e.block)), ...(graph?.freezable || []).map((f) => Number(f.checkedBlock))].filter(Number.isFinite);
  return bs.length ? Math.max(...bs) : 0;
}

export function asOf(graph, block, opts = {}) {
  const g = graph || {};
  const live = Array.isArray(g.freezable) ? g.freezable : [];
  const head = opts.head ?? headOf(g);
  if (block == null || !Number.isFinite(Number(block)) || Number(block) >= head) return live.map((r) => ({ ...r, reconstructed: false }));
  const T = Number(block);

  const nodes = new Map((g.nodes || []).map((n) => [lc(n.address), n]));
  const skip = (a) => { const n = nodes.get(lc(a)); return !n || ['pool', 'router', 'victim'].includes(n.label); };
  if (g.seed?.victim) nodes.set(lc(g.seed.victim), { ...(nodes.get(lc(g.seed.victim)) || {}), address: g.seed.victim, label: 'victim' });

  // token meta: decimals, symbol, unit price (current)
  const meta = new Map();
  const tok = (t, sym) => {
    const k = lc(t);
    if (!meta.has(k)) meta.set(k, { token: t, symbol: sym, dec: k === USDG ? 6 : 18, price: k === USDG ? 1 : null });
    const m = meta.get(k); if (!m.symbol && sym) m.symbol = sym; return m;
  };
  for (const r of live) { const m = tok(r.token, r.symbol); const a = nnum(r.amount), u = nnum(r.usd); if (m.price == null && a && u != null) m.price = u / a; }
  for (const e of g.edges || []) { if (!e.token) continue; const m = tok(e.token, e.symbol); const a = nnum(e.amount), u = nnum(e.usd); if (m.price == null && a && u != null) m.price = u / a; }

  const bal = new Map(); // holder|token → raw
  for (const e of g.edges || []) {
    if (!e.token || Number(e.block) > T || e.kind === 'exit') continue;
    const m = tok(e.token, e.symbol), raw = toRaw(e, m.dec);
    const kTo = lc(e.to) + '|' + lc(e.token), kFrom = lc(e.from) + '|' + lc(e.token);
    bal.set(kTo, (bal.get(kTo) || 0n) + raw);
    bal.set(kFrom, (bal.get(kFrom) || 0n) - raw);
  }

  const rows = [];
  for (const [k, raw] of bal) {
    if (raw <= 0n) continue;
    const [holder, token] = k.split('|');
    if (skip(holder)) continue;
    const n = nodes.get(holder), m = meta.get(token);
    const amount = fromRaw(raw, m.dec);
    rows.push({
      holder: n?.address || holder, token: m.token, symbol: m.symbol, issuer: token === USDG ? 'paxos' : 'robinhood',
      amount, amountRaw: raw.toString(), usd: m.price == null ? null : Math.round(amount * m.price * 100) / 100,
      blocked: !!n?.blocked, frozen: !!n?.frozen, asOfBlock: T, reconstructed: true,
    });
  }
  return rows.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.amount - a.amount || a.holder.localeCompare(b.holder));
}

/** edges visible at scrub time T (t ≤ T) — used by the scene, the rail and the hop table filter */
export function edgesUpTo(edges, block) { return (edges || []).filter((e) => Number(e.block) <= Number(block)); }
