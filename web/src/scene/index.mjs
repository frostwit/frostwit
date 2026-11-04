// web/src/scene/index.mjs — mountScene (BRIEF §9.1 contract). Owner: LANDING.
// No three.js here: this file is safe in the first-paint bundle. It always renders the time rail, the pins,
// the lens callout and the poster; it loads /dist/scene-gl.js only when the §4.0.2 load rule passes.
//
// mountScene(el, {kind:'graph', graph} | {kind:'timeline', events, head, blockedNow, headTime?},
//            {poster, interactive=true, pan=false, onContinue(address), onScrub(block, rows), railEl, focus, mobileFocus})
//   → { update(data), scrubTo(block), destroy(), get block(), get mode() }
import { layoutGraph, layoutTimeline, sceneProject, POSTER } from '../../../shared/layout.mjs';
import { asOf, AS_OF_NOTE } from '../../../shared/asof.mjs';

const GL_URL = '/dist/scene-gl.js';
const BLOCKSCOUT = 'https://robinhoodchain.blockscout.com';
const BPS = 9.7; // blocks per second (BRIEF §0)
const STEP_MS = 700;

// ---------- small helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const short = (a) => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '');
const fmtBlock = (b) => (Number.isFinite(b) ? Math.round(b).toLocaleString('en-US').replace(/,/g, ' ') : '—');
const fmtNum = (v, max = 6) => { const n = Number(v); if (!Number.isFinite(n)) return '—'; return n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 2 : max }); };
const fmtUsd = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : '≈ $' + Number(v).toLocaleString('en-US', { maximumFractionDigits: Number(v) >= 100 ? 0 : 2 }));
const pad = (n) => String(n).padStart(2, '0');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtTime(sec, withDate = true) {
  if (!Number.isFinite(sec)) return '';
  const d = new Date(sec * 1000);
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
  return withDate ? `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${hm}` : hm;
}
const fmtDur = (s) => (!Number.isFinite(s) ? '' : s < 5400 ? `${Math.round(s / 60)} min` : s < 172800 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 86400)} days`);
const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

// ---------- load rule (§4.0.2) ----------
export function canUse3D() {
  try {
    if (typeof window === 'undefined') return false;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    if (navigator.connection?.saveData) return false;
    const mem = navigator.deviceMemory;
    const desktop = matchMedia('(pointer: fine)').matches;
    if (!(desktop || (mem != null && mem >= 4) || mem == null && !/Android/i.test(navigator.userAgent))) return false;
    if (/[?&]no3d\b/.test(location.search)) return false;
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch { return false; }
}
// After `load`: the first user interaction (pointer, touch, wheel, key, scroll) or, failing that, an idle slot
// ~3.5 s later. Keeps three.js off the first paint and off the main thread while the poster (LCP) renders.
function whenIdle(fn, delay = 3500) {
  let done = false, loaded = document.readyState === 'complete', wanted = false;
  const EV = ['pointermove', 'pointerdown', 'touchstart', 'wheel', 'keydown', 'scroll'];
  const fire = () => { if (done) return; done = true; for (const e of EV) removeEventListener(e, onUser, true); fn(); };
  const onUser = () => { wanted = true; if (loaded) fire(); };
  for (const e of EV) addEventListener(e, onUser, { passive: true, capture: true });
  const afterLoad = () => {
    loaded = true;
    if (wanted) { fire(); return; }
    setTimeout(() => (window.requestIdleCallback ? requestIdleCallback(fire, { timeout: 2000 }) : fire()), delay);
  };
  if (loaded) afterLoad(); else addEventListener('load', afterLoad, { once: true });
}

// ---------- time model: block ↔ rail position ↔ wall time ----------
function timeModel(L, data) {
  const stops = [{ p: 0, block: L.seedBlock }];
  for (const tk of L.ticks) stops.push({ p: tk.x, block: tk.block });
  stops.push({ p: 1, block: L.head });
  stops.sort((a, b) => a.p - b.p || a.block - b.block);
  // known wall times
  const known = [];
  if (data.kind === 'timeline') for (const e of data.events || []) if (Number.isFinite(Number(e.time))) known.push([Number(e.block), Number(e.time)]);
  if (data.kind === 'graph') for (const e of data.graph?.edges || []) if (Number.isFinite(Number(e.time))) known.push([Number(e.block), Number(e.time)]);
  if (Number.isFinite(data.headTime)) known.push([L.head, data.headTime]);
  known.sort((a, b) => a[0] - b[0]);
  const timeOf = (b) => {
    if (!known.length) return NaN;
    let lo = null, hi = null;
    for (const k of known) { if (k[0] <= b) lo = k; if (k[0] >= b && !hi) hi = k; }
    if (lo && hi && hi[0] !== lo[0]) return lo[1] + (hi[1] - lo[1]) * (b - lo[0]) / (hi[0] - lo[0]);
    const a = lo || hi; return a[1] + (b - a[0]) / BPS;
  };
  const blockAt = (p) => {
    if (p <= 0) return stops[0].block; if (p >= 1) return L.head;
    for (let i = 1; i < stops.length; i++) if (stops[i].p >= p) { const a = stops[i - 1], b = stops[i]; return b.p === a.p ? b.block : Math.round(a.block + (b.block - a.block) * (p - a.p) / (b.p - a.p)); }
    return L.head;
  };
  const posOf = (block) => {
    if (block >= L.head) return 1; if (block <= stops[0].block) return 0;
    for (let i = 1; i < stops.length; i++) if (stops[i].block >= block) { const a = stops[i - 1], b = stops[i]; return b.block === a.block ? b.p : a.p + (b.p - a.p) * (block - a.block) / (b.block - a.block); }
    return 1;
  };
  return { timeOf, blockAt, posOf, stops };
}

// ---------- callout content ----------
function linkBs(kind, v, label) { return `<a href="${BLOCKSCOUT}/${kind}/${esc(v)}" target="_blank" rel="noopener">${esc(label || 'Blockscout')}</a>`; }

function describeTimeline(n, L, tm) {
  const when = (b) => { const t = tm.timeOf(b); return Number.isFinite(t) ? fmtTime(t) : `block ${fmtBlock(b)}`; };
  if (n.state === 'cluster') {
    return {
      stamp: ['cobalt', 'Blocked'], title: `${n.addresses ?? n.count} addresses blocked in the registry's first batch`,
      rows: [['Blocks', `${fmtBlock(n.fromBlock)}–${fmtBlock(n.toBlock)}`], ['Blocked events', String(n.count)], ...(Number.isFinite(tm.timeOf(n.toBlock)) ? [['When', esc(fmtTime(tm.timeOf(n.toBlock)).split(' ·')[0])]] : []), ['Transactions', String(n.txs ?? '—')]],
      chips: ['blocked'], note: 'Issuer actions, not accusations.',
      links: [`<a href="/issuer-actions">All issuer actions</a>`, linkBs('tx', n.tx, 'First tx')],
    };
  }
  if (n.state === 'live') {
    return {
      stamp: ['cobalt', 'live'], title: `${n.count} addresses blocked now`,
      rows: [['As of block', fmtBlock(n.block)], ['Source', 'Robinhood access registry']],
      chips: [], note: 'Derived from every Blocked / Unblocked event the registry has emitted.',
      links: [`<a href="/issuer-actions">Issuer actions</a>`, `<a href="#intake" data-fw-focus-input>Try it on any transaction →</a>`],
    };
  }
  const pair = L.edges.find((e) => e.kind === 'pair' && (e.to === n.id || e.from === n.id));
  const rows = [['Address', `<span class="fw-addr">${esc(short(n.address))}</span>`], ['Block', fmtBlock(n.block)], ['Time', esc(when(n.block))]];
  if (n.operator) rows.push(['Operator', `<span class="fw-addr">${esc(short(n.operator))}</span>`]);
  if (pair && pair.to === n.id && Number.isFinite(pair.durationSec)) rows.push(['After', `${fmtDur(pair.durationSec)} blocked`]);
  if (pair && pair.from === n.id) rows.push(['Unblocked', `block ${fmtBlock(pair.block)}`]);
  return {
    stamp: n.state === 'unblocked' ? ['amber', 'Unblocked'] : ['cobalt', 'Blocked'],
    title: n.state === 'unblocked' ? 'Registry unblocked this address' : 'Registry blocked this address',
    rows, chips: [], note: 'Issuer action, not an accusation.',
    links: [`<a href="/status/${esc(n.address)}">Status</a>`, linkBs('tx', n.tx, 'Tx on Blockscout'), linkBs('address', n.address, 'Address')],
  };
}

function describeGraph(n, L, graph, block, opts) {
  if (n.label === 'exit') {
    const what = { 'exit-eth': 'Left as ETH', 'exit-other': n.exit === 'lookalike' ? 'Lookalike token — not freezable' : 'Left as another token', 'exit-stop': 'Trail stops here' }[n.state];
    return {
      stamp: [n.state === 'exit-eth' ? 'amber' : 'muted', n.exit], title: what,
      rows: [['From', `<span class="fw-addr">${esc(short(n.from))}</span>`]], chips: [],
      note: n.state === 'exit-eth' ? 'Native ETH is not traced in this version.' : esc(n.note || ''),
      links: n.tx ? [linkBs('tx', n.tx, 'Tx on Blockscout')] : [],
    };
  }
  const rows = asOf(graph, block).filter((r) => r.holder.toLowerCase() === n.id);
  const hold = rows.length ? rows.map((r) => [esc(r.symbol), `${fmtNum(r.amount)} <span class="fw-sub">${fmtUsd(r.usd)}</span>`]) : [['Holdings', 'none in stock tokens or USDG']];
  const chips = [];
  if (n.blocked) chips.push('blocked'); if (n.frozen) chips.push('frozen'); if (!n.blocked && !n.frozen && rows.length) chips.push('open');
  const truncated = graph.status === 'partial' || graph.budget?.truncated || (graph.exits || []).some((x) => x.kind === 'depth' && String(x.from).toLowerCase() === n.id);
  const links = [`<a href="/status/${esc(n.address)}">Status</a>`, linkBs('address', n.address, 'Blockscout')];
  if (truncated && opts.onContinue) links.push(`<button type="button" class="fw-linkbtn" data-fw-continue="${esc(n.address)}">Continue from this address</button>`);
  // 'thief' only when the user pasted it as the thief's address (nodes[].role, CONTRACT-READY); else "first receiver"
  const thiefMode = n.role ? n.role === 'thief' : (graph.seed?.kind === 'address' && graph.input?.role !== 'victim');
  const role = { victim: 'Sender in the seed transaction', thief: thiefMode ? "Thief's address (as pasted)" : 'First receiver', receiver: 'Receiver', pool: 'Uniswap pool (not followed)', router: 'Router (not followed)', contract: 'Contract (not followed)' }[n.label] || n.label;
  return {
    stamp: n.blocked ? ['cobalt', 'Blocked'] : n.frozen ? ['cold', 'Frozen'] : rows.length ? ['cold', 'Freezable'] : ['muted', n.label === 'thief' ? (thiefMode ? 'thief' : 'first receiver') : n.label === 'victim' ? 'sender' : n.label],
    title: `<span class="fw-addr">${esc(short(n.address))}</span>`, sub: role,
    rows: hold, chips, note: block < L.head ? AS_OF_NOTE : 'Holdings now (live check). ≈ USD is pool spot.', links,
  };
}
const CHIP = { blocked: ['blocked', 'blocked by Robinhood registry'], frozen: ['frozen', 'frozen by Paxos'], open: ['open', 'open'], paused: ['paused', 'token paused'] };
function calloutHTML(d) {
  return `<div class="fw-callout__head"><span class="fw-stamp fw-stamp--${d.stamp[0]}">${esc(d.stamp[1])}</span><button type="button" class="fw-callout__x" aria-label="Close">×</button></div>
<div class="fw-callout__title">${d.title}</div>${d.sub ? `<div class="fw-label">${esc(d.sub)}</div>` : ''}
<dl class="fw-callout__rows">${d.rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
${d.chips.length ? `<div class="fw-callout__chips">${d.chips.map((c) => `<span class="fw-chip fw-chip--${CHIP[c][0]}">${CHIP[c][1]}</span>`).join('')}</div>` : ''}
${d.note ? `<p class="fw-callout__note">${d.note}</p>` : ''}
<div class="fw-callout__links">${d.links.join('')}</div>`;
}

// ---------- pins (always-on labels with leader lines) ----------
function pinsFor(L, data, tm, opts = {}) {
  if (data.kind === 'timeline') {
    // pins: the pre-public batch, the newest event (+ its pair partner) and the live count; other events stay lens-only
    const evs = L.nodes.filter((n) => n.label === 'event');
    const newest = evs[evs.length - 1];
    const pair = newest && L.edges.find((e) => e.kind === 'pair' && e.to === newest.id);
    const show = new Set([newest?.id, pair?.from].filter(Boolean));
    const out = [];
    for (const n of L.nodes) {
      if (n.state === 'cluster') out.push({ id: n.id, k: 'cobalt', a: `${n.addresses ?? n.count} addresses blocked`, b: `first batch · ${n.count} events`, side: 't' });
      else if (n.state === 'live') out.push({ id: n.id, k: 'cobalt', a: `${n.count} blocked now`, b: 'live registry state', side: 'b' });
      else if (show.has(n.id)) {
        const t = tm.timeOf(n.block);
        const dur = pair && pair.to === n.id && Number.isFinite(pair.durationSec) ? `after ${fmtDur(pair.durationSec)}` : null;
        out.push({ id: n.id, k: n.state === 'unblocked' ? 'amber' : 'cobalt', a: n.state, b: dur || (Number.isFinite(t) ? fmtTime(t).replace(/ \d{4} ·/, ' ·') : `block ${fmtBlock(n.block)}`), side: n.state === 'unblocked' ? 'tl' : 'l', prio: false });
      }
    }
    return out;
  }
  const g = data.graph || {};
  const fz = new Map();
  for (const r of g.freezable || []) { const k = r.holder.toLowerCase(); const v = fz.get(k) || []; v.push(r); fz.set(k, v); }
  const out = [];
  const usdOf = (id) => (fz.get(id) || []).reduce((a, r) => a + (Number(r.usd) || 0), 0);
  const topIds = new Set([...fz.keys()].sort((a, b) => usdOf(b) - usdOf(a)).slice(0, opts.maxPins ?? 6));
  for (const n of L.nodes) {
    if (fz.has(n.id) && !topIds.has(n.id) && !n.blocked && !n.frozen) continue;
    if (n.label === 'exit') { if (n.state === 'exit-eth') out.push({ id: n.id, k: 'amber', a: 'ETH exit', b: 'not traced', side: 'b' }); continue; }
    if (n.state === 'victim') { out.push({ id: n.id, k: 'muted', a: 'sender · seed tx', b: short(n.address), side: 'l' }); continue; }
    const rows = fz.get(n.id);
    if (rows?.length) {
      const top = rows.slice().sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))[0];
      out.push({ id: n.id, k: n.blocked ? 'cobalt' : 'cold', a: `${fmtNum(top.amount, 2)} ${top.symbol}${rows.length > 1 ? ` +${rows.length - 1}` : ''}`, b: `${short(n.address)}${n.blocked ? ' · blocked' : n.frozen ? ' · frozen' : ''}`, side: 'r' });
    }
  }
  return out;
}

// ---------- mount ----------
export function mountScene(el, data, opts = {}) {
  const o = { interactive: true, pan: false, ...opts };
  const mobileQ = matchMedia('(max-width: 720px)');
  el.classList.add('fw-scene');
  el.dataset.mode = 'poster';

  let D = data, L, tm, graph, posterPts = null;
  const prepare = () => {
    if (D.kind === 'timeline') { L = layoutTimeline(D.events || [], D.head, { blockedNow: D.blockedNow, batch: D.batch }); graph = null; }
    else { graph = D.graph || {}; L = layoutGraph(graph, { head: D.head }); }
    tm = timeModel(L, D); posterPts = null;
  };
  prepare();

  // poster (LCP element): reuse an SSR <img class="fw-scene__poster"> if present
  let poster = el.querySelector('img.fw-scene__poster');
  if (!poster && o.poster) { poster = h('img', 'fw-scene__poster'); poster.alt = ''; poster.decoding = 'async'; poster.src = o.poster; el.prepend(poster); }
  const glHost = h('div', 'fw-scene__gl'); el.appendChild(glHost);
  const veil = h('div', 'fw-scene__veil'); el.appendChild(veil);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'fw-scene__leaders'); svg.setAttribute('aria-hidden', 'true'); el.appendChild(svg);
  const pinLayer = h('div', 'fw-scene__pins'); el.appendChild(pinLayer);
  const ring = h('div', 'fw-lens'); ring.setAttribute('aria-hidden', 'true'); el.appendChild(ring);
  const callout = h('div', 'fw-callout fw-sheet'); callout.setAttribute('role', 'dialog'); callout.setAttribute('aria-modal', 'false'); callout.hidden = true;
  // on phones the callout is a bottom sheet above everything (rail, intake sheet): it lives in <body>
  const homeCallout = () => { const parent = mobileQ.matches ? document.body : el; if (callout.parentNode !== parent) parent.appendChild(callout); };
  homeCallout(); mobileQ.addEventListener?.('change', homeCallout);
  const live = h('div', 'fw-sr'); live.setAttribute('aria-live', 'polite'); el.appendChild(live);

  // ---------- rail ----------
  const rail = h('div', 'fw-rail fw-sheet');
  rail.innerHTML = `<button type="button" class="fw-rail__play" aria-label="Replay hop by hop"><svg viewBox="0 0 16 16" aria-hidden="true"><path class="i-play" d="M4 2.5v11l9-5.5z"/><path class="i-pause" d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/></svg></button>
<div class="fw-rail__track" role="slider" tabindex="0" aria-label="Scrub time"><div class="fw-rail__line"></div><div class="fw-rail__fill"></div><div class="fw-rail__ticks"></div><div class="fw-rail__handle"></div></div>
<div class="fw-rail__asof"><span class="fw-label">As of block</span><span class="fw-rail__val fw-data"></span></div>`;
  (o.railEl || el).appendChild(rail);
  const track = rail.querySelector('.fw-rail__track'), fill = rail.querySelector('.fw-rail__fill'), handle = rail.querySelector('.fw-rail__handle');
  const ticksEl = rail.querySelector('.fw-rail__ticks'), val = rail.querySelector('.fw-rail__val'), play = rail.querySelector('.fw-rail__play');

  let block = L.head, pos = 1, gl = null, pins = [], playing = 0, lensId = null, lensPinned = false;

  function drawTicks() {
    ticksEl.innerHTML = '';
    const seen = new Set();
    for (const tk of L.ticks) {
      const p = tm.posOf(tk.block); const key = Math.round(p * 400);
      if (seen.has(key)) continue; seen.add(key);
      const t = h('span', 'fw-rail__tick'); t.style.left = (p * 100) + '%';
      const node = tk.node ? L.nodes.find((n) => n.id === tk.node) : null;
      if (node) t.dataset.k = node.state;
      ticksEl.appendChild(t);
    }
  }

  function label() {
    const t = tm.timeOf(block);
    val.textContent = `${fmtBlock(block)}${Number.isFinite(t) ? ' · ' + fmtTime(t, block < L.head - 50000) : ''}${block >= L.head ? ' · now' : ''}`;
    track.setAttribute('aria-valuemin', String(L.seedBlock)); track.setAttribute('aria-valuemax', String(L.head)); track.setAttribute('aria-valuenow', String(block));
    track.setAttribute('aria-valuetext', `block ${fmtBlock(block)}${Number.isFinite(t) ? ', ' + fmtTime(t) : ''}`);
  }

  function apply(b, p, { instant = false, announce = false } = {}) {
    block = b; pos = p;
    fill.style.width = (p * 100) + '%'; handle.style.left = (p * 100) + '%';
    label();
    gl?.setTime(b >= L.head ? Infinity : b, instant);
    for (const pin of pins) pin.on = (L.nodes.find((n) => n.id === pin.id)?.firstBlock ?? 0) <= (b >= L.head ? Infinity : b);
    if (!gl) placePosterPins();
    if (lensId) openLens(lensId, lensPinned, true);
    const rows = graph ? asOf(graph, b >= L.head ? undefined : b) : null;
    o.onScrub?.(b >= L.head ? L.head : b, rows, { atHead: b >= L.head });
    el.dispatchEvent(new CustomEvent('fw:scrub', { detail: { block: b, atHead: b >= L.head, rows } }));
    if (announce) live.textContent = val.textContent;
  }
  const tickBlocks = () => [...new Set([L.seedBlock, ...L.ticks.map((t) => t.block), L.head])].sort((a, b) => a - b);
  function scrubTo(b, o2 = {}) { const bb = Math.max(L.seedBlock, Math.min(L.head, Number(b))); apply(bb, tm.posOf(bb), o2); }
  function step(dir) {
    const tb = tickBlocks();
    const i = dir > 0 ? tb.findIndex((x) => x > block) : tb.length - 1 - [...tb].reverse().findIndex((x) => x < block);
    if (i >= 0 && i < tb.length && tb[i] !== undefined) scrubTo(tb[i], { announce: true });
  }
  function writeHash() { try { history.replaceState(null, '', block >= L.head ? location.pathname + location.search : `#t=${block}`); } catch { /* ignore */ } }

  // drag
  let dragging = false;
  const pFromEv = (ev) => { const r = track.getBoundingClientRect(); return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)); };
  track.addEventListener('pointerdown', (ev) => { dragging = true; stopPlay(); track.setPointerCapture(ev.pointerId); const p = pFromEv(ev); apply(tm.blockAt(p), p); gl?.touched(); });
  track.addEventListener('pointermove', (ev) => { if (!dragging) return; const p = pFromEv(ev); apply(tm.blockAt(p), p); });
  const release = () => {
    if (!dragging) return; dragging = false;
    // snap to the nearest hop when close
    const near = tickBlocks().map((b) => [b, Math.abs(tm.posOf(b) - pos)]).sort((a, b) => a[1] - b[1])[0];
    if (near && near[1] < 0.025) scrubTo(near[0]);
    writeHash();
  };
  track.addEventListener('pointerup', release); track.addEventListener('pointercancel', release);
  track.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') { ev.preventDefault(); stopPlay(); step(1); writeHash(); }
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') { ev.preventDefault(); stopPlay(); step(-1); writeHash(); }
    else if (ev.key === 'Home') { ev.preventDefault(); scrubTo(L.seedBlock, { announce: true }); }
    else if (ev.key === 'End') { ev.preventDefault(); scrubTo(L.head, { announce: true }); writeHash(); }
    else if (ev.key === ' ' || ev.key === 'Spacebar') { ev.preventDefault(); togglePlay(); }
  });
  // replay: one hop per 700 ms
  function stopPlay() { if (playing) clearInterval(playing); playing = 0; rail.classList.remove('is-playing'); play.setAttribute('aria-label', 'Replay hop by hop'); }
  function togglePlay() {
    if (playing) { stopPlay(); return; }
    const tb = tickBlocks();
    if (block >= L.head) scrubTo(tb[0], { instant: true });
    rail.classList.add('is-playing'); play.setAttribute('aria-label', 'Pause replay');
    playing = setInterval(() => { if (block >= L.head) { stopPlay(); writeHash(); return; } step(1); }, STEP_MS);
    gl?.touched();
  }
  play.addEventListener('click', togglePlay);

  // ---------- pins ----------
  function buildPins() {
    pinLayer.innerHTML = ''; svg.innerHTML = '';
    let list = pinsFor(L, D, tm, o);
    if (mobileQ.matches && list.length > (o.mobilePins ?? 3)) list = list.filter((p) => p.prio !== false).slice(0, o.mobilePins ?? 3);
    pins = list.map((p) => {
      const b = h('button', `fw-pin fw-pin--${p.k} fw-pin--${p.side}`);
      b.type = 'button';
      b.innerHTML = `<span class="fw-pin__a">${esc(p.a)}</span><span class="fw-pin__b">${esc(p.b)}</span><span class="fw-sr">, open details</span>`;
      b.addEventListener('click', (ev) => { ev.stopPropagation(); if (lensId === p.id && lensPinned) closeLens(); else openLens(p.id, true); });
      pinLayer.appendChild(b);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path'); line.setAttribute('class', `fw-leader fw-leader--${p.k}`); svg.appendChild(line);
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); dot.setAttribute('r', '2.5'); dot.setAttribute('class', `fw-leader-dot fw-leader--${p.k}`); svg.appendChild(dot);
      return { ...p, el: b, line, dot, on: true };
    });
  }
  const PIN_OFF = { r: [1, -0.85], l: [-1, -0.85], t: [0.35, -1.25], b: [0.35, 1.15], tl: [-0.45, -1.35] };
  function placePin(pin, pr) {
    pin.vis = !!(pr && pr.visible && pin.on);
    if (!pin.vis) return;
    const W = el.clientWidth, H = el.clientHeight;
    const [dx, dy] = PIN_OFF[pin.side] || PIN_OFF.r;
    const len = Math.max(26, pr.r * 0.9) + 22;
    const ex = pr.x + dx * len, ey = pr.y + dy * len * 0.75;
    const bw = pin.el.offsetWidth || 120, bh = pin.el.offsetHeight || 36;
    pin.bw = bw; pin.bh = bh; pin.dx = dx;
    const m = mobileQ.matches ? 8 : (o.pinMargin ?? 8);
    pin.lx = Math.max(m, Math.min(W - bw - m, dx < 0 ? ex - bw : ex));
    const floor = o.railEl ? o.railEl.getBoundingClientRect().top - el.getBoundingClientRect().top : H;
    pin.ly = Math.max(o.pinTop ?? 72, Math.min(floor - bh - 8, ey - bh / 2));
    pin.sx = pr.x + dx * pr.r * 0.62; pin.sy = pr.y + dy * pr.r * 0.5;
  }
  function commitPins() {
    // resolve overlaps: push later tags down (then up if they hit the bottom)
    const vis = pins.filter((p) => p.vis).sort((a, b) => a.ly - b.ly);
    for (let i = 1; i < vis.length; i++) for (let j = 0; j < i; j++) {
      const a = vis[j], b = vis[i];
      if (b.lx < a.lx + a.bw + 6 && a.lx < b.lx + b.bw + 6 && b.ly < a.ly + a.bh + 6) b.ly = a.ly + a.bh + 6;
    }
    const floor = (o.railEl ? o.railEl.getBoundingClientRect().top - el.getBoundingClientRect().top : el.clientHeight) - 8;
    for (let i = vis.length - 1; i >= 0; i--) { const b = vis[i]; if (b.ly + b.bh > floor) { b.ly = floor - b.bh; for (let j = i - 1; j >= 0; j--) { const a = vis[j]; if (a.lx < b.lx + b.bw + 6 && b.lx < a.lx + a.bw + 6 && a.ly + a.bh + 6 > b.ly) a.ly = b.ly - a.bh - 6; } } }
    for (const pin of pins) {
      if (!pin.vis) { pin.el.style.opacity = '0'; pin.el.style.pointerEvents = 'none'; pin.line.setAttribute('d', ''); pin.dot.setAttribute('r', '0'); continue; }
      pin.el.style.transform = `translate3d(${Math.round(pin.lx)}px, ${Math.round(pin.ly)}px, 0)`;
      pin.el.style.opacity = '1'; pin.el.style.pointerEvents = '';
      const ax = pin.dx < 0 ? pin.lx + pin.bw : pin.lx, ay = pin.ly + pin.bh / 2;
      pin.line.setAttribute('d', `M${pin.sx.toFixed(1)} ${pin.sy.toFixed(1)} L${(ax - (pin.dx < 0 ? -10 : 10)).toFixed(1)} ${ay.toFixed(1)} L${ax.toFixed(1)} ${ay.toFixed(1)}`);
      pin.dot.setAttribute('cx', pin.sx.toFixed(1)); pin.dot.setAttribute('cy', pin.sy.toFixed(1)); pin.dot.setAttribute('r', '2.5');
    }
  }

  // poster-space projection (no 3D): same numbers as the server poster (shared/layout.mjs POSTER + project2d)
  function posterProject(id) {
    if (!poster) return null;
    const spec = D.kind === 'timeline' ? POSTER.timeline : POSTER.case;
    if (!posterPts) posterPts = sceneProject(L, { mode: D.kind, w: spec.w, h: spec.h, region: spec.region });
    const q = posterPts.get(id); if (!q) return null;
    // the poster's own box inside the scene element, then object-fit / object-position
    const cw = poster.offsetWidth, ch = poster.offsetHeight, bx = poster.offsetLeft, by = poster.offsetTop;
    const cs = getComputedStyle(poster);
    const s = cs.objectFit === 'contain' ? Math.min(cw / spec.w, ch / spec.h) : Math.max(cw / spec.w, ch / spec.h);
    const [px, py] = (cs.objectPosition || '50% 50%').split(' ').map((v) => parseFloat(v) / 100);
    const ox = bx + (cw - spec.w * s) * (Number.isFinite(px) ? px : 0.5), oy = by + (ch - spec.h * s) * (Number.isFinite(py) ? py : 0.5);
    return { x: ox + q.x * s, y: oy + q.y * s, r: q.r * s, visible: true };
  }
  function placePosterPins() { for (const p of pins) placePin(p, posterProject(p.id)); commitPins(); if (lensId) placeLens(); }
  const projectAny = (id) => (gl ? gl.project(id) : posterProject(id));

  // ---------- lens ----------
  function placeLens() {
    const pr = projectAny(lensId);
    if (!pr) return;
    const R = mobileQ.matches ? 84 : 110;
    ring.style.transform = `translate3d(${(pr.x - R).toFixed(1)}px, ${(pr.y - R).toFixed(1)}px, 0)`;
    ring.style.width = ring.style.height = 2 * R + 'px';
    const m = `radial-gradient(circle ${R}px at ${pr.x.toFixed(0)}px ${pr.y.toFixed(0)}px, transparent ${R - 14}px, #000 ${R}px)`;
    veil.style.webkitMaskImage = m; veil.style.maskImage = m;
    if (!mobileQ.matches) {
      const W = el.clientWidth, H = el.clientHeight, cw = callout.offsetWidth || 300, chh = callout.offsetHeight || 220;
      let x = pr.x + R + 16, y = pr.y - chh / 2;
      if (x + cw > W - 16) x = pr.x - R - 16 - cw;          // flip to stay in the viewport
      x = Math.max(16, x); y = Math.max(76, Math.min(H - chh - (o.railEl ? 16 : 96), y));
      callout.style.transform = `translate3d(${x.toFixed(0)}px, ${y.toFixed(0)}px, 0)`;
    } else callout.style.transform = '';
  }
  function openLens(id, pinned, refresh = false) {
    const n = L.nodes.find((x) => x.id === id); if (!n) return;
    const d = D.kind === 'timeline' ? describeTimeline(n, L, tm) : describeGraph(n, L, graph, block >= L.head ? L.head : block, o);
    if (!refresh || lensId !== id || !callout.hidden) callout.innerHTML = calloutHTML(d);
    lensId = id; lensPinned = pinned;
    el.classList.add('has-lens'); callout.hidden = false;
    callout.setAttribute('aria-label', `Details: ${n.state}`);
    gl?.setLens(id);
    for (const p of pins) p.el.classList.toggle('is-lens', p.id === id);
    placeLens();
    el.dispatchEvent(new CustomEvent('fw:lens', { detail: { id, address: n.address, node: n } }));
    for (const tr of document.querySelectorAll(o.hopRows || 'tr[data-from][data-to]')) tr.classList.toggle('is-lens', tr.dataset.from?.toLowerCase() === id || tr.dataset.to?.toLowerCase() === id);
  }
  function closeLens() {
    lensId = null; lensPinned = false;
    el.classList.remove('has-lens'); callout.hidden = true;
    gl?.setLens(null);
    for (const p of pins) p.el.classList.remove('is-lens');
    el.dispatchEvent(new CustomEvent('fw:lens', { detail: { id: null } }));
    for (const tr of document.querySelectorAll(o.hopRows || 'tr[data-from][data-to]')) tr.classList.remove('is-lens');
  }
  callout.addEventListener('click', (ev) => {
    if (ev.target.closest('.fw-callout__x')) { closeLens(); return; }
    const c = ev.target.closest('[data-fw-continue]'); if (c) { o.onContinue?.(c.dataset.fwContinue); return; }
    const f = ev.target.closest('[data-fw-focus-input]'); if (f) { ev.preventDefault(); closeLens(); document.dispatchEvent(new CustomEvent('fw:focus-input')); }
  });
  const onKey = (ev) => { if (ev.key === 'Escape' && lensId) closeLens(); };
  document.addEventListener('keydown', onKey);

  // ---------- 3D ----------
  let ro = null, io = null, visible = true, destroyed = false;
  function fallback(reason) {
    if (gl) { try { gl.dispose(); } catch { /* ignore */ } gl = null; }
    el.dataset.mode = 'poster'; el.dataset.fallback = reason || 'no-3d';
    placePosterPins();
  }
  async function load3D() {
    if (destroyed || !canUse3D()) { el.dataset.fallback = 'load-rule'; return; }
    try {
      const mod = await import(/* @vite-ignore */ GL_URL);
      if (destroyed) return;
      const mobile = mobileQ.matches;
      gl = mod.createGL(glHost, L, {
        mode: D.kind, pan: !!o.pan, mobile, captureWheel: !!o.pan,
        region: mobile ? o.mobileRegion : o.region,
        distanceScale: o.distanceScale,
        onFrame: () => { for (const p of pins) placePin(p, gl.project(p.id)); commitPins(); if (lensId) placeLens(); },
        onLost: () => fallback('context-lost'),
      });
      gl.setTime(block >= L.head ? Infinity : block, true);
      if (lensId) gl.setLens(lensId);
      gl.start();
      requestAnimationFrame(() => { el.dataset.mode = 'gl'; });
      // pointer: hover = lens (desktop), click/tap = pin it
      let down = null, hoverRaf = 0;
      gl.canvas.addEventListener('pointerdown', (ev) => { down = [ev.clientX, ev.clientY]; });
      gl.canvas.addEventListener('pointerup', (ev) => {
        if (!down || Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) > 6) return;
        const r = el.getBoundingClientRect(); const id = gl.pick(ev.clientX - r.left, ev.clientY - r.top);
        if (!id) { if (lensId) closeLens(); return; }
        if (id === lensId && lensPinned) closeLens(); else openLens(id, true);
      });
      if (o.interactive) gl.canvas.addEventListener('pointermove', (ev) => {
        if (lensPinned || ev.pointerType !== 'mouse' || ev.buttons) return;
        cancelAnimationFrame(hoverRaf);
        hoverRaf = requestAnimationFrame(() => {
          const r = el.getBoundingClientRect(); const id = gl?.pick(ev.clientX - r.left, ev.clientY - r.top);
          gl.canvas.style.cursor = id ? 'pointer' : '';
          if (id && id !== lensId) openLens(id, false); else if (!id && lensId) closeLens();
        });
      });
      ro = new ResizeObserver(() => gl?.resize()); ro.observe(el);
      io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; visible && !document.hidden ? gl?.start() : gl?.stop(); }, { threshold: 0.01 });
      io.observe(el);
    } catch (err) {
      console.warn('[frostwit] 3D scene unavailable, poster stays:', err?.message || err);
      fallback('error');
    }
  }
  const onVis = () => { if (!gl) return; document.hidden || !visible ? gl.stop() : gl.start(); };
  document.addEventListener('visibilitychange', onVis);
  const onResize = () => { if (!gl) placePosterPins(); };
  addEventListener('resize', onResize);
  if (poster && !poster.complete) poster.addEventListener('load', () => { if (!gl) placePosterPins(); }, { once: true });

  // ---------- init ----------
  drawTicks(); buildPins();
  const fromHash = /(?:^|[#&])t=(\d+)/.exec(location.hash);
  if (fromHash) scrubTo(Number(fromHash[1]), { instant: true }); else apply(L.head, 1, { instant: true });
  requestAnimationFrame(placePosterPins);
  if (o.force3D !== false) whenIdle(load3D, o.autoDelay);

  const api = {
    get block() { return block; }, get mode() { return el.dataset.mode; }, get layout() { return L; }, glStats: () => gl?.stats() ?? null,
    setRegion(r) { if (mobileQ.matches) o.mobileRegion = r; else o.region = r; gl?.setRegion(r); },
    scrubTo: (b) => scrubTo(b),
    openLens: (id) => openLens(id, true), closeLens,
    update(next) {
      // polling: only rebuild when the trail itself changed (new hops / nodes / flags); otherwise keep the scene running
      const sig = (d) => d.kind === 'timeline' ? `${(d.events || []).length}|${d.head}|${d.blockedNow}` : (() => { const g = d.graph || {}; return `${(g.nodes || []).length}|${(g.edges || []).length}|${(g.exits || []).length}|${(g.nodes || []).map((n) => +!!n.blocked + 2 * !!n.frozen).join('')}|${(g.freezable || []).map((r) => r.amountRaw ?? r.amount).join(',')}`; })();
      if (sig(next) === sig(D)) { D = next; if (graph) { graph = D.graph || {}; } return; }
      const atHead = block >= L.head;
      D = next; prepare(); drawTicks(); buildPins();
      if (gl) { gl.dispose(); gl = null; load3D(); }
      if (atHead) apply(L.head, 1); else scrubTo(block);
    },
    destroy() {
      destroyed = true; stopPlay(); gl?.dispose(); ro?.disconnect(); io?.disconnect();
      document.removeEventListener('keydown', onKey); document.removeEventListener('visibilitychange', onVis); removeEventListener('resize', onResize);
      rail.remove(); glHost.remove(); veil.remove(); svg.remove(); pinLayer.remove(); ring.remove(); callout.remove(); live.remove();
      delete el.fwScene;
    },
  };
  el.fwScene = api; // test / integration handle
  return api;
}
