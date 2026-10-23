/* Lotus Bus — shared-state sync API (Cloudflare Pages Function + D1).
   The app state is stored as small JSON documents: one row per (collection k, item id).
   GET  /api/sync?since=N   -> documents changed after sequence N (plus the server clock)
   POST /api/sync           -> { ops: [{k, id, j} | {k, id, del:1}], reset?: true }
   Every write gets a new, strictly increasing sequence number `t`; deletes are kept as tombstones (d=1)
   so every device can learn about them. Last write wins per document.
   NOTE: demo-grade — no login yet, anyone who can reach the site can read/write the demo data. */

const COLLECTIONS = new Set(['trips', 'pickups', 'myBookings', 'sharedLinks', 'notifications', 'reports', 'chat', 'policies', '_meta']);
const MAX_OPS = 400;
const MAX_DOC = 20000;
const NEXT_T = '(SELECT COALESCE(MAX(t), 0) + 1 FROM docs)';

let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db.batch([
      db.prepare('CREATE TABLE IF NOT EXISTS docs (k TEXT NOT NULL, id TEXT NOT NULL, j TEXT NOT NULL DEFAULT \'\', t INTEGER NOT NULL, d INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (k, id))'),
      db.prepare('CREATE INDEX IF NOT EXISTS docs_t ON docs (t)'),
    ]).catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

export async function onRequest({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'database binding missing' }, 503);
  try {
    await ensureSchema(db);
    const url = new URL(request.url);

    if (request.method === 'GET') {
      const since = Math.max(0, parseInt(url.searchParams.get('since') || '0', 10) || 0);
      const sql = since === 0
        ? 'SELECT k, id, j, t, d FROM docs WHERE d = 0 ORDER BY t LIMIT 4000'
        : 'SELECT k, id, j, t, d FROM docs WHERE t > ?1 ORDER BY t LIMIT 4000';
      const stmt = since === 0 ? db.prepare(sql) : db.prepare(sql).bind(since);
      const { results } = await stmt.all();
      return json({ now: Date.now(), docs: results || [] });
    }

    if (request.method === 'POST') {
      const origin = request.headers.get('origin');
      if (origin && new URL(origin).host !== url.host) return json({ error: 'forbidden' }, 403);
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
      const ops = Array.isArray(body && body.ops) ? body.ops : null;
      if (!ops || ops.length > MAX_OPS) return json({ error: 'bad ops' }, 400);

      const stmts = [];
      if (body.reset === true) {
        stmts.push(db.prepare(`UPDATE docs SET d = 1, j = '', t = ${NEXT_T} WHERE d = 0`));
      }
      for (const o of ops) {
        if (!o || !COLLECTIONS.has(o.k) || typeof o.id !== 'string' || !o.id || o.id.length > 80) return json({ error: 'bad op' }, 400);
        if (o.del) {
          stmts.push(db.prepare(`UPDATE docs SET d = 1, j = '', t = ${NEXT_T} WHERE k = ?1 AND id = ?2`).bind(o.k, o.id));
        } else {
          if (typeof o.j !== 'string' || o.j.length > MAX_DOC) return json({ error: 'bad doc' }, 400);
          stmts.push(db.prepare(
            `INSERT INTO docs (k, id, j, t, d) VALUES (?1, ?2, ?3, ${NEXT_T}, 0)
             ON CONFLICT (k, id) DO UPDATE SET j = excluded.j, d = 0, t = ${NEXT_T}`
          ).bind(o.k, o.id, o.j));
        }
      }
      if (stmts.length) await db.batch(stmts);
      return json({ ok: true, n: stmts.length });
    }

    return json({ error: 'method not allowed' }, 405);
  } catch (e) {
    return json({ error: 'server error', detail: String(e && e.message || e) }, 500);
  }
}
