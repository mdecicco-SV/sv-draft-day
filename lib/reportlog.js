// Notebook logging for the reported-pick pipeline — one row in the shared
// war-room notebook (draft_intel_events, kind:"note") per report event.
// Same Supabase REST shape as api/intel.js. Fail-soft by design: a notebook
// hiccup must never break a report write on draft day.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TABLE = "draft_intel_events";

async function logNote({ note, player_name, team, agent }) {
  if (!SUPABASE_URL || !SERVICE_KEY || !note) return false;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        player_id: null,
        player_name: player_name || "",   // NOT NULL column; "" reads as team/general tag
        team: team || null,
        kind: "note",
        status: "active",
        note,
        agent: agent || "auto",
        source: "draft-console",
      }),
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

module.exports = { logNote };
