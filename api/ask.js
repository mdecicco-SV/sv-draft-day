// Draft-console "Ask the data" endpoint.
// The client packs a compact snapshot of the draft-day system (draft status, pools,
// client book, slot-history aggregates) and sends a freeform question; we relay it
// to the Claude API and return the answer. Server-side only — the API key never
// reaches the browser.
//
//   POST /api/ask  { question, context } -> { answer, usage }

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-5";
const MAX_CONTEXT_BYTES = 80 * 1024;   // hard cap on client-packed context

const SYSTEM = `You are the analytics desk inside a baseball agency's MLB Draft war room, live on draft day.
The user is an agent advising drafted-and-draftable clients on signing bonuses, slot values, and leverage.
Answer from the DRAFT DATA provided in the message. Be direct and quantitative; cite picks, slots, and
dollar figures from the data. If the data doesn't cover the question, say what's missing rather than guessing.
Keep answers tight — a few sentences or a short list; this is read on a console mid-draft.`;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  if (!API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const question = (body.question || "").trim();
    if (!question) return res.status(400).json({ error: "question required" });
    let context = String(body.context || "");
    if (Buffer.byteLength(context, "utf8") > MAX_CONTEXT_BYTES) {
      context = context.slice(0, MAX_CONTEXT_BYTES);
    }

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        system: SYSTEM,
        messages: [{ role: "user", content: `DRAFT DATA\n${context}\n\nQuestion: ${question}` }],
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      const msg = data?.error?.message || `upstream ${r.status}`;
      return res.status(502).json({ error: msg });
    }
    if (data.stop_reason === "refusal") return res.status(200).json({ answer: "(request declined by the model)", usage: data.usage });
    const answer = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n") || "(no answer)";
    return res.status(200).json({ answer, usage: data.usage, model: data.model });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
