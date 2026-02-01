export class SessionDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    this.state.blockConcurrencyWhile(async () => {
      this.state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS kv (
          k TEXT PRIMARY KEY,
          v TEXT NOT NULL
        );

        -- Log completo della chat (persistente, oltre al summary rolling)
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          role TEXT NOT NULL,   -- 'user' | 'model'
          text TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id);
        CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
      `);

      // Init meta se mancante
      const meta = this._getJSON("meta", null);
      if (!meta) {
        const now = Date.now();
        this._putJSON("meta", { createdAt: now, lastAccessAt: now });
      }
    });
  }

        const SYSTEM_PROMPT = `Sei l’assistente ufficiale del gioco di ruolo “Terre Lontane”.
Per OGNI domanda dell’utente devi seguire questo processo:
Determina la modalità della domanda:
REGOLA → chiarimenti su regole, meccaniche, abilità, oggetti, combattimento, magie, tiri, mostri già esistenti.
IDEE → spunti creativi: avventure, ambientazioni, PNG, nuovi mostri, oggetti inventati.
MISTA → una parte di regole + una parte creativa.
Usa SEMPRE il tool file_search sul manuale di “Terre Lontane” prima di rispondere.
MODALITÀ REGOLA:
Rispondi SOLO usando informazioni presenti negli estratti recuperati con file_search.
NON inventare regole, numeri, eccezioni o interpretazioni.
Se non trovi la risposta negli estratti, dì:
“Questa informazione non è presente nel manuale di Terre Lontane”.
NON proporre house rule.
MODALITÀ IDEE:
Usa gli estratti come canone (tono, ambientazione, meccaniche).
Poi proponi idee pratiche e subito giocabili.
Se fai assunzioni non presenti, dichiaralo.
MODALITÀ MISTA:
Dividi in “Regole” (solo manuale) e “Idee” (creative ma coerenti).`

  // -------------------------
  // KV helpers (come i tuoi)
  // -------------------------
  _getJSON(key, fallback) {
    const cur = this.state.storage.sql.exec(
      "SELECT v FROM kv WHERE k = ?1",
      key
    );
    const rows = cur.toArray();
    if (rows.length === 0) return fallback;

    const v = rows[0]?.v;
    if (typeof v !== "string") return fallback;

    try { return JSON.parse(v); } catch { return fallback; }
  }

  _putJSON(key, value) {
    const v = JSON.stringify(value);
    this.state.storage.sql.exec(
      "INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      key, v
    );
  }

  _del(key) {
    this.state.storage.sql.exec("DELETE FROM kv WHERE k = ?1", key);
  }

  _toInt(v, def) {
    const n = parseInt(v ?? "", 10);
    return Number.isFinite(n) ? n : def;
  }

  // -------------------------
  // Meta / touch
  // -------------------------
  _touch() {
    const now = Date.now();
    const meta = this._getJSON("meta", null);
    if (!meta) {
      this._putJSON("meta", { createdAt: now, lastAccessAt: now });
      return;
    }
    meta.lastAccessAt = now;
    this._putJSON("meta", meta);
  }

  // -------------------------
  // Messages table helpers
  // -------------------------
  _insertMessage(role, text) {
    const ts = Date.now();
    this.state.storage.sql.exec(
      "INSERT INTO messages (ts, role, text) VALUES (?1, ?2, ?3)",
      ts, role, text
    );
  }

  _getMessages(limit, beforeId) {
    const lim = Math.max(1, Math.min(parseInt(limit ?? "120", 10) || 120, 500));

    if (beforeId != null && beforeId !== "") {
      const bid = parseInt(beforeId, 10);
      if (Number.isFinite(bid)) {
        const cur = this.state.storage.sql.exec(
          "SELECT id, ts, role, text FROM messages WHERE id < ?1 ORDER BY id DESC LIMIT ?2",
          bid, lim
        );
        return cur.toArray().reverse();
      }
    }

    const cur = this.state.storage.sql.exec(
      "SELECT id, ts, role, text FROM messages ORDER BY id DESC LIMIT ?1",
      lim
    );
    return cur.toArray().reverse();
  }

  _pruneMessages(maxRows) {
    const max = parseInt(maxRows ?? "", 10);
    if (!Number.isFinite(max) || max <= 0) return;

    // Mantieni solo gli ultimi max messaggi
    this.state.storage.sql.exec(`
      DELETE FROM messages
      WHERE id NOT IN (
        SELECT id FROM messages ORDER BY id DESC LIMIT ${max}
      );
    `);
  }

  _clearAll() {
    this._del("data");
    this._del("meta");
    this.state.storage.sql.exec("DELETE FROM messages");
  }

  // -------------------------
  // Gemini helpers (i tuoi)
  // -------------------------
  _buildGeminiContents(summary, turns) {
    const contents = [];
    if (summary && summary.trim()) {
      contents.push({
        role: "user",
        parts: [{ text: `Contesto sintetico (summary rolling):\n${summary}` }],
      });
    }
    for (const t of turns) contents.push(t);
    return contents;
  }

  async _callGeminiGenerate({ systemInstructionText, contents, useFileSearch, modelOverride }) {
    const apiKey = this.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY secret");
    const storeName = this.env.GEMINI_FILE_SEARCH_STORE_NAME;
    if (useFileSearch && !storeName) throw new Error("Missing GEMINI_FILE_SEARCH_STORE_NAME");

    const model = modelOverride || this.env.GEMINI_MODEL_CHAT || "models/gemini-2.5-flash";

    const body = {
      systemInstruction: { parts: [{ text: systemInstructionText }] },
      contents,
      generationConfig: { temperature: 0.2 },
    };

    if (useFileSearch) {
      body.tools = [{ file_search: { file_search_store_names: [storeName] } }];
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Gemini generateContent failed: ${res.status} ${txt}`);
    }

    const json = await res.json();
    const text =
      json?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") ?? "";
    return text.trim();
  }

  async _maybeRollSummary(data) {
    const trigger = this._toInt(this.env.SUMMARY_TRIGGER_TURNS, 18);
    const keepLast = this._toInt(this.env.SUMMARY_KEEP_LAST_TURNS, 8);

    if (data.turnCount < trigger) return data;
    if (data.turns.length <= keepLast) return data;

    const toSummarize = data.turns.slice(0, data.turns.length - keepLast);
    const remaining = data.turns.slice(data.turns.length - keepLast);

    const chatModel = this.env.GEMINI_MODEL_CHAT || "models/gemini-2.5-flash";
    const summaryModel = this.env.GEMINI_MODEL_SUMMARY || chatModel;

    const summaryPrompt = [
      { role: "user", parts: [{ text: "Riassumi in modo operativo e fedele. Max 15 righe." }] },
      ...this._buildGeminiContents(data.summary, toSummarize),
    ];

    const newSummary = await this._callGeminiGenerate({
      systemInstructionText: "Sei un assistente che sintetizza conversazioni in modo fedele e conciso.",
      contents: summaryPrompt,
      useFileSearch: false,
      modelOverride: summaryModel,
    });

    data.summary = newSummary;
    data.turns = remaining;
    data.turnCount = 0;
    return data;
  }

  // -------------------------
  // Routes
  // -------------------------
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/init") {
      this._touch();
      const data = this._getJSON("data", { summary: "", turns: [], turnCount: 0 });
      this._putJSON("data", data);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }

    if (request.method === "POST" && url.pathname === "/reset") {
      this._touch();
      this._del("data");
      this.state.storage.sql.exec("DELETE FROM messages");
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }

    // Usato dal cron cleanup (IndexDO): svuota completamente
    if (request.method === "POST" && url.pathname === "/destroy") {
      this._clearAll();
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }

    // History: per ricostruire la UI dopo refresh (Android)
    if (request.method === "POST" && url.pathname === "/history") {
      this._touch();
      const payload = await request.json().catch(() => null);
      const limit = payload?.limit ?? 120;
      const beforeId = payload?.beforeId ?? null;

      const meta = this._getJSON("meta", { createdAt: 0, lastAccessAt: 0 });
      const data = this._getJSON("data", { summary: "", turns: [], turnCount: 0 });

      return new Response(JSON.stringify({
        meta,
        summary: data.summary || "",
        messages: this._getMessages(limit, beforeId),
      }), { headers: { "content-type": "application/json" } });
    }

    if (request.method === "POST" && url.pathname === "/chat") {
      this._touch();
      const payload = await request.json().catch(() => null);
      const userText = (payload?.message || "").toString().trim();
      const systemPrompt = SYSTEM_PROMPT;

      if (!userText) return new Response(JSON.stringify({ error: "Missing message" }), { status: 400, headers: { "content-type": "application/json" } });

      const data = this._getJSON("data", { summary: "", turns: [], turnCount: 0 });

      // Log completo (DB)
      this._insertMessage("user", userText);

      // Rolling context (come prima)
      data.turns.push({ role: "user", parts: [{ text: userText }] });
      data.turnCount += 1;

      const contents = this._buildGeminiContents(data.summary, data.turns);
      const assistantText = await this._callGeminiGenerate({
        systemInstructionText: systemPrompt,
        contents,
        useFileSearch: true,
      });

      // Log completo (DB)
      this._insertMessage("model", assistantText);

      data.turns.push({ role: "model", parts: [{ text: assistantText }] });
      data.turnCount += 1;

      const rolled = await this._maybeRollSummary(data);
      this._putJSON("data", rolled);

      // Limita crescita DB (opzionale ma consigliato)
      // Esempio: tieni max 800 messaggi per sessione (400 Q/A)
      this._pruneMessages(this.env.HISTORY_MAX_MESSAGES || 800);

      return new Response(JSON.stringify({ text: assistantText }), { headers: { "content-type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "NotFound" }), { status: 404, headers: { "content-type": "application/json" } });
  }
}