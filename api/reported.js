// Reported-pick store — the war room's validated selection ahead of the official
// feed (manual today from the pick card; X-lead promotion later rides the same
// POST). /api/draft merges these into its payload as `reported[]` and self-GCs a
// record once MLB confirms the pick. Official feed always wins.
//
//   POST   /api/reported            {overall, player, team?}  -> {ok, reported}
//   DELETE /api/reported?overall=N                            -> {ok}
//   GET    /api/reported                                      -> {reported:[...]}
//
// Writes DEL the draft cache so the next 3s war-room poll propagates immediately.

const Redis = require("ioredis");
const { logNote } = require("../lib/reportlog");

const DEFAULT_YEAR = 2026;

let redis = null;
function getRedis() {
  if (redis) return redis;
  if (!process.env.REDIS_URL) return null;
  redis = new Redis(process.env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 });
  redis.on("error", () => {}); // never crash the function on a redis blip
  return redis;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const r = getRedis();
  if (!r) return res.status(503).json({ error: "reported picks need REDIS_URL" });
  const year = (req.query?.year && /^\d{4}$/.test(req.query.year)) ? req.query.year : DEFAULT_YEAR;
  const HASH = `dd:reported:${year}`;
  const CACHE = `dd:cache:${year}`;

  try {
    if (req.method === "POST") {
      const b = typeof req.body === "object" && req.body ? req.body : JSON.parse(req.body || "{}");
      const overall = parseInt(b.overall, 10);
      const player = String(b.player || "").trim();
      if (!Number.isFinite(overall) || overall < 1 || !player) {
        return res.status(400).json({ error: "need overall + player" });
      }
      const rec = { overall, player, team: b.team || null, at: new Date().toISOString() };
      await r.hset(HASH, String(overall), JSON.stringify(rec));
      await r.del(CACHE);
      // notebook record (auto-validated leads are logged with richer context by /api/xlead)
      if (!b.auto) await logNote({ note: `⚡ reported: ${player} → ${rec.team || "?"} at #${overall}`,
        player_name: player, team: rec.team, agent: b.agent || "war room" });
      return res.status(200).json({ ok: true, reported: rec });
    }
    if (req.method === "DELETE") {
      const overall = parseInt(req.query?.overall, 10);
      if (!Number.isFinite(overall)) return res.status(400).json({ error: "need overall" });
      let prev = null;
      try { prev = JSON.parse((await r.hget(HASH, String(overall))) || "null"); } catch (e) {}
      await r.hdel(HASH, String(overall));
      await r.del(CACHE);
      if (prev) await logNote({ note: `↩ report withdrawn: ${prev.player} at #${overall}`,
        player_name: prev.player, team: prev.team, agent: "war room" });
      return res.status(200).json({ ok: true });
    }
    const raw = await r.hgetall(HASH);
    const reported = Object.values(raw || {})
      .map((j) => { try { return JSON.parse(j); } catch (e) { return null; } })
      .filter(Boolean)
      .sort((a, b) => a.overall - b.overall);
    return res.status(200).json({ reported });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
