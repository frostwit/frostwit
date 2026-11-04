import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, makeTokenReader, ROOT } from '../src/config.mjs';
import { openDb } from '../src/db.mjs';
import { createService } from '../src/service.mjs';
import { buildApp } from '../src/app.mjs';
import { MockChain, ctx } from '../../shared/trace/test/mock-chain.mjs';

export function makeEnv({ token, over = {}, head = 105_000_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-'));
  const tokenFile = path.join(dir, 'token.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ symbol: 'FWIT', ca: '0x0000000000000000000000000000000000000000', launched: false, tickerPublic: true, teamWallet: '0x427Bf5976Ffb7C99aeaA5C608793D1c8997B6F19', minHold: 1000000, launchDate: '2026-11-05T15:00:00Z', x: 'https://x.com/frostwitRH', ...token }));
  const cfg = loadConfig({ stateDir: dir, tokenJson: tokenFile, distDir: path.join(ROOT, 'web/dist'), issuerSeed: path.join(ROOT, 'data/issuer-seed.json'), startLoops: false, ...over });
  const db = openDb(dir), getToken = makeTokenReader(tokenFile, -1);
  const chain = new MockChain({ head });
  const lane = { state: () => ({ inFlight: 0, queued: 0, pausedSec: 0, callsLastMin: 0 }) };
  const svc = createService({ cfg, db, chain, lane, ctx, getToken });
  const images = { load: async () => false, ready: () => false, ogCase: async () => null, posterGraph: async () => null, posterTimeline: async () => null };
  const app = buildApp({ cfg, svc, db, ctx, getToken, images });
  return { cfg, db, chain, svc, app, dir, tokenFile, close: async () => { await app.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
export const post = (app, url, payload, ip = '10.0.0.1') => app.inject({ method: 'POST', url, payload, remoteAddress: ip, headers: { 'content-type': 'application/json' } });
