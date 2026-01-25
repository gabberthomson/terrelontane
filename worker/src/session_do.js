export class SessionDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    this.state.blockConcurrencyWhile(async () => {
      this.state.storage.sql.exec("
        CREATE TABLE IF NOT EXISTS kv (
          k TEXT PRIMARY KEY,
          v TEXT NOT NULL
        );
      ");
    });
  }


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
    const maxOutputTokens = this._toInt(this.env.MAX_OUTPUT_TOKENS, 700);

    const body = {
      systemInstruction: { parts: [{ text: systemInstructionText }] },
      contents,
      generationConfig: { maxOutputTokens, temperature: 0.2 },
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


  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/init") {
      const data = this._getJSON("data", { summary: "", turns: [], turnCount: 0 });
      this._putJSON("data", data);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }

    if (request.method === "POST" && url.pathname === "/reset") {
      this._del("data");
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }

    if (request.method === "POST" && url.pathname === "/chat") {
      const payload = await request.json().catch(() => null);
      const userText = (payload?.message || "").toString().trim();
      const systemPrompt = (payload?.systemPrompt || "").toString();

      if (!userText) return new Response(JSON.stringify({ error: "Missing message" }), { status: 400, headers: { "content-type": "application/json" } });
      if (!systemPrompt.trim()) return new Response(JSON.stringify({ error: "Missing systemPrompt" }), { status: 400, headers: { "content-type": "application/json" } });

      const data = this._getJSON("data", { summary: "", turns: [], turnCount: 0 });

      data.turns.push({ role: "user", parts: [{ text: userText }] });
      data.turnCount += 1;

      const contents = this._buildGeminiContents(data.summary, data.turns);
      const assistantText = await this._callGeminiGenerate({
        systemInstructionText: systemPrompt,
        contents,
        useFileSearch: true,
      });

      data.turns.push({ role: "model", parts: [{ text: assistantText }] });
      data.turnCount += 1;

      const rolled = await this._maybeRollSummary(data);
      this._putJSON("data", rolled);

      return new Response(JSON.stringify({ text: assistantText }), { headers: { "content-type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "NotFound" }), { status: 404, headers: { "content-type": "application/json" } });
  }
}
