// LANDING Playwright spec (BRIEF §9.3), Chromium. Not part of `npm test` (playwright is not a repo dependency).
// Run:  node web/src/scene/dev/serve.mjs 4899 &   then
//       PW=/path/to/node_modules/playwright node web/src/scene/dev/scene.spec.mjs [baseUrl]
// Checks: scene mounts on the timeline (/) and on the case fixture (/dev/case.html) without console errors;
// scrubbing to the second hop shows exactly the edges with block ≤ T (GL strings and hop-table rows);
// the lens callout names the same address as the highlighted hop-table rows; with the GPU disabled and with
// reduced motion the poster + rail render and the as-of panel still updates on scrub.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW || 'playwright');
const base = process.argv[2] || 'http://localhost:4899';
const GL = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const ignorable = (t) => /GL Driver Message|GPU stall|WebGL-0x/.test(t);
let pass = 0;
const ok = (name) => { pass++; console.log('ok -', name); };

async function page(browser, url, ctxOpts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...ctxOpts });
  const p = await ctx.newPage();
  const errors = [];
  p.on('console', (m) => { if (m.type() === 'error' && !ignorable(m.text())) errors.push(m.text()); });
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(base + url, { waitUntil: 'load' });
  await p.mouse.move(700, 450); // first interaction → the scene loads
  return { p, ctx, errors };
}
const waitGl = (p) => p.waitForFunction(() => document.querySelector('.fw-scene')?.dataset.mode === 'gl', null, { timeout: 15000 });

const browser = await chromium.launch({ args: GL });
try {
  // 1. timeline on the landing
  {
    const { p, ctx, errors } = await page(browser, '/');
    await waitGl(p); await p.waitForTimeout(800);
    assert.deepEqual(errors, []);
    const st = await p.evaluate(() => document.querySelector('.fw-scene').fwScene.glStats());
    assert.ok(st.crystals >= 4 && st.crystalsOn === st.crystals);
    ok('timeline scene mounts in GL without console errors');
    await p.focus('.fw-rail__track'); await p.keyboard.press('Home'); await p.keyboard.press('ArrowRight'); await p.waitForTimeout(300);
    const r = await p.evaluate(() => { const s = document.querySelector('.fw-scene').fwScene; const T = s.block; const L = s.layout;
      const ids = new Set(L.nodes.map((n) => n.id)); return { T, want: L.edges.filter((e) => e.block <= T && ids.has(e.from) && ids.has(e.to) && e.from !== e.to).length, on: s.glStats().stringsOn, grown: s.glStats().crystalsOn, nodesUpTo: L.nodes.filter((n) => n.firstBlock <= T).length }; });
    assert.equal(r.on, r.want); assert.equal(r.grown, r.nodesUpTo);
    ok(`timeline scrub to the second stop (block ${r.T}): ${r.on} strings, ${r.grown} crystals = data with block ≤ T`);
    await ctx.close();
  }
  // 2. graph on the case fixture
  {
    const { p, ctx, errors } = await page(browser, '/dev/case.html');
    await waitGl(p); await p.waitForTimeout(800);
    assert.deepEqual(errors, []);
    ok('case graph scene mounts in GL without console errors');
    await p.focus('.fw-rail__track'); await p.keyboard.press('Home'); await p.keyboard.press('ArrowRight'); await p.keyboard.press('ArrowRight'); await p.waitForTimeout(300);
    const r = await p.evaluate(() => { const s = document.querySelector('.fw-scene').fwScene; const T = s.block; const L = s.layout; const ids = new Set(L.nodes.map((n) => n.id));
      const rows = [...document.querySelectorAll('#hops tbody tr')]; return { T, on: s.glStats().stringsOn, want: L.edges.filter((e) => e.block <= T && ids.has(e.from) && ids.has(e.to) && e.from !== e.to).length,
        rowsShown: rows.filter((tr) => !tr.hidden).length, rowsWant: rows.filter((tr) => Number(tr.dataset.block) <= T).length }; });
    assert.equal(r.on, r.want); assert.equal(r.rowsShown, r.rowsWant);
    ok(`graph scrub to the second hop (block ${r.T}): ${r.on} strings drawn, ${r.rowsShown} hop rows shown, all with block ≤ T`);
    await p.keyboard.press('End'); await p.waitForTimeout(600);
    // lens: open on the first pinned holder, compare with the hop rows it highlights
    const pin = (await p.$$('.fw-pin'))[0]; const bx = await pin.boundingBox();
    await p.mouse.click(bx.x + 10, bx.y + 10); await p.waitForTimeout(400);
    const l = await p.evaluate(() => ({ title: document.querySelector('.fw-callout .fw-callout__title')?.textContent.trim(), rows: [...document.querySelectorAll('#hops tbody tr.is-lens')].map((tr) => tr.textContent) }));
    assert.ok(l.title && l.rows.length > 0, 'lens opened and highlighted hop rows');
    assert.ok(l.rows.every((t) => t.includes(l.title)), `every highlighted row names ${l.title}`);
    ok(`lens callout (${l.title}) matches ${l.rows.length} highlighted hop-table rows`);
    await ctx.close();
  }
  // 3. no GPU and reduced motion: poster + rail + as-of panel
  for (const [label, launchArgs, ctxOpts] of [['no GPU / no WebGL', ['--disable-gpu', '--disable-webgl'], {}], ['reduced motion', GL, { reducedMotion: 'reduce' }]]) {
    const b2 = await chromium.launch({ args: launchArgs });
    const ctx = await b2.newContext({ viewport: { width: 390, height: 844 }, ...ctxOpts }); const p = await ctx.newPage();
    const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(base + '/dev/case.html', { waitUntil: 'load' }); await p.mouse.move(100, 100); await p.waitForTimeout(4500);
    const st = await p.evaluate(() => ({ mode: document.querySelector('.fw-scene').dataset.mode, poster: !!document.querySelector('.fw-scene__poster')?.naturalWidth, rail: !!document.querySelector('.fw-rail__track'), rows: document.querySelectorAll('#asof tbody tr').length, canvas: !!document.querySelector('canvas') }));
    assert.equal(st.mode, 'poster'); assert.ok(st.poster && st.rail && !st.canvas); assert.deepEqual(errors, []);
    await p.focus('.fw-rail__track'); await p.keyboard.press('Home'); await p.keyboard.press('ArrowRight'); await p.waitForTimeout(200);
    const after = await p.evaluate(() => ({ head: document.getElementById('asof-h').textContent, rows: document.querySelectorAll('#asof tbody tr').length }));
    assert.ok(/as of block/i.test(after.head) && after.rows !== st.rows);
    ok(`${label}: poster + rail render, no canvas, as-of panel updates on scrub (${st.rows} → ${after.rows} rows)`);
    await b2.close();
  }
  console.log(`\n${pass} passed`);
} catch (e) { console.error('FAIL:', e.message); process.exitCode = 1; } finally { await browser.close(); }
