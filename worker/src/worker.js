import { SessionDO } from "./session_do.js";

function corsHeaders(origin, allowedOrigin) {
  const h = new Headers();
  h.set("access-control-allow-methods", "GET,POST,OPTIONS");
  h.set("access-control-allow-headers", "content-type");
  h.set("access-control-max-age", "86400");

  if (!allowedOrigin || allowedOrigin === "*") {
    h.set("access-control-allow-origin", origin || "*");
  } else {
    h.set("access-control-allow-origin", allowedOrigin);
  }
  return h;
}

function json(body, { status = 200, cors } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (cors) {
    for (const [k, v] of cors.entries()) headers.set(k, v);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export { SessionDO };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") || "";
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Healthcheck
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json({ ok: true }, { cors });
    }

    // Create new session
    if (request.method === "POST" && url.pathname === "/api/session/new") {
      if (!env.SESSION_DO) {
        return json({ error: "SESSION_DO binding missing" }, { status: 500, cors });
      }
      const id = env.SESSION_DO.newUniqueId();
      const stub = env.SESSION_DO.get(id);
      await stub.fetch("https://do/init", { method: "POST" });
      return json({ sessionId: id.toString() }, { cors });
    }

    // Reset session
    if (request.method === "POST" && url.pathname === "/api/session/reset") {
      const payload = await request.json().catch(() => null); 
      const sid = (payload?.sessionId || "").toString();
      if (!sid) return json({ error: "Missing sessionId" }, { status: 400, cors });

      const id = env.SESSION_DO.idFromString(sid);
      const stub = env.SESSION_DO.get(id);
      await stub.fetch("https://do/reset", { method: "POST" });
      return json({ ok: true }, { cors });
    }

    // Chat
    if (request.method === "POST" && url.pathname === "/api/chat") {
      const payload = await request.json().catch(() => null);
      const sid = (payload?.sessionId || "").toString();
      const message = (payload?.message || "").toString();
      const systemPrompt = (payload?.systemPrompt || "").toString();

      if (!sid) return json({ error: "Missing sessionId" }, { status: 400, cors });
      if (!message.trim()) return json({ error: "Missing message" }, { status: 400, cors });
      if (!systemPrompt.trim()) return json({ error: "Missing systemPrompt" }, { status: 400, cors });

      const id = env.SESSION_DO.idFromString(sid);
      const stub = env.SESSION_DO.get(id);

      const r = await stub.fetch("https://do/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, systemPrompt }),
      });

      const out = await r.json().catch(() => ({}));
      return json(out, { status: r.status, cors });
    }

    return json({ error: "NotFound" }, { status: 404, cors });
  },
};
