// Document shell for every SSR page. Header/footer chrome is cut from LANDING's built web/dist/index.html so pages never drift from the landing.
import fs from 'node:fs';
import path from 'node:path';
import { esc } from '../../../shared/format.mjs';
export { esc };

const FALLBACK_HEAD = '<header class="fw-top"><div class="fw-top__in"><a class="fw-mark" href="/" aria-label="Frostwit home"><span>Frostwit</span></a><nav class="fw-nav" aria-label="Main"><a href="/issuer-actions">Issuer actions</a><a href="/what-to-do">What to do</a><a href="/docs">Docs</a><a href="/token">Token</a></nav><div class="fw-ca" data-fw-ca><!--fw:ca--><span class="fw-ca__sym">$FWIT</span><span class="fw-ca__txt">CA at launch — only the address posted here and on @frostwitRH is real.</span><!--/fw:ca--></div><a class="fw-x" href="https://x.com/frostwitRH" rel="noopener" target="_blank">X</a></div></header>';
const FALLBACK_FOOT = '<footer class="fw-foot"><div class="fw-wrap fw-foot__in"><nav class="fw-foot__nav" aria-label="Footer"><a href="/docs">Docs</a><a href="/what-to-do">What to do</a><a href="/issuer-actions">Issuer actions</a><a href="/token">Token</a><a href="https://x.com/frostwitRH" rel="noopener" target="_blank">X</a></nav><p class="fw-foot__small">$FWIT launch Thu 5 Nov 2026, 15:00 UTC. No promise of returns. Frostwit reads public chain data; it is not affiliated with Robinhood or Paxos and is not legal advice.</p></div></footer>';

let cache = { mtime: 0, file: '', head: FALLBACK_HEAD, foot: FALLBACK_FOOT, raw: null };
export function chrome(distDir) {
  const f = path.join(distDir, 'index.html');
  try {
    const st = fs.statSync(f);
    if (st.mtimeMs !== cache.mtime || cache.file !== f) {
      const raw = fs.readFileSync(f, 'utf8');
      const head = raw.match(/<header class="fw-top">[\s\S]*?<\/header>/)?.[0] ?? FALLBACK_HEAD, foot = raw.match(/<footer class="fw-foot">[\s\S]*?<\/footer>/)?.[0] ?? FALLBACK_FOOT;
      cache = { mtime: st.mtimeMs, file: f, head, foot, raw };
    }
  } catch { cache = { ...cache, raw: null }; }
  return cache;
}
const CA_RE = /<!--fw:ca-->[\s\S]*?<!--\/fw:ca-->/;
export function caSlot(t) {
  if (!t.launched || !/^0x[0-9a-fA-F]{40}$/.test(t.ca || '') || /^0x0{40}$/.test(t.ca)) return null;
  return `<span class="fw-ca__sym">$${esc(t.symbol)}</span><span class="fw-ca__addr fw-mono" title="${esc(t.ca)}">${esc(t.ca)}</span><button class="fw-copy" type="button" data-copy="${esc(t.ca)}">Copy</button><a class="fw-btn" href="${esc(buyUrl(t))}" rel="noopener" target="_blank">Buy on Pons</a>`;
}
export const buyUrl = (t) => `https://ponsfamily.com/token/${t.ca}`;
export function withCa(html, t) {
  const slot = caSlot(t); if (!slot) return html;
  return html.replace(CA_RE, `<!--fw:ca-->${slot}<!--/fw:ca-->`).replace(/<p class="fw-drawer__ca">[\s\S]*?<\/p>/, `<p class="fw-drawer__ca">$${esc(t.symbol)} · <span class="fw-addr">${esc(t.ca)}</span></p>`);
}

export const STAGING_RIBBON = '<div class="fw-stagingbar" role="note" style="position:sticky;top:0;z-index:9999;background:#B8731A;color:#fff;font:700 13px/1 monospace;letter-spacing:.1em;text-transform:uppercase;text-align:center;padding:8px 10px">STAGING · example trace — not a theft</div>';
export const withRibbon = (html, on) => (on ? html.replace(/(<body[^>]*>)/, '$1' + STAGING_RIBBON) : html);
export function layout(ctx, { title, desc, path: p = '/', og, body, scripts = ['/dist/pages.js'], noindex = false, bodyClass = 'fw-page', head = '' }) {
  const site = ctx.cfg.siteUrl, c = chrome(ctx.cfg.distDir), t = ctx.token();
  const full = title === 'Frostwit' ? title : `${title} · Frostwit`;
  const d = desc || 'Paste the theft transaction or the thief\'s address. Frostwit follows official Robinhood stock tokens and USDG and shows what the issuer can still freeze. It cannot freeze anything itself.';
  const img = og ? (og.startsWith('http') ? og : site + og) : site + '/og.jpg';
  return withCa(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(full)}</title><meta name="description" content="${esc(d)}"><link rel="canonical" href="${esc(site + p)}">${noindex ? '<meta name="robots" content="noindex">' : ''}
<meta name="theme-color" content="#EAF1F7"><meta property="og:type" content="website"><meta property="og:site_name" content="Frostwit"><meta property="og:title" content="${esc(full)}"><meta property="og:description" content="${esc(d)}"><meta property="og:url" content="${esc(site + p)}"><meta property="og:image" content="${esc(img)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="@frostwitRH"><meta name="twitter:title" content="${esc(full)}"><meta name="twitter:description" content="${esc(d)}"><meta name="twitter:image" content="${esc(img)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png"><link rel="apple-touch-icon" href="/icon-192.png"><link rel="manifest" href="/site.webmanifest">
<link rel="preload" href="/dist/fonts/familjen-grotesk-latin-700-normal.woff2" as="font" type="font/woff2" crossorigin><link rel="preload" href="/dist/fonts/archivo-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/dist/styles.css">${head}</head>
<body class="${bodyClass}"><a class="fw-skip" href="#main">Skip to content</a>
${c.head}
<main id="main" class="fw-main">${body}</main>
${c.foot}
${scripts.map((s) => `<script type="module" src="${s}"></script>`).join('')}</body></html>`, t).replace(/(<body[^>]*>)/, ctx.cfg.staging ? '$1' + STAGING_RIBBON : '$1');
}
export const jsonScript = (id, obj) => `<script type="application/json" id="${id}">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
export const wrap = (inner, cls = '') => `<div class="fw-wrap ${cls}">${inner}</div>`;
