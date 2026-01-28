import { SessionDO } from "./session_do.js";

function corsHeaders(origin, allowedOrigin) {
  const h = new Headers();
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "content-type");
  h.set("Access-Control-Max-Age", "86400");

  // Se non specifichi ALLOWED_ORIGIN, permette l'origin corrente
  // (utile in dev). In prod conviene mettere un origin fisso.
  if (!allowedOrigin || allowedOrigin === "*") {
    h.set("Access-Control-Allow-Origin", origin || "*");
  } else {
    h.set("Access-Control-Allow-Origin", allowedOrigin);
  }

  // opzionale ma utile: evita cache mischiata tra origin diversi
  h.set("Vary", "Origin");
  return h;
}

function json(body, { status = 200, cors } = {}) {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  if (cors) {
    for (const [k, v] of cors.entries()) headers.set(k, v);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

async function verifyTurnstile(token, ip, env) {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) throw new Error("Missing TURNSTILE_SECRET_KEY");

  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);

  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });

  const out = await r.json().catch(() => ({}));
  return out; // { success: boolean, ... }
}

export { SessionDO };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") || "";
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

    // 1) Preflight CORS (DEVE rispondere sempre)
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // 2) Tutto il resto: proteggi con try/catch così anche i 500 hanno CORS
    try {
      if (request.method === "GET" && url.pathname === "/api/version") {
        return json({ version: "GITHUB_V2" }, { cors });
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
        const turnstileToken = (payload?.turnstileToken || "").toString();

        if (!sid) return json({ error: "Missing sessionId" }, { status: 400, cors });
        if (!message.trim()) return json({ error: "Missing message" }, { status: 400, cors });
        if (!systemPrompt.trim()) return json({ error: "Missing systemPrompt" }, { status: 400, cors });

        if (!turnstileToken) {
          return json({ error: "Missing turnstileToken" }, { status: 403, cors });
        }

        const ip =
          request.headers.get("CF-Connecting-IP") ||
          request.headers.get("x-forwarded-for") ||
          "";

        const ts = await verifyTurnstile(turnstileToken, ip, env);
        if (!ts?.success) {
          return json({ error: "Turnstile failed" }, { status: 403, cors });
        }

        if (!env.SESSION_DO) {
          return json({ error: "SESSION_DO binding missing" }, { status: 500, cors });
        }

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
    } catch (e) {
      // IMPORTANT: anche gli errori devono avere CORS, altrimenti il browser li blocca come CORS
      return json({ error: String(e?.message || e) }, { status: 500, cors });
    }
  },
};
