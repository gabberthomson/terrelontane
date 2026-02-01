import { SessionDO } from "./session_do.js";

// =======================================================
// IndexDO: indice centrale delle sessioni (per cleanup 24h)
// =======================================================
export class IndexDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    this.state.blockConcurrencyWhile(async () => {
      this.state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          sessionId TEXT PRIMARY KEY,
          createdAt INTEGER NOT NULL,
          lastAccessAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_lastAccess ON sessions(lastAccessAt);
      `);
    });
  }

  _now() { return Date.now(); }

  _json(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/register") {
      const p = await request.json().catch(() => null);
      const sid = (p?.sessionId || "").toString();
      if (!sid) return this._json({ error: "Missing sessionId" }, 400);

      const now = this._now();
      // createdAt: se esiste già lo mantieni, altrimenti now
      this.state.storage.sql.exec(
        "INSERT OR REPLACE INTO sessions(sessionId, createdAt, lastAccessAt) VALUES (?1, COALESCE((SELECT createdAt FROM sessions WHERE sessionId=?1), ?2), ?3)",
        sid, now, now
      );
      return this._json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/touch") {
      const p = await request.json().catch(() => null);
      const sid = (p?.sessionId || "").toString();
      if (!sid) return this._json({ error: "Missing sessionId" }, 400);

      this.state.storage.sql.exec(
        "UPDATE sessions SET lastAccessAt=?2 WHERE sessionId=?1",
        sid, this._now()
      );
      return this._json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/remove") {
      const p = await request.json().catch(() => null);
      const sid = (p?.sessionId || "").toString();
      if (!sid) return this._json({ error: "Missing sessionId" }, 400);

      this.state.storage.sql.exec("DELETE FROM sessions WHERE sessionId=?1", sid);
      return this._json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/expired") {
      const p = await request.json().catch(() => null);
      const cutoff = Number(p?.cutoff ?? 0);
      if (!Number.isFinite(cutoff) || cutoff <= 0) return this._json({ error: "Invalid cutoff" }, 400);

      const limit = Math.max(1, Math.min(parseInt(p?.limit ?? "200", 10) || 200, 1000));
      const cur = this.state.storage.sql.exec(
        "SELECT sessionId, lastAccessAt FROM sessions WHERE lastAccessAt < ?1 ORDER BY lastAccessAt ASC LIMIT ?2",
        cutoff, limit
      );
      return this._json({ sessions: cur.toArray() });
    }

    return this._json({ error: "NotFound" }, 404);
  }
}

export { SessionDO };


// ===========================
// CORS helpers
// ===========================
function corsHeaders(origin, allowedOrigin) {
  const h = new Headers();
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "content-type");
  h.set("Access-Control-Max-Age", "86400");
  h.set("Vary", "Origin");

  if (!allowedOrigin || allowedOrigin === "*") {
    h.set("Access-Control-Allow-Origin", origin || "*");
  } else {
    h.set("Access-Control-Allow-Origin", allowedOrigin);
  }
  return h;
}

function json(body, { status = 200, cors } = {}) {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  if (cors) for (const [k, v] of cors.entries()) headers.set(k, v);
  return new Response(JSON.stringify(body), { status, headers });
}

// ===========================
// IndexDO helpers
// ===========================
function indexStub(env) {
  // Un solo DO indice (per tutto l'account)
  const id = env.INDEX_DO.idFromName("index");
  return env.INDEX_DO.get(id);
}

async function indexRegister(env, sessionId) {
  if (!env.INDEX_DO) return;
  const stub = indexStub(env);
  await stub.fetch("https://do/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
}

async function indexTouch(env, sessionId) {
  if (!env.INDEX_DO) return;
  const stub = indexStub(env);
  await stub.fetch("https://do/touch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
}

async function indexExpired(env, cutoff, limit = 200) {
  if (!env.INDEX_DO) return { sessions: [] };
  const stub = indexStub(env);
  const r = await stub.fetch("https://do/expired", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cutoff, limit }),
  });
  return await r.json().catch(() => ({ sessions: [] }));
}

async function indexRemove(env, sessionId) {
  if (!env.INDEX_DO) return;
  const stub = indexStub(env);
  await stub.fetch("https://do/remove", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
}

// ===========================
// Worker fetch + scheduled
// ===========================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") || "";
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      // New session
      if (request.method === "POST" && url.pathname === "/api/session/new") {
        if (!env.SESSION_DO) return json({ error: "SESSION_DO binding missing" }, { status: 500, cors });

        const id = env.SESSION_DO.newUniqueId();
        const stub = env.SESSION_DO.get(id);

        await stub.fetch("https://do/init", { method: "POST" });

        const sid = id.toString();
        await indexRegister(env, sid);

        return json({ sessionId: sid }, { cors });
      }

      // Reset session
      if (request.method === "POST" && url.pathname === "/api/session/reset") {
        const payload = await request.json().catch(() => null);
        const sid = (payload?.sessionId || "").toString();
        if (!sid) return json({ error: "Missing sessionId" }, { status: 400, cors });

        const id = env.SESSION_DO.idFromString(sid);
        const stub = env.SESSION_DO.get(id);

        await stub.fetch("https://do/reset", { method: "POST" });
        await indexTouch(env, sid);

        return json({ ok: true }, { cors });
      }

      // History
      if (request.method === "POST" && url.pathname === "/api/session/history") {
        const payload = await request.json().catch(() => null);
        const sid = (payload?.sessionId || "").toString();
        const limit = payload?.limit ?? 120;
        const beforeId = payload?.beforeId ?? null;

        if (!sid) return json({ error: "Missing sessionId" }, { status: 400, cors });

        const id = env.SESSION_DO.idFromString(sid);
        const stub = env.SESSION_DO.get(id);

        const r = await stub.fetch("https://do/history", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ limit, beforeId }),
        });

        const out = await r.json().catch(() => ({}));
        await indexTouch(env, sid);

        return json(out, { status: r.status, cors });
      }

      // Chat
      if (request.method === "POST" && url.pathname === "/api/chat") {
        const payload = await request.json().catch(() => null);
        const sid = (payload?.sessionId || "").toString();
        const message = (payload?.message || "").toString();

        if (!sid) return json({ error: "Missing sessionId" }, { status: 400, cors });
        if (!message.trim()) return json({ error: "Missing message" }, { status: 400, cors });

        const id = env.SESSION_DO.idFromString(sid);
        const stub = env.SESSION_DO.get(id);

        const r = await stub.fetch("https://do/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message }),
        });

        const out = await r.json().catch(() => ({}));
        await indexTouch(env, sid);

        return json(out, { status: r.status, cors });
      }

      return json({ error: "NotFound" }, { status: 404, cors });
    } catch (e) {
      return json({ error: String(e?.message || e) }, { status: 500, cors });
    }
  },

  // Cron cleanup: cancella sessioni non usate da > 24h
  async scheduled(event, env, ctx) {
    // Se non hai configurato INDEX_DO, non fai cleanup
    if (!env.INDEX_DO || !env.SESSION_DO) return;

    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - ONE_DAY_MS;

    ctx.waitUntil((async () => {
      // batch massimo per run (se tante sessioni, le pulisci su più run)
      const batch = await indexExpired(env, cutoff, 200);
      const sessions = Array.isArray(batch.sessions) ? batch.sessions : [];

      for (const s of sessions) {
        const sid = (s.sessionId || "").toString();
        if (!sid) continue;

        try {
          const id = env.SESSION_DO.idFromString(sid);
          const stub = env.SESSION_DO.get(id);

          // svuota dati del DO
          await stub.fetch("https://do/destroy", { method: "POST" });

          // rimuovi dall'indice
          await indexRemove(env, sid);
        } catch {
          // se fallisce, ritenterà al prossimo cron
        }
      }
    })());
  },
};