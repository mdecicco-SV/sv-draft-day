// Draft-console intel store.
// Read/append the append-only `draft_intel_events` log in Supabase (sv-taskboard).
// All access is server-side via the service_role key (never exposed to the client);
// the table has RLS on with no public policies, so it is unreachable via the Data API.
//
//   GET    /api/intel            -> { events: [...] }  recent events, newest first
//   POST   /api/intel  {event}   -> append one event
//   DELETE /api/intel?id=123     -> remove a mistaken event (append-only otherwise)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TABLE = "draft_intel_events";
// medical (note = "yes"|"no"|"unknown") and range (window_lo/window_hi) are player-scoped
// settings shared across the war room; latest event per player wins.
const KINDS = ["interest_sought", "interest_received", "rule_out", "strike_window", "offer", "medical", "range"];

function rest(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: "Supabase env not configured" });

  try {
    if (req.method === "GET") {
      const limit = Math.min(parseInt(req.query?.limit || "2000", 10) || 2000, 5000);
      const r = await rest(`${TABLE}?select=*&order=created_at.desc&limit=${limit}`);
      if (!r.ok) throw new Error(`read ${r.status}: ${await r.text()}`);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ events: await r.json(), fetchedAt: new Date().toISOString() });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      if (!body.kind || !KINDS.includes(body.kind)) return res.status(400).json({ error: "invalid or missing kind" });
      if (!body.player_name) return res.status(400).json({ error: "player_name required" });
      const row = {
        player_id: body.player_id ?? null,
        player_name: body.player_name,
        team: body.team ?? null,
        kind: body.kind,
        strength: body.strength ?? null,
        color: body.color ?? null,
        window_lo: body.window_lo ?? null,
        window_hi: body.window_hi ?? null,
        offer_type: body.offer_type ?? null,
        amount: body.amount ?? null,
        amount_lo: body.amount_lo ?? null,
        amount_hi: body.amount_hi ?? null,
        pick_overall: body.pick_overall ?? null,
        status: body.status ?? "active",
        note: body.note ?? null,
        agent: body.agent ?? null,
        source: "draft-console",
      };
      const r = await rest(TABLE, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
      if (!r.ok) throw new Error(`insert ${r.status}: ${await r.text()}`);
      const inserted = await r.json();
      return res.status(200).json({ ok: true, event: Array.isArray(inserted) ? inserted[0] : inserted });
    }

    if (req.method === "DELETE") {
      const id = parseInt(req.query?.id, 10);
      if (!id) return res.status(400).json({ error: "id required" });
      const r = await rest(`${TABLE}?id=eq.${id}`, { method: "DELETE", headers: { Prefer: "return=representation" } });
      if (!r.ok) throw new Error(`delete ${r.status}: ${await r.text()}`);
      return res.status(200).json({ ok: true, deleted: id });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
