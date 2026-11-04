// Landing script (LANDING). First-paint bundle: no three.js. Fetches /api/stats and /api/issuer-actions only.
import { mountScene, fmtTime } from '../scene/index.mjs';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const TX = /^0x[0-9a-fA-F]{64}$/, ADDR = /^0x[0-9a-fA-F]{40}$/;
const MSG = {
  invalid_input: 'Paste a Robinhood Chain address (0x + 40 hex) or a transaction hash (0x + 64 hex).',
  tx_not_found: 'Not found on Robinhood Chain. If it was just sent, wait a minute.',
  too_old: 'v0.1 address mode covers 7 days. Paste the theft transaction for older cases.',
  rpc_unavailable: "Robinhood Chain's RPC is not answering right now, so new cases cannot start. Existing case links keep working.",
  network: 'Could not reach frostwit.pro. Check your connection and try again.',
};
const getJSON = async (u) => { const r = await fetch(u, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (sec) => { const d = new Date(sec * 1000); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const toSec = (v) => (v == null ? NaN : typeof v === 'number' ? (v > 1e12 ? v / 1000 : v) : Date.parse(v) / 1000);

// ---------- intake ----------
const form = $('#intake'), input = $('#fw-input'), msg = $('#fw-msg');
const state = { role: 'thief', hours: 24 };
function say(text, err = false) { msg.textContent = text || ''; msg.classList.toggle('is-err', !!err); }
function mode() { const v = input.value.trim(); form.classList.toggle('is-address', ADDR.test(v) || state.forceAddress === true); }
input.addEventListener('input', () => { say(''); state.forceAddress = false; mode(); });
input.addEventListener('paste', () => setTimeout(() => { input.value = input.value.trim(); mode(); }, 0));
function press(group, attr, value) { for (const b of $$(`[${attr}]`, group)) b.setAttribute('aria-pressed', String(b.getAttribute(attr) === String(value))); }
const roleSeg = $('.fw-intake__opts .fw-seg'), hourSeg = $('.fw-intake__hours');
roleSeg.addEventListener('click', (e) => { const b = e.target.closest('[data-role]'); if (!b) return; state.role = b.dataset.role; press(roleSeg, 'data-role', state.role); state.forceAddress = true; mode(); placeholder(); });
hourSeg.addEventListener('click', (e) => { const b = e.target.closest('[data-hours]'); if (!b) return; state.hours = Number(b.dataset.hours); press(hourSeg, 'data-hours', state.hours); state.forceAddress = true; mode(); });
function placeholder() { input.placeholder = state.forceAddress ? (state.role === 'victim' ? '0x… your own wallet address' : "0x… thief's address") : '0x… theft transaction hash'; }

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = input.value.trim();
  if (!TX.test(v) && !ADDR.test(v)) { say(MSG.invalid_input, true); input.focus(); return; }
  const body = { input: v };
  if (ADDR.test(v)) { body.hours = state.hours; body.role = state.role; }
  const btn = $('button[type=submit]', form);
  btn.disabled = true; say('Opening the case…');
  try {
    const r = await fetch('/api/case', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.id) { location.href = `/case/${encodeURIComponent(j.id)}`; return; }
    const code = j.error || j.code;
    if (r.status === 429) say(`Too many new cases right now — try again in ${j.retryAfterSec ?? 60} s. Existing case links keep working.`, true);
    else say(j.message || MSG[code] || MSG.invalid_input, true);
  } catch { say(MSG.network, true); }
  btn.disabled = false;
});

function focusInput(role) {
  if (role) { state.role = role; press(roleSeg, 'data-role', role); state.forceAddress = true; mode(); placeholder(); }
  $('#fw-hud')?.classList.remove('is-collapsed');
  const top = $('.fw-hero').getBoundingClientRect().top + scrollY;
  if (Math.abs(scrollY - top) > 4) scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  setTimeout(() => input.focus({ preventScroll: true }), 250);
  if (role === 'victim') say('Paste your own wallet. Frostwit lists where your stock tokens and USDG went; the transfer you did not authorise is the one to trace.');
}
document.addEventListener('fw:focus-input', () => focusInput());
document.addEventListener('click', (e) => {
  const f = e.target.closest('[data-fw-focus-input]'); if (f) { e.preventDefault(); focusInput(); return; }
  const m = e.target.closest('[data-fw-mode]'); if (m) { e.preventDefault(); focusInput(m.dataset.fwMode); return; }
  const c = e.target.closest('.fw-copy[data-copy]');
  if (c) { navigator.clipboard?.writeText(c.dataset.copy).then(() => { const t = c.textContent; c.textContent = 'Copied'; setTimeout(() => { c.textContent = t; }, 1200); }).catch(() => {}); }
});

// ---------- menu (390): <details> works without JS; the $FWIT chip opens it too ----------
$('.fw-ca')?.addEventListener('click', () => { const d = $('.fw-menuwrap'); if (matchMedia('(max-width: 720px)').matches && d) d.open = true; });

// ---------- bottom sheet (390): swipe down to 20 %, never hides the input on first load ----------
const hud = $('#fw-hud'), grip = $('.fw-intake__grip');
grip?.addEventListener('click', () => hud.classList.toggle('is-collapsed'));
let sy = null;
form.addEventListener('touchstart', (e) => { if (form.scrollTop <= 0) sy = e.touches[0].clientY; }, { passive: true });
form.addEventListener('touchmove', (e) => {
  if (sy == null) return; const dy = e.touches[0].clientY - sy;
  if (dy > 60 && !hud.classList.contains('is-collapsed')) { hud.classList.add('is-collapsed'); sy = null; }
  else if (dy < -40 && hud.classList.contains('is-collapsed')) { hud.classList.remove('is-collapsed'); sy = null; }
}, { passive: true });
form.addEventListener('touchend', () => { sy = null; });
input.addEventListener('focus', () => hud.classList.remove('is-collapsed'));

// ---------- HUD tilt ≤ 3° (desktop, no reduced motion) ----------
if (matchMedia('(pointer: fine) and (min-width: 721px)').matches && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const card = form; let tx = 0, ty = 0, gx = 0, gy = 0, raf = 0;
  const loop = () => {
    tx += (gx - tx) * 0.08; ty += (gy - ty) * 0.08;
    card.style.setProperty('--tx', tx.toFixed(3) + 'deg'); card.style.setProperty('--ty', ty.toFixed(3) + 'deg');
    raf = Math.abs(gx - tx) + Math.abs(gy - ty) > 0.002 ? requestAnimationFrame(loop) : 0;
  };
  addEventListener('pointermove', (e) => {
    if (scrollY > innerHeight) return;
    gx = -((e.clientY / innerHeight) - 0.5) * 2 * 3 * 0.6; gy = ((e.clientX / innerWidth) - 0.5) * 2 * 3;
    if (!raf) raf = requestAnimationFrame(loop);
  }, { passive: true });
}

// ---------- live numbers + CA slot ----------
function renderStats(s) {
  const el = $('[data-fw-stats]'); if (!el || !s) return;
  if (s.backfillDone === false && !s.blockedNow) { el.textContent = 'indexing registry events…'; return; }
  const last = toSec(s.lastActionAt ?? s.lastAction?.time);
  const parts = [`<span data-k="blocked">${Number(s.blockedNow).toLocaleString('en-US')}</span> addresses blocked by Robinhood's registry`];
  if (Number.isFinite(last)) parts.push(`last action <span data-k="last">${day(last)}</span> UTC`);
  if (Number(s.casesTotal) >= 3) parts.push(`<span data-k="cases">${Number(s.casesTotal).toLocaleString('en-US')}</span> cases traced`);
  const short = [`<span data-k="blocked">${Number(s.blockedNow).toLocaleString('en-US')}</span> addresses blocked`];
  if (Number.isFinite(last)) short.push(`last action ${day(last).replace(/ \d{4}$/, '')} UTC`);
  el.innerHTML = `<span class="fw-stats-long">${parts.join(' · ')}</span><span class="fw-stats-short">${short.join(' · ')}</span>`;
}
function renderCA(t) {
  if (!t || !t.launched || !/^0x[0-9a-fA-F]{40}$/.test(t.ca || '') || /^0x0{40}$/.test(t.ca)) return;
  const el = $('[data-fw-ca]');
  const buy = t.buyUrl ? `<a class="fw-btn" href="${t.buyUrl}" rel="noopener" target="_blank">Buy on Pons</a>` : '';
  el.innerHTML = `<span class="fw-ca__sym">$${t.symbol || 'FWIT'}</span><span class="fw-ca__addr fw-mono" title="${t.ca}">${t.ca}</span><button class="fw-copy" type="button" data-copy="${t.ca}">Copy</button>${buy}`;
  const d = $('.fw-drawer__ca'); if (d) d.innerHTML = `$${t.symbol || 'FWIT'} · <span class="fw-addr">${t.ca}</span>`;
}

// ---------- scene ----------
async function boot() {
  const [stats, acts] = await Promise.allSettled([getJSON('/api/stats'), getJSON('/api/issuer-actions?limit=400')]);
  const s = stats.status === 'fulfilled' ? stats.value : null;
  const a = acts.status === 'fulfilled' ? acts.value : null;
  renderStats(s ? { ...s, backfillDone: s.backfillDone ?? a?.backfillDone } : a && { blockedNow: a.blockedNow, lastAction: a.lastAction, backfillDone: a.backfillDone });
  renderCA(s?.token);
  if (!a || !Array.isArray(a.events)) return; // poster stays; SSR text carries the proof
  const events = a.events.map((e) => ({ ...e, time: toSec(e.time) }));
  const head = Number(a.head ?? s?.head ?? a.lastAction?.block ?? Math.max(...events.map((e) => Number(e.block))));
  const mobile = matchMedia('(max-width: 720px)').matches;
  const scene = mountScene($('#fw-scene'), {
    kind: 'timeline', events, head, blockedNow: a.blockedNow ?? s?.blockedNow, batch: a.batch,
    // head time: from the API when given, else estimated from the last event at 9.7 blocks/s (never 'now' by assumption)
    headTime: toSec(a.headTime ?? s?.headTime) || (Number.isFinite(toSec(a.lastAction?.time)) ? toSec(a.lastAction.time) + (head - Number(a.lastAction.block)) / 9.7 : undefined),
  }, {
    railEl: $('#fw-rail'), interactive: true, pan: false,
    region: { l: 0.42, r: 0.925, t: 0.31, b: 0.855 }, mobileRegion: { l: 0.08, r: 0.92, t: 0.17, b: 0.385 }, pinTop: mobile ? 104 : 72, mobilePins: 2, pinMargin: Math.max(24, (innerWidth - 1280) / 2),
  });
  // 390: when the intake sheet is swiped down, the scene refits into the space it frees
  const REG_OPEN = { l: 0.07, r: 0.93, t: 0.17, b: 0.385 }, REG_COLLAPSED = { l: 0.07, r: 0.93, t: 0.17, b: 0.62 };
  new MutationObserver(() => { if (matchMedia('(max-width: 720px)').matches) scene.setRegion(hud.classList.contains('is-collapsed') ? REG_COLLAPSED : REG_OPEN); })
    .observe(hud, { attributes: true, attributeFilter: ['class'] });
}
boot().catch((e) => console.warn('[frostwit]', e));
export { fmtTime };
