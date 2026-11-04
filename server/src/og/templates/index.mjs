// Poster + OG templates (LANDING). APP glue calls these; nothing here touches the DB or the network.
//
// CONTRACT (CONTRACT-READY.md, with sizes fixed by LANDING):
//   posterTimeline({layout, stats}, h) / posterGraph({layout, stats}, h) → satori tree, size = posterSize(kind)
//       timeline 1440×900, graph 1600×900 — NOT 1200×630: the landing / case pages place DOM pins over the poster
//       with the same projection (shared/layout.mjs sceneProject + POSTER), so the poster must keep this size.
//       Easiest for glue: renderPoster({kind:'timeline', layout}) / renderPoster({kind:'graph', layout}) → PNG Buffer
//       (no satori needed; posters have no text). posterSvg(...) → SVG string.
//   ogDefault({blockedNow, lastActionDate, ca?, launched?}, h) → satori tree 1200×630 (/og.jpg)
//   ogCase({hops, usd, addresses, status, layout?}, h)       → satori tree 1200×630 (/og/case/:id.png; never the victim address)
//   fonts → [{name, file, weight, style}] (woff, relative to this directory); ogFonts() → satori `fonts` array with data
//   renderOg(tree) → PNG Buffer (satori → resvg) for convenience.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { layoutGraph, layoutTimeline, sceneProject, POSTER, hash01 } from '../../../../shared/layout.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P = { frost: '#EAF1F7', ice: '#DCE8F1', fogHi: '#F6F9FB', rime: '#B4C7D5', ink: '#0F1C27', ink2: '#4A5A68', cobalt: '#1E45C9', cold: '#7FB3FF', amber: '#B8731A', graphite: '#6B7A86', steel: '#5D7891', paper: '#FBFDFE', pulse: '#2F6FE4' };
const CORE = { freezable: P.cold, blocked: P.cobalt, frozen: P.cobalt, live: P.cobalt, cluster: P.cobalt, unblocked: P.amber, victim: P.steel, plain: P.steel, contract: P.graphite, pool: P.graphite, router: P.graphite, 'exit-eth': P.amber, 'exit-other': P.graphite, 'exit-stop': P.graphite };
const f2 = (v) => Math.round(v * 10) / 10;

function crystal(id, x, y, r, state, opts = {}) {
  const core = CORE[state] || P.steel;
  const squash = state === 'pool' || state === 'router' ? 0.5 : state === 'contract' ? 0.6 : state === 'exit-eth' ? 0.4 : 1;
  const op = state.startsWith('exit') ? 0.35 : 1;
  const rot = hash01(id) * 0.5 - 0.25;
  const pts = Array.from({ length: 6 }, (_, i) => { const a = rot + Math.PI / 6 + i * Math.PI / 3; return [x + Math.cos(a) * r, y + Math.sin(a) * r * squash * (1 + 0.12 * Math.abs(Math.sin(a)))]; });
  const c = [x - r * 0.14, y - r * 0.18 * squash];
  // facet shades: light from the upper left
  const shades = ['#FFFFFF', '#F2F7FB', '#DCE7F0', '#CBDAE6', '#D7E3EC', '#EEF4F9'];
  let s = `<g opacity="${op}">`;
  s += `<ellipse cx="${f2(x + r * 0.15)}" cy="${f2(y + r * 1.05 * squash)}" rx="${f2(r * 0.9)}" ry="${f2(r * 0.16)}" fill="#9FB4C6" opacity=".22"/>`;
  for (let i = 0; i < 6; i++) {
    const a = pts[i], b = pts[(i + 1) % 6];
    s += `<path d="M${f2(c[0])} ${f2(c[1])}L${f2(a[0])} ${f2(a[1])}L${f2(b[0])} ${f2(b[1])}Z" fill="${shades[i]}"/>`;
  }
  const cr = r * (state === 'live' || state === 'blocked' || state === 'frozen' ? 0.62 : state === 'cluster' ? 0.4 : 0.5);
  s += `<circle cx="${f2(x)}" cy="${f2(y + r * 0.02)}" r="${f2(cr)}" fill="url(#core-${state})"/>`;
  s += `<path d="M${pts.map((p) => `${f2(p[0])} ${f2(p[1])}`).join('L')}Z" fill="none" stroke="${P.steel}" stroke-opacity=".55" stroke-width="${f2(Math.max(1, r * 0.035))}" stroke-linejoin="round"/>`;
  s += `<path d="M${f2(c[0])} ${f2(c[1])}L${f2(pts[3][0])} ${f2(pts[3][1])}M${f2(c[0])} ${f2(c[1])}L${f2(pts[5][0])} ${f2(pts[5][1])}M${f2(c[0])} ${f2(c[1])}L${f2(pts[1][0])} ${f2(pts[1][1])}" stroke="#FFFFFF" stroke-opacity=".8" stroke-width="${f2(Math.max(0.8, r * 0.02))}"/>`;
  if (opts.shell) s += `<path d="M${pts.map((p) => `${f2(x + (p[0] - x) * 1.38)} ${f2(y + (p[1] - y) * 1.38)}`).join('L')}Z" fill="${P.cold}" fill-opacity=".07" stroke="${P.cold}" stroke-opacity=".55" stroke-width="1.2" stroke-dasharray="3 4"/>`;
  return s + '</g>';
}

/** SVG poster (no text). data = timeline or graph (see header). */
export function posterSvg(data, o = {}) {
  const isTl = data.kind === 'timeline';
  const spec = isTl ? POSTER.timeline : POSTER.case;
  const W = spec.w, H = spec.h;
  const L = data.layout || (isTl ? layoutTimeline(data.events || [], data.head, { blockedNow: data.blockedNow, batch: data.batch }) : layoutGraph(data.graph || {}, { head: data.head }));
  const P2 = sceneProject(L, { mode: data.kind, w: W, h: H, region: spec.region });
  const pos = new Map(L.nodes.map((n) => [n.id, { n, ...P2.get(n.id) }]));
  const states = [...new Set(L.nodes.map((n) => n.state))];
  let defs = `<radialGradient id="fog" cx="${isTl ? 0.7 : 0.5}" cy="0.42" r="0.85"><stop offset="0" stop-color="${P.fogHi}"/><stop offset=".45" stop-color="#EEF4F8"/><stop offset="1" stop-color="${P.ice}"/></radialGradient>`;
  for (const s of states) defs += `<radialGradient id="core-${s}"><stop offset="0" stop-color="${CORE[s] || P.steel}" stop-opacity=".95"/><stop offset=".55" stop-color="${CORE[s] || P.steel}" stop-opacity=".55"/><stop offset="1" stop-color="${CORE[s] || P.steel}" stop-opacity="0"/></radialGradient>`;
  defs += `<linearGradient id="str" x1="0" x2="1"><stop offset="0" stop-color="${P.steel}" stop-opacity=".45"/><stop offset="1" stop-color="${P.pulse}" stop-opacity=".9"/></linearGradient>`;

  let body = o.transparent ? '' : `<rect width="${W}" height="${H}" fill="url(#fog)"/>`;
  // time axis under everything (an axis, not data)
  // strings
  for (const e of L.edges) {
    const a = pos.get(e.from), b = pos.get(e.to); if (!a || !b) continue;
    const kind = e.kind || 'transfer';
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - (kind === 'spine' ? 0 : kind === 'pair' ? 46 : 18 + hash01(String(e.tx) + e.from) * 30);
    const d = `M${f2(a.x)} ${f2(a.y)}Q${f2(mx)} ${f2(my)} ${f2(b.x)} ${f2(b.y)}`;
    if (kind === 'spine') body += `<path d="${d}" fill="none" stroke="${P.rime}" stroke-width="1.5"/>`;
    else if (kind === 'pair') body += `<path d="${d}" fill="none" stroke="${P.cobalt}" stroke-width="3" stroke-linecap="round"/><path d="${d}" fill="none" stroke="${P.cold}" stroke-width="9" stroke-opacity=".25" stroke-linecap="round"/>`;
    else body += `<path d="${d}" fill="none" stroke="${kind === 'exit' ? P.amber : 'url(#str)'}" stroke-width="2.4" ${kind === 'swap' || kind === 'exit' ? 'stroke-dasharray="7 6"' : ''} stroke-linecap="round" opacity="${kind === 'exit' ? 0.5 : 1}"/>`;
  }
  // rime dots near cold crystals
  for (const v of pos.values()) {
    if (!['freezable', 'blocked', 'frozen', 'live', 'cluster'].includes(v.n.state)) continue;
    for (let i = 0; i < 26; i++) {
      const a = hash01(v.n.id + 'a' + i) * 6.283, rr = v.r * (1.35 + 1.9 * hash01(v.n.id + 'r' + i));
      body += `<circle cx="${f2(v.x + Math.cos(a) * rr)}" cy="${f2(v.y + Math.sin(a) * rr * 0.8)}" r="${f2(1 + 1.8 * hash01(v.n.id + 's' + i))}" fill="#7E9DB8" opacity="${f2(0.25 + 0.4 * hash01(v.n.id + 'o' + i))}"/>`;
    }
  }
  // crystals, far to near
  const order = [...pos.values()].sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));
  for (const v of order) {
    body += crystal(v.n.id, v.x, v.y, v.r * 0.92, v.n.state === 'cluster' ? 'plain' : v.n.state, { shell: ['blocked', 'frozen'].includes(v.n.state) });
    if ((v.n.state === 'cluster' || v.n.state === 'live') && v.n.count > 0) {
      // one cobalt speck per blocked address, inside the crystal (as in the 3D scene)
      const cnt = Math.min(600, v.n.count | 0);
      for (let i = 0; i < cnt; i++) {
        const k = i + 0.5, phi = Math.acos(1 - 2 * k / cnt), th = Math.PI * (1 + Math.sqrt(5)) * k;
        const rr = v.r * 0.55 * Math.cbrt(0.08 + 0.92 * hash01(v.n.id + 'k' + i));
        body += `<circle cx="${f2(v.x + Math.cos(th) * Math.sin(phi) * rr * 0.86)}" cy="${f2(v.y - Math.cos(phi) * rr * 1.2)}" r="${f2(0.9 + 0.9 * hash01(v.n.id + 'sd' + i))}" fill="${P.cobalt}" opacity="${f2(0.45 + 0.45 * hash01(v.n.id + 'o' + i))}"/>`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs>${body}</svg>`;
}

// Posters default to a transparent background (the page's .fw-scene fog shows through) at 0.8× size:
// both keep the LCP image small; the browser scales it to the poster box, pins use the logical POSTER size.
export function renderPoster(data, { width, transparent = true, scale = data.kind === "timeline" ? 0.8 : 0.62 } = {}) {
  if (!width) width = Math.round((data.kind === 'timeline' ? POSTER.timeline.w : POSTER.case.w) * scale);
  return new Resvg(posterSvg(data, { transparent }), width ? { fitTo: { mode: 'width', value: width } } : {}).render().asPng();
}
export const posterSize = (kind) => { const p = kind === 'timeline' ? POSTER.timeline : POSTER.case; return { width: p.w, height: p.h }; };
const pngUri = (buf) => 'data:image/png;base64,' + Buffer.from(buf).toString('base64');
const posterTree = (kind, d, h) => { const { width, height } = posterSize(kind); return h('div', { style: { display: 'flex', width, height } }, h('img', { src: pngUri(renderPoster({ kind, layout: d.layout })), width, height })); };
/** satori tree wrappers (CONTRACT-READY names); prefer renderPoster for posters */
export const posterTimeline = (d = {}, h) => posterTree('timeline', d, h);
export const posterGraph = (d = {}, h) => posterTree('graph', d, h);

// ---------- OG ----------
export const fonts = [
  { name: 'Familjen Grotesk', file: 'fonts/familjen-grotesk-latin-600-normal.woff', weight: 600, style: 'normal' },
  { name: 'Familjen Grotesk', file: 'fonts/familjen-grotesk-latin-700-normal.woff', weight: 700, style: 'normal' },
  { name: 'Archivo', file: 'fonts/archivo-latin-400-normal.woff', weight: 400, style: 'normal' },
  { name: 'Archivo', file: 'fonts/archivo-latin-500-normal.woff', weight: 500, style: 'normal' },
  { name: 'Courier Prime', file: 'fonts/courier-prime-latin-400-normal.woff', weight: 400, style: 'normal' },
  { name: 'Courier Prime', file: 'fonts/courier-prime-latin-700-normal.woff', weight: 700, style: 'normal' },
];
export function ogFonts() {
  const f = (file, name, weight) => ({ name, weight, style: 'normal', data: fs.readFileSync(path.join(HERE, 'fonts', file)) });
  return [
    f('familjen-grotesk-latin-600-normal.woff', 'Familjen Grotesk', 600), f('familjen-grotesk-latin-700-normal.woff', 'Familjen Grotesk', 700),
    f('archivo-latin-400-normal.woff', 'Archivo', 400), f('archivo-latin-500-normal.woff', 'Archivo', 500),
    f('courier-prime-latin-400-normal.woff', 'Courier Prime', 400), f('courier-prime-latin-700-normal.woff', 'Courier Prime', 700),
  ];
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayUtc = (sec) => { let n = Number(sec); if (!Number.isFinite(n)) n = Date.parse(sec) / 1000; if (!Number.isFinite(n)) return ''; const d = new Date((n > 1e12 ? n / 1000 : n) * 1000); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const DISP = 'Familjen Grotesk', BODY = 'Archivo', MONO = 'Courier Prime';
const pin = (h, size = 44) => h('svg', { width: size, height: size, viewBox: '0 0 32 32' },
  h('path', { d: 'M16 30.5S4.5 19.8 4.5 12a11.5 11.5 0 0 1 23 0c0 7.8-11.5 18.5-11.5 18.5z', fill: P.cobalt }),
  h('path', { d: 'M16 5.2v13.6M10.1 8.6l11.8 6.8M10.1 15.4l11.8-6.8', stroke: P.fogHi, strokeWidth: 1.9, strokeLinecap: 'round', fill: 'none' }));
const label = (h, t, color = P.ink2) => h('div', { style: { display: 'flex', fontFamily: MONO, fontWeight: 700, fontSize: 18, letterSpacing: 2, textTransform: 'uppercase', color } }, t);
const frame = (h, posterPng, ...kids) => h('div', { style: { display: 'flex', width: 1200, height: 630, position: 'relative', backgroundColor: P.frost, backgroundImage: 'radial-gradient(circle at 72% 42%, #F6F9FB 0%, #EEF4F8 40%, #DCE8F1 100%)', fontFamily: BODY, color: P.ink } },
  posterPng ? h('img', { src: posterPng, width: 1200, height: 750, style: { position: 'absolute', left: 105, top: -130, width: 1200, height: 750 } }) : h('div', { style: { display: 'flex' } }),
  ...kids);
const sheet = (h, style, ...kids) => h('div', { style: { display: 'flex', flexDirection: 'column', background: P.paper, border: `1.5px solid ${P.rime}`, borderRadius: 16, boxShadow: '0 18px 40px -24px rgba(15,28,39,.35)', ...style } }, ...kids);

const BACKDROP = path.join(HERE, 'og-backdrop.png');
const backdrop = () => { try { return pngUri(fs.readFileSync(BACKDROP)); } catch { return null; } };
const args = (a, b) => (typeof a === 'function' ? [a, b || {}] : [b, a || {}]);
export function ogDefault(a, b) {
  const [h, d0] = args(a, b);
  const d = { posterPng: backdrop(), ...d0, lastActionAt: d0.lastActionAt ?? d0.lastActionDate };
  const ca = d.launched && /^0x[0-9a-fA-F]{40}$/.test(d.ca || '') && !/^0x0{40}$/.test(d.ca) ? d.ca : null;
  const hasStats = Number.isFinite(Number(d.blockedNow));
  return frame(h, d.posterPng,
    sheet(h, { position: 'absolute', left: 56, top: 56, width: 560, padding: '32px 36px 28px' },
      h('div', { style: { display: 'flex', alignItems: 'center' } }, pin(h, 40), h('div', { style: { display: 'flex', marginLeft: 12, fontFamily: DISP, fontWeight: 700, fontSize: 30 } }, 'Frostwit')),
      h('div', { style: { display: 'flex', flexDirection: 'column', marginTop: 24, fontFamily: DISP, fontWeight: 700, fontSize: 56, lineHeight: 1.02, letterSpacing: -1.5 } },
        h('div', { style: { display: 'flex' } }, 'Drained on Robinhood Chain?'), h('div', { style: { display: 'flex', color: P.cobalt } }, 'Paste the theft.')),
      h('div', { style: { display: 'flex', marginTop: 16, fontSize: 21, lineHeight: 1.4, color: P.ink2 } }, 'Follows stolen stock tokens and USDG, shows what the issuer can still freeze. Frostwit cannot freeze anything itself.'),
      hasStats ? h('div', { style: { display: 'flex', flexDirection: 'column', marginTop: 20, paddingTop: 14, borderTop: `1.5px dashed ${P.rime}` } },
        label(h, 'Issuer actions, on-chain', P.cobalt),
        h('div', { style: { display: 'flex', marginTop: 6, fontFamily: MONO, fontSize: 19 } }, `${Number(d.blockedNow).toLocaleString('en-US')} addresses blocked by Robinhood's registry${d.lastActionAt ? ` · last action ${dayUtc(d.lastActionAt)}` : ''}`)) : h('div', { style: { display: 'flex' } }),
      h('div', { style: { display: 'flex', marginTop: 14, fontFamily: MONO, fontSize: 19, color: P.ink } }, ca ? `$FWIT · ${ca.slice(0, 10)}…${ca.slice(-8)}` : '$FWIT · frostwit.pro')));
}

export function ogCase(a, b) {
  const [h, d0] = args(a, b);
  const d = { ...d0, freezableUsd: d0.freezableUsd ?? d0.usd };
  if (!d.posterPng && d.layout) d.posterPng = pngUri(renderPoster({ kind: 'graph', layout: d.layout }, { width: 1200, transparent: true }));
  const usd = d.freezableUsd == null ? '—' : '$' + Math.round(Number(d.freezableUsd)).toLocaleString('en-US');
  const stat = (k, v) => h('div', { style: { display: 'flex', flexDirection: 'column', marginRight: 34 } }, label(h, k), h('div', { style: { display: 'flex', marginTop: 6, fontFamily: DISP, fontWeight: 700, fontSize: 52, letterSpacing: -1 } }, v));
  return frame(h, d.posterPng,
    sheet(h, { position: 'absolute', left: 56, bottom: 56, padding: '26px 32px 24px', width: 700 },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
        h('div', { style: { display: 'flex', alignItems: 'center' } }, pin(h, 34), h('div', { style: { display: 'flex', marginLeft: 10, fontFamily: DISP, fontWeight: 700, fontSize: 26 } }, 'Frostwit · case file')),
        h('div', { style: { display: 'flex', fontFamily: MONO, fontWeight: 700, fontSize: 18, letterSpacing: 3, color: P.cobalt, border: `2.5px solid ${P.cobalt}`, borderRadius: 5, padding: '6px 10px', transform: 'rotate(-2deg)' } }, String(d.status || 'done').toUpperCase())),
      h('div', { style: { display: 'flex', marginTop: 22 } }, stat('Hops', String(d.hops ?? 0)), stat('Freezable now ≈ USD', usd), stat('Addresses', String(d.addresses ?? 0))),
      h('div', { style: { display: 'flex', marginTop: 14, fontSize: 18, color: P.ink2 } }, 'USD at pool spot. Frostwit cannot freeze anything; the issuer decides.')));
}

export async function renderOg(tree, { width = 1200 } = {}) {
  const { default: satori } = await import('satori');
  const svg = await satori(tree, { width: 1200, height: 630, fonts: ogFonts() });
  return new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
}
/** satori-compatible element factory */
export const hEl = (type, props, ...children) => { const k = children.flat().filter((c) => c != null && c !== false); return { type, props: { ...(props || {}), children: k.length === 1 ? k[0] : k } }; };
