// Push trigger for picks that never touch the live statsapi path — mock-engine
// and manual (Best Available "Draft" button) picks, which live only in the
// browser. The client fires-and-forgets a POST here from applyPick; we do the
// authoritative SV-client check + dedupe server-side and push to every
// subscriber. "REPORTED"/xlead handling is parked and not part of this.
//   POST /api/notify { pick:{player,overall,slot,team,teamName,round}, mode:"mock", sid }
//
// Dedupe: dd:push:sent:mock:<sid> (6h TTL) — a resetMock/new seed mints a new
// sid and re-arms notifications; replays within a session stay silent.
// Requires REDIS_URL + VAPID keys; degrades to a 200 no-op like api/push.js.

const Redis = require("ioredis");
const { vapidReady, notifyPick } = require("../lib/push");

let redis = null;
function getRedis() {
  if (redis) return redis;
  if (!process.env.REDIS_URL) return null;
  redis = new Redis(process.env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 });
  redis.on("error", () => {});
  return redis;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  const r = getRedis();
  if (!vapidReady() || !r) return res.status(200).json({ sent: 0, enabled: false });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const pick = body.pick;
    if (!pick || !pick.player || pick.overall == null) return res.status(400).json({ error: "pick {player, overall} required" });
    const sid = String(body.sid || "").replace(/[^a-z0-9]/gi, "").slice(0, 32);
    if (!sid) return res.status(400).json({ error: "sid required" });

    const sentKey = `dd:push:sent:mock:${sid}`;
    const result = await notifyPick(r, pick, {
      sentKey,
      titlePrefix: "🧪 MOCK — ",
      tagPrefix: `sv-mock-${sid}`,
    });
    await r.expire(sentKey, 60 * 60 * 6);
    return res.status(200).json({ sent: result.sent || 0 });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
