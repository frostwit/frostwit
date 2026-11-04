// LANDING dev-time asset renderer (not run on the server): node web/src/landing/render-assets.mjs
// Writes: server/src/og/templates/og-backdrop.png, web/art/icons/{favicon.svg,favicon-32.png,icon-192.png,icon-512.png,
// apple-touch-icon.png,site.webmanifest,og.jpg}, web/art/x/{avatar-400.png,banner-1500x500.png}.
// All procedural, from the real registry fixture (fixtures/issuer-events.json). JPEG via macOS `sips`.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { layoutTimeline } from '../../../shared/layout.mjs';
import { posterSvg, renderPoster, ogDefault, renderOg, hEl, ogFonts } from '../../../server/src/og/templates/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const at = (...p) => path.join(root, ...p);
const fx = JSON.parse(fs.readFileSync(at('fixtures/issuer-events.json'), 'utf8'));
const head = fx.recordedAtHead;
const png = (svg, w) => new Resvg(svg, { fitTo: { mode: 'width', value: w } }).render().asPng();

// ---- favicon: map pin whose head is a six-point ice crystal (cobalt + frost white) ----
const pinSvg = (size, { bg = null, detail = true } = {}) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">${bg ? `<rect width="32" height="32" rx="${bg.r}" fill="${bg.c}"/>` : ''}
<path d="M16 30.5S4.5 19.8 4.5 12a11.5 11.5 0 0 1 23 0c0 7.8-11.5 18.5-11.5 18.5z" fill="#1E45C9"/>
<g stroke="#F6F9FB" stroke-width="${detail ? 1.7 : 2.2}" stroke-linecap="round" fill="none"><path d="M16 5.2v13.6M10.1 8.6l11.8 6.8M10.1 15.4l11.8-6.8"/>${detail ? '<path d="M14.3 6.3 16 7.8l1.7-1.5M14.3 17.7 16 16.2l1.7 1.5M10.5 10.7l2.2.4-.6-2.1M21.5 13.3l-2.2-.4.6 2.1M10.5 13.3l2.2-.4-.6 2.1M21.5 10.7l-2.2.4.6-2.1"/>' : ''}</g></svg>`;
const icons = at('web/art/icons');
fs.writeFileSync(path.join(icons, 'favicon.svg'), pinSvg(32));
fs.writeFileSync(path.join(icons, 'favicon-32.png'), png(pinSvg(32, { detail: false }), 32));
const padded = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64"><rect width="64" height="64" fill="#EAF1F7"/><circle cx="32" cy="32" r="26" fill="#F6F9FB" stroke="#B4C7D5" stroke-width="1"/><g transform="translate(14 13) scale(1.15)">${pinSvg(32).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')}</g></svg>`;
for (const [n, s] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) fs.writeFileSync(path.join(icons, n), png(padded(s), s));
fs.writeFileSync(path.join(icons, 'site.webmanifest'), JSON.stringify({
  name: 'Frostwit', short_name: 'Frostwit', start_url: '/', display: 'standalone', background_color: '#EAF1F7', theme_color: '#EAF1F7',
  icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }],
}, null, 2));

// ---- OG backdrop (timeline poster, real data) + og.jpg ----
const tlData = { kind: 'timeline', events: fx.events, head, blockedNow: fx.blockedNow };
fs.writeFileSync(at('server/src/og/templates/og-backdrop.png'), renderPoster(tlData, { width: 1200 }));
const og = await renderOg(ogDefault(hEl, { blockedNow: fx.blockedNow, lastActionDate: fx.lastAction?.time }));
const tmp = at('web/art/icons/og.png'); fs.writeFileSync(tmp, og);
execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '86', tmp, '--out', path.join(icons, 'og.jpg')], { stdio: 'ignore' });
fs.rmSync(tmp);

// ---- X avatar 400² + banner 1500×500 ----
fs.writeFileSync(at('web/art/x/avatar-400.png'), png(padded(400), 400));
const L = layoutTimeline(fx.events, head, { blockedNow: fx.blockedNow });
const bannerPoster = posterSvg({ kind: 'timeline', layout: L }, { transparent: true }); // 1440×900, scene in the right half
const bannerTree = hEl('div', { style: { display: 'flex', width: 1500, height: 500, position: 'relative', backgroundImage: 'radial-gradient(circle at 72% 45%, #F6F9FB 0%, #EEF4F8 40%, #DCE8F1 100%)', fontFamily: 'Archivo', color: '#0F1C27' } },
  hEl('img', { src: 'data:image/png;base64,' + Buffer.from(png(bannerPoster, 1440)).toString('base64'), width: 1440, height: 900, style: { position: 'absolute', left: 160, top: -290, width: 1440, height: 900 } }),
  hEl('div', { style: { display: 'flex', flexDirection: 'column', position: 'absolute', left: 64, top: 70, width: 640 } },
    hEl('div', { style: { display: 'flex', fontFamily: 'Courier Prime', fontWeight: 700, fontSize: 20, letterSpacing: 3, color: '#1E45C9', textTransform: 'uppercase' } }, 'frostwit.pro'),
    hEl('div', { style: { display: 'flex', marginTop: 14, fontFamily: 'Familjen Grotesk', fontWeight: 700, fontSize: 64, lineHeight: 1.02, letterSpacing: -2 } }, 'Drained on Robinhood Chain?'),
    hEl('div', { style: { display: 'flex', fontFamily: 'Familjen Grotesk', fontWeight: 700, fontSize: 64, lineHeight: 1.05, letterSpacing: -2, color: '#1E45C9' } }, 'Paste the theft.'),
    hEl('div', { style: { display: 'flex', marginTop: 18, fontSize: 22, lineHeight: 1.4, color: '#4A5A68', width: 560 } }, 'Follows stolen stock tokens and USDG and shows what the issuer can still freeze. Frostwit cannot freeze anything itself.')));
const { default: satori } = await import('satori');
const bsvg = await satori(bannerTree, { width: 1500, height: 500, fonts: ogFonts() });
fs.writeFileSync(at('web/art/x/banner-1500x500.png'), png(bsvg, 1500));
console.log('assets:', fs.readdirSync(icons).join(' '), '| x:', fs.readdirSync(at('web/art/x')).join(' '));
