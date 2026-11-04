// shared/layout.mjs — pure, deterministic layout for the Frostwit scene (browser) and posters (server).
// Owner: LANDING. No imports, no I/O, no Math.random: same input ⇒ same output in Node and the browser.
//
// Space: x ∈ [0, 1] (time axis, left → right), y, z ∈ ≈[-1, 1]. The scene scales this to world units;
// the poster projects (x, y) to 2D.
//
// `t` is the true normalised block time (seed = 0, head = 1) and drives the scrubber.
// `x` is a display position that is monotonic in block time: half linear time, half arrival rank.
// Pure linear time would stack a 72-minute block/unblock pair on top of the live crystal
// (2.6 M blocks of history vs 42 k blocks between the pair), so ranks keep every event readable
// while the left-to-right order is always the order on-chain.

export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const RANK_W = 0.5;
const EXIT_KINDS = new Set(['eth', 'other-token', 'lookalike', 'contract', 'depth', 'fanout', 'dust', 'horizon']);

/** FNV-1a 32-bit → [0, 1) */
export function hash01(s) {
  let h = 0x811c9dc5;
  const str = String(s ?? '').toLowerCase();
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  // murmur3 finaliser: FNV alone correlates strings that differ only in the last character
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round = (v) => Math.round(v * 1e6) / 1e6;
const lc = (a) => String(a ?? '').toLowerCase();
const num = (v) => { const n = typeof v === 'string' ? Number(v) : v; return Number.isFinite(n) ? n : null; };

/** crystal size from USD: log10(1 + usd) clamped 0.4–1.6 (BRIEF §4.0.2) */
export function sizeFromUsd(usd) {
  const u = num(usd);
  if (u == null || u <= 0) return 0.4;
  return round(clamp(Math.log10(1 + u) / 4, 0.4, 1.6)); // 10 USD → .4, 10 k → 1, 1 M → 1.5
}
/** crystal size from a count (cluster / live crystal) */
export function sizeFromCount(n) {
  const c = num(n);
  if (c == null || c <= 1) return 0.5;
  return round(clamp(0.4 + Math.log10(1 + c) * 0.42, 0.4, 1.6)); // 247 → ≈ 1.4
}

/** monotonic display positions for a sorted list of unique blocks */
function xMapper(blocks, lo, hi, rankW = RANK_W) {
  const uniq = [...new Set(blocks)].sort((a, b) => a - b);
  const span = Math.max(1, hi - lo);
  const rank = new Map(uniq.map((b, i) => [b, uniq.length > 1 ? i / (uniq.length - 1) : 0.5]));
  const tOf = (b) => clamp((b - lo) / span, 0, 1);
  return {
    t: (b) => round(tOf(b)),
    x: (b) => {
      if (rank.has(b)) return round((1 - rankW) * tOf(b) + rankW * rank.get(b));
      // block between known ranks: interpolate rank
      let i = 0; while (i < uniq.length && uniq[i] < b) i++;
      const r = uniq.length < 2 ? 0.5 : i === 0 ? 0 : i >= uniq.length ? 1
        : ((i - 1) + (b - uniq[i - 1]) / Math.max(1, uniq[i] - uniq[i - 1])) / (uniq.length - 1);
      return round((1 - rankW) * tOf(b) + rankW * r);
    },
  };
}

/** ring position seeded by the address hash; radius grows with depth */
function ring(address, depth, salt = '') {
  const a = hash01(address + salt) * Math.PI * 2;
  const r = depth === 0 ? 0.08 + hash01(address + 'r') * 0.06 : 0.22 + 0.16 * Math.min(depth, 4) + hash01(address + 'r') * 0.08;
  return { y: round(Math.sin(a) * r), z: round(Math.cos(a) * r * 0.8) };
}

/**
 * layoutGraph(graph, {head?}) → {nodes, edges, ticks, seedBlock, head}
 * nodes: [{address, label, x, y, z, t, depth, state, size, usd, firstBlock, code, blocked, frozen}]
 *   state ∈ blocked | frozen | freezable | pool | router | contract | victim | plain | exit-eth | exit-other | exit-stop
 * edges: [{from, to, token, symbol, amount, usd, tx, block, time, kind, t}] sorted by block
 * ticks: [{block, t, x, edges:[indices]}] — one per distinct hop block (the scrubber's stops)
 */
export function layoutGraph(graph, opts = {}) {
  const g = graph || {};
  const nodesIn = Array.isArray(g.nodes) ? g.nodes : [];
  const edgesIn = (Array.isArray(g.edges) ? g.edges : []).filter((e) => e && e.from && e.to);
  const exitsIn = Array.isArray(g.exits) ? g.exits : [];
  const freezable = Array.isArray(g.freezable) ? g.freezable : [];

  const blocksAll = edgesIn.map((e) => Number(e.block)).filter(Number.isFinite);
  const seedBlock = Number.isFinite(Number(g.seed?.block)) ? Number(g.seed.block) : (blocksAll.length ? Math.min(...blocksAll) : 0);
  const checked = freezable.map((f) => Number(f.checkedBlock)).filter(Number.isFinite);
  const head = Number.isFinite(Number(opts.head)) ? Number(opts.head) : Math.max(seedBlock + 1, ...blocksAll, ...checked);
  const xm = xMapper([seedBlock, ...blocksAll, head], seedBlock, head);

  // node index (graph.nodes first, then any address only seen on an edge)
  const byAddr = new Map();
  const add = (address, extra = {}) => {
    const k = lc(address);
    if (!k) return null;
    if (!byAddr.has(k)) byAddr.set(k, { address, label: 'receiver', code: false, blocked: false, frozen: false, ...extra });
    return byAddr.get(k);
  };
  for (const n of nodesIn) add(n.address, { ...n });
  for (const e of edgesIn) { add(e.from); add(e.to); }

  // depth: BFS from victim(s) / thieves
  const out = new Map();
  for (const e of edgesIn) { const k = lc(e.from); if (!out.has(k)) out.set(k, []); out.get(k).push(lc(e.to)); }
  const depth = new Map();
  const roots = [];
  if (g.seed?.victim) roots.push(lc(g.seed.victim));
  for (const n of byAddr.values()) if (n.label === 'victim') roots.push(lc(n.address));
  if (!roots.length) for (const t of g.seed?.thieves || g.seed?.firstReceivers || []) roots.push(lc(t));
  if (!roots.length && edgesIn.length) roots.push(lc([...edgesIn].sort((a, b) => a.block - b.block)[0].from));
  const q = [...new Set(roots)].filter((r) => byAddr.has(r));
  for (const r of q) depth.set(r, 0);
  while (q.length) {
    const k = q.shift();
    for (const nx of out.get(k) || []) if (!depth.has(nx)) { depth.set(nx, depth.get(k) + 1); q.push(nx); }
  }

  // first arrival + value per node
  const firstIn = new Map(), inUsd = new Map();
  for (const e of edgesIn) {
    const k = lc(e.to), b = Number(e.block);
    if (!firstIn.has(k) || b < firstIn.get(k)) firstIn.set(k, b);
    inUsd.set(k, (inUsd.get(k) || 0) + (num(e.usd) || 0));
  }
  const holdUsd = new Map();
  for (const f of freezable) holdUsd.set(lc(f.holder), (holdUsd.get(lc(f.holder)) || 0) + (num(f.usd) || 0));
  const holds = new Set(freezable.filter((f) => Number(f.amount) > 0 || BigInt(f.amountRaw ?? 0) > 0n).map((f) => lc(f.holder)));

  const nodes = [];
  for (const [k, n] of byAddr) {
    const d = depth.has(k) ? depth.get(k) : 1;
    const fb = firstIn.has(k) ? firstIn.get(k) : seedBlock;
    const { y, z } = ring(k, d);
    let state = 'plain';
    if (n.label === 'victim') state = 'victim';
    else if (n.label === 'pool') state = 'pool';
    else if (n.label === 'router') state = 'router';
    else if (n.blocked) state = 'blocked';
    else if (n.frozen) state = 'frozen';
    else if (holds.has(k)) state = 'freezable';
    else if (n.label === 'contract' || n.code) state = 'contract';
    const low = state === 'pool' || state === 'router';
    const usd = holdUsd.get(k) || inUsd.get(k) || 0;
    nodes.push({
      id: k, address: n.address, label: n.label, ...(n.role ? { role: n.role } : {}), code: !!n.code, blocked: !!n.blocked, frozen: !!n.frozen,
      x: xm.x(fb), y: low ? round(-Math.abs(y) - 0.35) : y, z, t: xm.t(fb), depth: d, firstBlock: fb,
      state, usd: round(usd), size: state === 'victim' ? 0.5 : low ? 0.45 : sizeFromUsd(holdUsd.get(k) || inUsd.get(k)),
    });
  }

  // exits: one faded crystal per exit, pushed to z = +1 next to its source
  const pos = new Map(nodes.map((n) => [lc(n.address), n]));
  exitsIn.forEach((x, i) => {
    if (!EXIT_KINDS.has(x?.kind)) return;
    const src = pos.get(lc(x.from));
    const b = Number(x.block ?? (edgesIn.find((e) => e.tx === x.tx)?.block)) || src?.firstBlock || seedBlock;
    const id = `exit:${i}`;
    const state = x.kind === 'eth' ? 'exit-eth' : (x.kind === 'other-token' || x.kind === 'lookalike') ? 'exit-other' : 'exit-stop';
    nodes.push({
      id, address: id, label: 'exit', exit: x.kind, note: x.note || '', tx: x.tx || null, from: x.from || null, code: false, blocked: false, frozen: false,
      x: round(Math.min(1, Math.max(xm.x(b), src ? src.x + 0.04 : 0))), y: round((src?.y ?? 0) + (hash01(id) - 0.5) * 0.3), z: 1,
      t: xm.t(b), depth: (src?.depth ?? 0) + 1, firstBlock: b, state, usd: round(num(x.usd) || 0), size: 0.45,
    });
  });

  const edges = edgesIn.map((e) => ({
    from: lc(e.from), to: lc(e.to), token: e.token, symbol: e.symbol, amount: e.amount, amountRaw: e.amountRaw, usd: e.usd ?? null,
    tx: e.tx, block: Number(e.block), time: e.time, kind: e.kind || 'transfer', t: xm.t(Number(e.block)),
  })).sort((a, b) => a.block - b.block || String(a.tx).localeCompare(String(b.tx)));
  for (const n of nodes) if (n.label === 'exit' && n.from) edges.push({ from: lc(n.from), to: n.id, kind: 'exit', tx: n.tx, block: n.firstBlock, t: n.t, symbol: n.exit });
  edges.sort((a, b) => a.block - b.block || (a.kind === 'exit') - (b.kind === 'exit'));

  return { nodes, edges, ticks: ticksOf(edges, xm), seedBlock, head };
}

function ticksOf(edges, xm) {
  const m = new Map();
  edges.forEach((e, i) => { if (!m.has(e.block)) m.set(e.block, []); m.get(e.block).push(i); });
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([block, idx]) => ({ block, t: xm.t(block), x: xm.x(block), edges: idx }));
}

/**
 * layoutTimeline(events, head, {blockedNow?, clusterGap?}) → {nodes, edges, ticks, seedBlock, head}
 * events: issuer_events rows [{block, tx, logIndex, kind:'blocked'|'unblocked', address, operator, time}]
 * - the first batch (events within `clusterGap` blocks of the earliest, ≥ 10 of them) becomes ONE cluster crystal
 * - every later event is its own crystal (state blocked | unblocked)
 * - a Blocked → Unblocked of the same address is joined by a 'pair' string with its duration
 * - a 'live' crystal at x = 1 sized by blockedNow
 */
export function layoutTimeline(events, head, opts = {}) {
  const ev = (Array.isArray(events) ? events : []).filter((e) => e && Number.isFinite(Number(e.block)))
    .map((e) => ({ ...e, block: Number(e.block), kind: lc(e.kind) }))
    .sort((a, b) => a.block - b.block || (a.logIndex ?? a.log_index ?? 0) - (b.logIndex ?? b.log_index ?? 0));
  const H = Number.isFinite(Number(head)) ? Number(head) : (ev.length ? ev[ev.length - 1].block + 1 : 1);
  const gap = opts.clusterGap ?? 2000; // max blocks between consecutive Blocked events of the first batch
  // opts.batch = server summary of the pre-public batch {fromBlock, toBlock, count, txs?, tx?} (when the feed is paged)
  const B = opts.batch && Number(opts.batch.count) > 0 ? opts.batch : null;
  const inBatch = [];
  if (!B) for (const e of ev) { if (e.kind !== 'blocked' || (inBatch.length && e.block - inBatch[inBatch.length - 1].block > gap)) break; inBatch.push(e); }
  const cluster = inBatch.length >= 10 ? inBatch : [];
  const rest = B ? ev.filter((e) => e.block > Number(B.toBlock)) : cluster.length ? ev.slice(cluster.length) : ev;

  // blockedNow: caller's figure wins (server state), else derived from the last event per address
  let blockedNow = num(opts.blockedNow);
  if (blockedNow == null) {
    const last = new Map();
    for (const e of ev) last.set(lc(e.address), e.kind);
    blockedNow = [...last.values()].filter((k) => k === 'blocked').length;
  }

  const xm = xMapper([...(cluster.length ? [cluster[cluster.length - 1].block] : B ? [Number(B.toBlock)] : [0]), ...rest.map((e) => e.block), H], 0, H, opts.rankWeight ?? 0.8);
  const nodes = [], edges = [];
  if (B) {
    const b = Number(B.toBlock);
    nodes.push({
      address: 'cluster:' + B.fromBlock, id: 'cluster', label: 'cluster', state: 'cluster', count: Number(B.count), blockedCount: Number(B.blocked ?? B.count), addresses: Number(B.addresses ?? B.count),
      fromBlock: Number(B.fromBlock), toBlock: b, firstBlock: b, time: B.time ?? null, tx: B.tx ?? (Array.isArray(B.txs) ? B.txs[0] : null),
      txs: Array.isArray(B.txs) ? B.txs.length : Number(B.txs) || null,
      x: xm.x(b), y: 0.05, z: 0, t: xm.t(b), size: sizeFromCount(Number(B.count)),
    });
  }
  if (cluster.length) {
    const b = cluster[cluster.length - 1].block;
    const nb = cluster.filter((e) => e.kind === 'blocked').length;
    nodes.push({
      address: 'cluster:' + cluster[0].block, id: 'cluster', label: 'cluster', state: 'cluster', count: cluster.length, blockedCount: nb,
      addresses: new Set(cluster.map((e) => lc(e.address))).size,
      fromBlock: cluster[0].block, toBlock: b, firstBlock: b, time: cluster[cluster.length - 1].time ?? null, tx: cluster[0].tx,
      txs: [...new Set(cluster.map((e) => e.tx))].length,
      x: xm.x(b), y: 0.05, z: 0, t: xm.t(b), size: sizeFromCount(cluster.length),
    });
  }
  const openBlock = new Map(); // address → node index of its last Blocked crystal
  rest.forEach((e, i) => {
    const k = lc(e.address);
    const a = hash01(k + e.tx) * Math.PI * 2;
    const r = 0.3 + hash01(k + 'r') * 0.25;
    const n = {
      address: e.address, id: `ev:${e.tx}:${e.logIndex ?? e.log_index ?? i}`, label: 'event', state: e.kind === 'unblocked' ? 'unblocked' : 'blocked',
      kind: e.kind, tx: e.tx, operator: e.operator ?? null, time: e.time ?? null, block: e.block, firstBlock: e.block,
      x: xm.x(e.block), y: round(Math.sin(a) * r * 0.8), z: round(Math.cos(a) * r * 1.2), t: xm.t(e.block), size: 0.62,
    };
    if (e.kind === 'unblocked' && openBlock.has(k)) {
      const p = nodes[openBlock.get(k)];
      // keep the pair visually adjacent: same side of the spine, unblocked slightly lower
      n.y = round(p.y - 0.42 * Math.sign(p.y || 1)); n.z = round(p.z + 0.35);
      edges.push({
        from: p.id, to: n.id, kind: 'pair', address: e.address, fromBlock: p.block, block: e.block, t: n.t,
        tx: e.tx, blockTx: p.tx, durationSec: (Number.isFinite(Number(e.time)) && Number.isFinite(Number(p.time))) ? Number(e.time) - Number(p.time) : null,
      });
      openBlock.delete(k);
    }
    nodes.push(n);
    if (n.state === 'blocked') openBlock.set(k, nodes.length - 1);
  });
  nodes.push({
    address: 'live', id: 'live', label: 'live', state: 'live', count: blockedNow, block: H, firstBlock: H,
    x: 1, y: 0.02, z: 0, t: 1, size: sizeFromCount(blockedNow),
  });

  // time spine: faint axis string through the crystals in block order (an axis, not data)
  for (let i = 1; i < nodes.length; i++) edges.push({ from: nodes[i - 1].id, to: nodes[i].id, kind: 'spine', block: nodes[i].firstBlock, t: nodes[i].t });
  edges.sort((a, b) => a.block - b.block || (a.kind === 'spine') - (b.kind === 'spine'));
  const ticks = nodes.map((n) => ({ block: n.firstBlock, t: n.t, x: n.x, node: n.id }));
  return { nodes, edges, ticks, seedBlock: ev.length ? ev[0].block : B ? Number(B.fromBlock) : 0, head: H, blockedNow };
}

/**
 * project2d(node, {w, h, frame?}) → {x, y, r} — the poster's 2D projection (x = time, y = spread, z adds a little lift).
 * Shared by the server poster template and the no-3D pins over that poster, so both line up exactly.
 * frame: fractions of the image {l, r, t, b} that hold the graph (default: a centred 8 % margin).
 */
export function project2d(node, { w, h, frame } = {}) {
  const f = { l: 0.08, r: 0.92, t: 0.12, b: 0.88, ...(frame || {}) };
  const L = f.l * w, R = f.r * w, T = f.t * h, B = f.b * h;
  const cy = (T + B) / 2, half = (B - T) / 2;
  const x = L + clamp(node.x, 0, 1) * (R - L);
  const y = cy - clamp((node.y ?? 0) + (node.z ?? 0) * 0.15, -1.2, 1.2) * half * 0.78;
  const r = Math.max(6, (node.size ?? 0.5) * Math.min(w, h) * 0.05);
  return { x: round(x), y: round(y), r: round(r) };
}
/**
 * Scene geometry shared by the WebGL scene (web/src/scene/gl.mjs), the server poster and the no-3D pins,
 * so the poster is a faithful first frame of the 3D scene and the crossfade between them does not jump.
 */
export const SCENE = { fov: 30, home: [0, 0.16, 1], rotY: -0.12 };
export function sceneWorld(nd, mode, nodeCount = 0) {
  if (mode === 'timeline') {
    // the past recedes up-left into the fog, "now" comes forward and down towards the viewer
    const SX = 8, SY = 3.2, SZ = 3;
    return [(nd.x - 0.5) * SX, (nd.y ?? 0) * SY * 0.7 + (0.5 - nd.x) * 1.4, (nd.z ?? 0) * SZ * 0.7 + (nd.x - 0.5) * 4.2];
  }
  const SX = Math.min(15, Math.max(7, 3 + nodeCount * 0.55));
  return [(nd.x - 0.5) * SX, (nd.y ?? 0) * 3.4, (nd.z ?? 0) * 3.2];
}
/** bounding radius of a crystal in world units (crystals are a little taller than this) */
export const sceneRadius = (nd, mode) => 0.34 * (nd.size ?? 0.5) * (mode === 'timeline' ? 1.9 : 1.2) * 1.15;

/**
 * sceneProject(layout, {mode, w, h, region}) → Map(id → {x, y, r, depth}) in pixels of a w×h frame.
 * Perspective camera from SCENE.home looking at the centre, then the projected set (with radii) is fitted
 * into `region` (fractions {l, r, t, b}) — the same fit the WebGL camera does on first frame.
 */
export function sceneProject(L, { mode, w, h, region } = {}) {
  const reg = { l: 0.06, r: 0.94, t: 0.12, b: 0.88, ...(region || {}) };
  const n = L.nodes.length;
  const cy = Math.cos(SCENE.rotY), sy = Math.sin(SCENE.rotY);
  const pts = L.nodes.map((nd) => {
    const [x0, y0, z0] = sceneWorld(nd, mode, n);
    return { id: nd.id, x: x0 * cy + z0 * sy, y: y0, z: -x0 * sy + z0 * cy, r: sceneRadius(nd, mode) };
  });
  if (!pts.length) return new Map();
  const c = pts.reduce((a, p) => [a[0] + p.x / pts.length, a[1] + p.y / pts.length, a[2] + p.z / pts.length], [0, 0, 0]);
  const minMax = (k) => [Math.min(...pts.map((p) => p[k])), Math.max(...pts.map((p) => p[k]))];
  const [xa, xb] = minMax('x'), [ya, yb] = minMax('y'), [za, zb] = minMax('z');
  const ctr = [(xa + xb) / 2, (ya + yb) / 2, (za + zb) / 2];
  void c;
  const hl = Math.hypot(...SCENE.home), dir = SCENE.home.map((v) => v / hl);
  const D = 40; // any distance: the fit below rescales
  const cam = ctr.map((v, i) => v + dir[i] * D);
  // camera basis (looking at ctr, up = +y)
  const fwd = dir.map((v) => -v);
  const right = [fwd[2] * 0 - fwd[1] * 0, 0, 0]; // placeholder, computed below
  const up0 = [0, 1, 0];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
  const R = norm(cross(fwd, up0)); right[0] = R[0]; right[1] = R[1]; right[2] = R[2];
  const U = cross(R, fwd);
  const f = 1 / Math.tan((SCENE.fov / 2) * Math.PI / 180);
  const proj = pts.map((p) => {
    const d = [p.x - cam[0], p.y - cam[1], p.z - cam[2]];
    const zc = d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2];
    return { id: p.id, u: (d[0] * R[0] + d[1] * R[1] + d[2] * R[2]) * f / zc, v: (d[0] * U[0] + d[1] * U[1] + d[2] * U[2]) * f / zc, rr: p.r * f / zc, depth: zc };
  });
  const ua = Math.min(...proj.map((p) => p.u - p.rr)), ub = Math.max(...proj.map((p) => p.u + p.rr));
  const va = Math.min(...proj.map((p) => p.v - p.rr)), vb = Math.max(...proj.map((p) => p.v + p.rr));
  const RW = (reg.r - reg.l) * w, RH = (reg.b - reg.t) * h;
  const s = Math.min(RW / Math.max(1e-6, ub - ua), RH / Math.max(1e-6, vb - va));
  const ox = reg.l * w + (RW - (ub - ua) * s) / 2, oy = reg.t * h + (RH - (vb - va) * s) / 2;
  return new Map(proj.map((p) => [p.id, { x: round(ox + (p.u - ua) * s), y: round(oy + (vb - p.v) * s), r: round(p.rr * s), depth: round(p.depth) }]));
}

/** poster frames: the landing hero poster is the desktop first frame (1440×900, same region as the landing scene) */
export const POSTER = {
  timeline: { w: 1440, h: 900, region: { l: 0.42, r: 0.925, t: 0.31, b: 0.855 }, frame: { l: 0.42, r: 0.925, t: 0.31, b: 0.855 } },
  case: { w: 1600, h: 900, region: { l: 0.06, r: 0.94, t: 0.1, b: 0.9 }, frame: { l: 0.08, r: 0.92, t: 0.12, b: 0.88 } },
};
