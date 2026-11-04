// node scripts/smoke.mjs [base=https://frostwit.pro]  Checks the live site from any machine.
const base = process.argv[2] || 'https://frostwit.pro'; let bad = 0;
const t = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { bad++; console.log('FAIL', name, e.message); } };
const get = async (p) => { const r = await fetch(base + p); if (!r.ok) throw new Error(p + ' ' + r.status); return r; };
await t('health', async () => { const j = await (await get('/api/health')).json(); if (!j.ok || !j.backfillDone) throw new Error(JSON.stringify(j)); });
await t('issuer pair', async () => { const j = await (await get('/api/issuer-actions?limit=500')).json(); const s = JSON.stringify(j.events); if (!s.includes('0x217695758a019ca28bfd82f9fdef442cf5628074162bcdc4fc0fdf4a1aecadc3') || !s.includes('0x8b9b17bb409c7fa5803b66cf2782882a15cb08cd342dbe95506694a77730fb0c')) throw new Error('2 Nov pair missing'); });
await t('stats', async () => { const j = await (await get('/api/stats')).json(); if (!(j.blockedNow > 0)) throw new Error('blockedNow'); });
for (const p of ['/', '/issuer-actions', '/what-to-do', '/docs', '/token', '/llms.txt', '/api', '/dist/styles.css', '/og.jpg']) await t(p, () => get(p));
await t('no zero CA pre-launch', async () => { const j = await (await get('/token.json')).json(); if (!j.launched && j.ca) throw new Error('ca set'); });
process.exit(bad ? 1 : 0);
