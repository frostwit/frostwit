import { loadConfig, makeTokenReader } from './config.mjs';
import { openDb } from './db.mjs';
import { createService, buildRuntime } from './service.mjs';
import { buildApp } from './app.mjs';
import { createImages } from './og.mjs';

const cfg = loadConfig();
const log = (...a) => console.log(new Date().toISOString(), ...a);
const db = openDb(cfg.stateDir);
const getToken = makeTokenReader(cfg.tokenJson);
const { lane, chain, ctx } = buildRuntime(cfg, { dbApi: db, getToken, log });
const svc = createService({ cfg, db, chain, lane, ctx, getToken, log });
await svc.loadSeed();
const images = await createImages({ log });
const app = buildApp({ cfg, svc, db, ctx, getToken, images, log });
await app.listen({ port: cfg.port, host: cfg.host });
log(`frostwit listening on ${cfg.host}:${cfg.port}`);
// requeue anything that was tracing when the process stopped
for (const r of db.queuedCases()) if (r.status === 'tracing') db.updateCase(r.id, { status: 'queued' });
svc.start();
// warm the landing poster so the first visitor does not pay the render
setTimeout(async () => { try { const d = svc.issuerActions(500); await images.posterTimeline({ events: [...d.events].sort((x, y) => x.block - y.block || x.log_index - y.log_index), head: d.head || d.lastAction?.block, blockedNow: d.blockedNow, batch: d.batch }, {}); log('timeline poster warm'); } catch (e) { log('warm failed', e.message); } }, 3000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { svc.stop(); await app.close(); db.close(); process.exit(0); });
