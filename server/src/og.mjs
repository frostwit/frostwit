// OG cards and poster PNGs: satori -> resvg. Templates are LANDING's (server/src/og/templates/index.mjs); this file is the glue + cache.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { ROOT } from './config.mjs';

const h = (type, props, ...children) => ({ type, props: { ...(props || {}), children: children.length === 1 ? children[0] : children } });
export async function createImages({ log = () => {} } = {}) {
  const tplFile = path.join(ROOT, 'server/src/og/templates/index.mjs'), layoutFile = path.join(ROOT, 'shared/layout.mjs');
  const S = { ready: false, T: null, L: null, fonts: [], cache: new Map(), checkedAt: 0 };
  async function load() {
    S.checkedAt = Date.now();
    if (S.ready || !fs.existsSync(tplFile) || !fs.existsSync(layoutFile)) return S.ready;
    try {
      S.T = await import(pathToFileURL(tplFile).href); S.L = await import(pathToFileURL(layoutFile).href);
      const dir = path.dirname(tplFile);
      S.fonts = (S.T.fonts || []).map((f) => ({ name: f.name, data: fs.readFileSync(path.join(dir, f.file)), weight: f.weight, style: f.style || 'normal' }));
      S.ready = typeof S.T.posterGraph === 'function' && typeof S.T.ogCase === 'function' && S.fonts.length > 0;
    } catch (e) { log('og templates not usable:', e.message); S.ready = false; }
    return S.ready;
  }
  const render = async (tree) => {
    const svg = await satori(tree, { width: 1200, height: 630, fonts: S.fonts });
    return new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
  };
  const memo = async (key, fn) => {
    if (S.cache.has(key)) return S.cache.get(key);
    const buf = await fn(); S.cache.set(key, buf); if (S.cache.size > 200) S.cache.delete(S.cache.keys().next().value); return buf;
  };
  return {
    state: S, load,
    ready: () => S.ready,
    async posterGraph(view, stats) { await load(); if (!S.ready) return null; return memo(`pg:${view.id}:${view.lastCheckAt}:${view.edges.length}`, async () => S.T.renderPoster({ kind: 'graph', layout: S.L.layoutGraph(view) })); },
    async posterTimeline(data, stats) { await load(); if (!S.ready || !S.T.renderPoster) return null; return memo(`pt:${data.events.length}:${data.blockedNow}:${Math.floor(Date.now() / 600000)}`, async () => S.T.renderPoster({ kind: 'timeline', layout: S.L.layoutTimeline(data.events, data.head, { blockedNow: data.blockedNow, batch: data.batch }) })); },
    async ogCase(view) {
      await load(); if (!S.ready) return null;
      const hops = view.edges.length, usd = view.freezable.reduce((s, r) => s + (r.blocked || r.frozen ? 0 : r.usd || 0), 0), addresses = view.nodes.filter((n) => ['thief', 'receiver', 'contract'].includes(n.label)).length;
      return memo(`og:${view.id}:${view.lastCheckAt}:${hops}`, () => render(S.T.ogCase({ hops, usd: undefined, addresses, status: view.status }, h)));
    },
  };
}
