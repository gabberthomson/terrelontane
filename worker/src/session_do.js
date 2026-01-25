export class SessionDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async _load() {
    const data = (await this.state.storage.get("data")) || {
      summary: "",
      turns: [], // array di Content per Gemini: { role, parts:[{text}] }
      turnCount: 0,
    };
    return data;
  }

  async _save(data) {
    await this.state.storage.put("data", data);
  }

  _toInt(v, def) {
    const n = parseInt(v ?? "", 10);
    return Number.isFinite(n) ? n : def;
  }

  _buildGeminiContents(summary, turns) {
    const contents = [];
    if (summary && summary.trim().length) {
      contents.push({
        role: "user",
        parts: [{ text: `Contesto sintetico (summary rolling):\n${summary}` }],
      });
    }
    for (const t of turns) contents.push(t);
    return contents;
  }

  async _callGeminiGenerate({ systemInstructionText, contents, useFileSearch }) {
    const apiKey = this.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY secret");
    const storeName = this.env.GEMINI_FILE_SEARCH_STORE_NAME;
    if (useFileSearch && !storeName) throw new Error("Missing GEMINI_FILE_SEARCH_STORE_NAME secret/var");

    const model = this.env.GEMINI_MODEL_CHAT || "models/gemini-2.0-flash";
    const maxOutputTokens = this._toInt(this.env.MAX_OUTPUT_TOKENS, 700);

    const body = {
      systemInstruction: { parts: [{ text: systemInstructionText }] },
      contents,
      generationConfig: {
        maxOutputTokens,
        temperature: 0.2,
      },
    };

    // File Search Tool: usa lo store esistente (nessun ingest su Cloudflare)
    // Nomenclatura snake_case come da docs/tooling Gemini (file_search_store_names). :contentReference[oaicite:2]{index=2}
    if (useFileSearch) {
      body.tools = [
        {
          file_search: {
            file_search_store_names: [storeName],
          },
        },
      ];
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
      json?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") ??
      "";

    return text.trim();
  }

  async _maybeRollSummary(data) {
    const trigger = this._toInt(this.env.SUMMARY_TRIGGER_TURNS, 18);
    const keepLast = this._toInt(this.env.SUMMARY_KEEP_LAST_TURNS, 8);

    if (data.turnCount < trigger) return data;
    if (data.turns.length <= keepLast) return data;

    const toSummarize = data.turns.slice(0, data.turns.length - keepLast);
    const remaining = data.turns.slice(data.turns.length - keepLast);

    const summaryModel = this.env.GEMINI_MODEL_SUMMARY || this.env.GEMINI_MODEL_CHAT || "models/gemini-2.0-flash";

    const oldModel = this.env.GEMINI_MODEL_CHAT;
    this.env.GEMINI_MODEL_CHAT = summaryModel;

    const summaryPrompt = [
      {
        role: "user",
        parts: [{
          text:
            "Produci un riassunto operativo e compatto della conversazione seguente, " +
            "mantenendo: (1) decisioni e vincoli sulle regole, (2) fatti canonici emersi, " +
            "(3) richieste aperte. Massimo 15 righe.",
        }],
      },
      ...this._buildGeminiContents(data.summary, toSummarize),
    ];

    const newSummary = await this._callGeminiGenerate({
      systemInstructionText: "Sei un assistente che sintetizza conversazioni in modo fedele e conciso.",
      contents: summaryPrompt,
      useFileSearch: false,
    });

    this.env.GEMINI_MODEL_CHAT = oldModel;

    data.summary = newSummary;
    data.turns = remaining;
    data.turnCount = 0; // reset contatore dopo roll
    return data;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/init") {
      const data = await this._load();
      await this._save(data);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }

    if (request.method === "POST" && url.pathname === "/reset") {
      await this.state.storage.delete("data");
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }

    if (request.method === "POST" && url.pathname === "/chat") {
      const payload = await request.json().catch(() => null);
      const userText = (payload?.message || "").toString().trim();
      if (!userText) {
        return new Response(JSON.stringify({ error: "Missing message" }), { status: 400, headers: { "content-type": "application/json" } });
      }

      const data = await this._load();

      // Append user turn
      data.turns.push({ role: "user", parts: [{ text: userText }] });
      data.turnCount += 1;

      // Build system prompt (il tuo prompt di sistema, senza citazioni)
      const systemPrompt = payload?.systemPrompt || "";
      if (!systemPrompt) {
        return new Response(JSON.stringify({ error: "Missing systemPrompt" }), { status: 400, headers: { "content-type": "application/json" } });
      }

      // Call Gemini with File Search ALWAYS enabled (come da tua regola)
      const contents = this._buildGeminiContents(data.summary, data.turns);
      const assistantText = await this._callGeminiGenerate({
        systemInstructionText: systemPrompt,
        contents,
        useFileSearch: true,
      });

      // Append assistant turn
      data.turns.push({ role: "model", parts: [{ text: assistantText }] });
      data.turnCount += 1;

      // Rolling summary
      const rolled = await this._maybeRollSummary(data);
      await this._save(rolled);

      return new Response(JSON.stringify({ text: assistantText }), { headers: { "content-type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "NotFound" }), { status: 404, headers: { "content-type": "application/json" } });
  }
}
