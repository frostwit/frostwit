import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'frostwit.db'));
  db.pragma('journal_mode = WAL'); db.pragma('synchronous = NORMAL'); db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, hours INTEGER, since_block INTEGER, created_at INTEGER NOT NULL,
      status TEXT NOT NULL, graph_json TEXT, rpc_calls INTEGER DEFAULT 0, last_check_at INTEGER, last_check_block INTEGER,
      watch_until INTEGER, priority_until INTEGER, priority_holder TEXT, error TEXT, finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS cases_status ON cases(status);
    CREATE TABLE IF NOT EXISTS checks (case_id TEXT NOT NULL, at INTEGER NOT NULL, block INTEGER, freezable_json TEXT, diff_json TEXT);
    CREATE INDEX IF NOT EXISTS checks_case ON checks(case_id, at);
    CREATE TABLE IF NOT EXISTS rpc_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL, exp INTEGER);
    CREATE TABLE IF NOT EXISTS issuer_events (
      block INTEGER NOT NULL, tx TEXT NOT NULL, log_index INTEGER NOT NULL, kind TEXT NOT NULL, address TEXT NOT NULL, operator TEXT, time INTEGER,
      PRIMARY KEY (tx, log_index)
    );
    CREATE INDEX IF NOT EXISTS ie_address ON issuer_events(address);
    CREATE INDEX IF NOT EXISTS ie_block ON issuer_events(block, log_index);
    CREATE TABLE IF NOT EXISTS holders (address TEXT PRIMARY KEY, fwit_raw TEXT, checked_at INTEGER);
    CREATE TABLE IF NOT EXISTS metrics (day TEXT NOT NULL, key TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, key));
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
  `);
  const q = {
    cacheGet: db.prepare('SELECT value, exp FROM rpc_cache WHERE key = ?'),
    cacheSet: db.prepare('INSERT OR REPLACE INTO rpc_cache(key, value, at, exp) VALUES (?,?,?,?)'),
    cachePrune: db.prepare('DELETE FROM rpc_cache WHERE exp IS NOT NULL AND exp < ?'),
    caseGet: db.prepare('SELECT * FROM cases WHERE id = ?'),
    caseIns: db.prepare('INSERT INTO cases(id, kind, value, hours, created_at, status) VALUES (?,?,?,?,?,\'queued\')'),
    queued: db.prepare('SELECT * FROM cases WHERE status IN (\'queued\',\'tracing\') ORDER BY (status = \'tracing\') DESC, (COALESCE(hours,24) > 24), created_at'),
    watch: db.prepare('SELECT * FROM cases WHERE status IN (\'done\',\'partial\') AND watch_until > ? ORDER BY last_check_at LIMIT 200'),
    checkIns: db.prepare('INSERT INTO checks(case_id, at, block, freezable_json, diff_json) VALUES (?,?,?,?,?)'),
    checks: db.prepare('SELECT at, block, freezable_json, diff_json FROM checks WHERE case_id = ? ORDER BY at DESC LIMIT ?'),
    evIns: db.prepare('INSERT OR IGNORE INTO issuer_events(block, tx, log_index, kind, address, operator, time) VALUES (?,?,?,?,?,?,?)'),
    evUpd: db.prepare('UPDATE issuer_events SET operator = ?, time = ? WHERE tx = ? AND log_index = ?'),
    evAll: db.prepare('SELECT * FROM issuer_events ORDER BY block, log_index'),
    evPage: db.prepare('SELECT * FROM issuer_events WHERE (block < @b OR (block = @b AND log_index < @l)) ORDER BY block DESC, log_index DESC LIMIT @n'),
    evFirst: db.prepare('SELECT * FROM issuer_events ORDER BY block DESC, log_index DESC LIMIT ?'),
    evAddr: db.prepare('SELECT * FROM issuer_events WHERE address = ? ORDER BY block, log_index'),
    evPending: db.prepare('SELECT * FROM issuer_events WHERE operator IS NULL OR time IS NULL LIMIT 50'),
    evMax: db.prepare('SELECT MAX(block) AS b, COUNT(*) AS n FROM issuer_events'),
    blockedNow: db.prepare(`SELECT COUNT(*) AS n FROM (SELECT address, kind, ROW_NUMBER() OVER (PARTITION BY address ORDER BY block DESC, log_index DESC) AS r FROM issuer_events) WHERE r = 1 AND kind = 'blocked'`),
    evLastBlocked: db.prepare(`SELECT tx FROM issuer_events WHERE address = ? AND kind = 'blocked' ORDER BY block DESC, log_index DESC LIMIT 1`),
    metric: db.prepare('INSERT INTO metrics(day, key, count) VALUES (?,?,1) ON CONFLICT(day, key) DO UPDATE SET count = count + 1'),
    kvGet: db.prepare('SELECT value FROM kv WHERE key = ?'), kvSet: db.prepare('INSERT OR REPLACE INTO kv(key, value) VALUES (?,?)'),
    holderGet: db.prepare('SELECT * FROM holders WHERE address = ?'), holderSet: db.prepare('INSERT OR REPLACE INTO holders(address, fwit_raw, checked_at) VALUES (?,?,?)'),
    holders: db.prepare('SELECT * FROM holders'),
    countCases: db.prepare(`SELECT COUNT(*) AS n FROM cases WHERE status IN ('done','partial')`),
    countToday: db.prepare(`SELECT COUNT(*) AS n FROM cases WHERE status IN ('done','partial') AND created_at >= ?`),
    openGraphs: db.prepare(`SELECT graph_json FROM cases WHERE status IN ('done','partial') AND graph_json IS NOT NULL ORDER BY created_at DESC LIMIT 300`),
    recentCases: db.prepare(`SELECT id, kind, value, status, created_at FROM cases WHERE status IN ('done','partial') ORDER BY created_at DESC LIMIT ?`),
  };
  const now = () => Math.floor(Date.now() / 1000);
  const api = {
    raw: db, q, close: () => db.close(),
    // rpc cache for the Lane
    cache: {
      get(key) { const r = q.cacheGet.get(key); if (!r) return undefined; if (r.exp != null && r.exp < Date.now() / 1000) return undefined; return r.value; },
      set(key, value, ttl) { q.cacheSet.run(key, value, now(), ttl === 'forever' || ttl == null ? null : now() + ttl); },
    },
    pruneCache() { return q.cachePrune.run(now()).changes; },
    getCase: (id) => q.caseGet.get(id), insertCase: (c) => q.caseIns.run(c.id, c.kind, c.value, c.hours ?? null, now()),
    updateCase(id, fields) {
      const keys = Object.keys(fields); if (!keys.length) return;
      db.prepare(`UPDATE cases SET ${keys.map((k) => k + ' = @' + k).join(', ')} WHERE id = @id`).run({ ...fields, id });
    },
    queuedCases: () => q.queued.all(), watchCandidates: () => q.watch.all(now()),
    insertCheck: (id, at, block, fz, diff) => q.checkIns.run(id, at, block, JSON.stringify(fz), JSON.stringify(diff)),
    listChecks: (id, n = 50) => q.checks.all(id, n).map((r) => ({ at: r.at, block: r.block, freezable: JSON.parse(r.freezable_json || '[]'), diff: JSON.parse(r.diff_json || '[]') })),
    insertEvent: (e) => q.evIns.run(e.block, e.tx, e.log_index, e.kind, e.address, e.operator ?? null, e.time ?? null),
    insertEvents: db.transaction((evs) => { for (const e of evs) q.evIns.run(e.block, e.tx, e.log_index, e.kind, e.address, e.operator ?? null, e.time ?? null); }),
    updateEvent: (e) => q.evUpd.run(e.operator, e.time, e.tx, e.log_index),
    allEvents: () => q.evAll.all(), pendingEvents: () => q.evPending.all(),
    eventsPage(limit, cursor) { if (!cursor) return q.evFirst.all(limit); const [b, l] = cursor.split(':').map(Number); return q.evPage.all({ b, l, n: limit }); },
    eventsForAddress: (a) => q.evAddr.all(a), eventsMax: () => q.evMax.get(), blockedNow: () => q.blockedNow.get().n, lastBlockedTx: (a) => q.evLastBlocked.get(a)?.tx ?? null,
    metric: (key) => q.metric.run(new Date().toISOString().slice(0, 10), key),
    kv: (k) => q.kvGet.get(k)?.value, setKv: (k, v) => q.kvSet.run(k, String(v)),
    holder: (a) => q.holderGet.get(a), setHolder: (a, raw) => q.holderSet.run(a, String(raw), now()), allHolders: () => q.holders.all(),
    caseCounts() { const day = Math.floor(Date.now() / 86400000) * 86400; return { total: q.countCases.get().n, today: q.countToday.get(day).n }; },
    openGraphs: () => q.openGraphs.all().map((r) => JSON.parse(r.graph_json)), recentCases: (n = 5) => q.recentCases.all(n),
  };
  return api;
}
