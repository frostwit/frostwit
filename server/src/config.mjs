import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const env = process.env;
export function loadConfig(over = {}) {
  const c = {
    port: Number(env.PORT || 4830), host: env.HOST || '127.0.0.1',
    stateDir: env.STATE_DIR || path.join(ROOT, 'state'),
    rpcUrl: env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
    tokenJson: env.TOKEN_JSON || path.join(ROOT, 'web/token.json'),
    knownJson: env.KNOWN_JSON || path.join(ROOT, 'data/known.json'),
    stocksJson: env.STOCKS_JSON || path.join(ROOT, 'data/stocks-rc.json'),
    issuerSeed: env.ISSUER_SEED || path.join(ROOT, 'data/issuer-seed.json'),
    distDir: env.DIST_DIR || path.join(ROOT, 'web/dist'),
    siteUrl: (env.SITE_URL || 'https://frostwit.pro').replace(/\/$/, ''),
    minHold: BigInt(env.MIN_HOLD || 1_000_000),
    // timings (overridable in tests)
    traceCapPerIpHour: 10, traceCapGlobalHour: 40, tailEveryMs: 5 * 60_000, watchEveryMs: 60_000, healthEveryMs: Number(env.HEALTH_EVERY_MS || 60_000),
    publicCadenceSec: 15 * 60, priorityCadenceSec: 2 * 60, watchDays: 7, priorityDays: 30,
    staging: env.STAGING === '1',
    startLoops: true, ...over,
  };
  return c;
}
export function readJson(f, fallback) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } }
// token.json re-read every 60 s; unlaunched must never expose the zero address
export function makeTokenReader(file, ttlMs = 60_000) {
  let cache = null, at = 0;
  return () => {
    if (!cache || Date.now() - at > ttlMs) { cache = readJson(file, { symbol: 'FWIT', ca: '0x0000000000000000000000000000000000000000', launched: false, tickerPublic: true, teamWallet: '', minHold: 1000000, launchDate: '2026-11-05T15:00:00Z', x: 'https://x.com/frostwitRH' }); at = Date.now(); }
    return cache;
  };
}
export const publicToken = (t) => ({ symbol: t.symbol, launched: !!t.launched, ca: t.launched ? t.ca : null, tickerPublic: !!t.tickerPublic, teamWallet: t.teamWallet || null, minHold: t.minHold, launchDate: t.launchDate, launchedAt: t.launchedAt || null, x: t.x });
