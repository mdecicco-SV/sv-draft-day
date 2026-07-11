// Fast-lane tweet ingest — the sub-minute path into the lead ladder.
//
//   POST /api/xlead-ingest  {tweets:[{handle,text,url,at}]}   (watcher userscript)
//   POST /api/xlead-ingest  {paste:true, tweets:[{text,url?}]} (console paste lane)
//   POST /api/xlead-ingest  {hb:true}                          (watcher heartbeat)
//
// Two callers, two auth paths: the browser userscript watching the war room's live
// X Pro column sends `x-dd-key` (DD_INGEST_KEY — also exempted in middleware.js so
// it clears the site-password gate); the in-app paste lane rides the sv_auth cookie
// like any app fetch and marks `paste:true` (rate-limited). Rows land in a Redis
// inbox that /api/xlead's refresh lock drains ahead of the sheet — same dedupe,
// same Sonnet parse, same soft-file → auto-validate ladder, same notebook records.
// Adding tweets clears the refresh lock so the very next poll parses immediately.

const Redis = require("ioredis");

const INBOX_KEY = "dd:xlead:inbox";
const HB_KEY = "dd:xlead:hb";
const LOCK_KEY = "dd:xlead:lock";
const MAX_INBOX = 200;

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-dd-key");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  const r = getRedis();
  if (!r) return res.status(503).json({ error: "ingest needs REDIS_URL" });

  let b;
  try { b = typeof req.body === "object" && req.body ? req.body : JSON.parse(req.body || "{}"); }
  catch (e) { return res.status(400).json({ error: "bad json" }); }

  const keyed = !!(process.env.DD_INGEST_KEY && req.headers["x-dd-key"] === process.env.DD_INGEST_KEY);
  const isPaste = b.paste === true;
  // paste rides the site-password cookie (middleware already gated it); watcher needs the key
  if (!keyed && !isPaste) return res.status(401).json({ error: "bad key" });

  try {
    if (keyed) await r.set(HB_KEY, String(Date.now()));   // any keyed call = watcher alive
    if (isPaste && !keyed) {   // light abuse guard on the cookie path
      const n = await r.incr("dd:xlead:pasterl");
      if (n === 1) await r.expire("dd:xlead:pasterl", 60);
      if (n > 10) return res.status(429).json({ error: "slow down" });
    }
    let added = 0;
    for (const t of (Array.isArray(b.tweets) ? b.tweets : []).slice(0, 20)) {
      const text = String(t?.text || "").trim().slice(0, 600);
      if (!text) continue;
      // dedupe key: the tweet's own url when present (pastes: first status link in the text)
      const inText = text.match(/https?:\/\/(?:x|twitter)\.com\/\S+\/status\/\d+/);
      const url = String(t?.url || "").trim() || (inText ? inText[0] :
        `manual:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`);
      const src = String(t?.handle || "").replace(/^@/, "").trim() || (isPaste ? "paste" : "?");
      await r.rpush(INBOX_KEY, JSON.stringify({ text, url, src, at: t?.at || new Date().toISOString() }));
      added++;
    }
    if (added) {
      await r.ltrim(INBOX_KEY, -MAX_INBOX, -1);
      await r.del(LOCK_KEY);   // next /api/xlead poll parses immediately, no 30s wait
    }
    return res.status(200).json({ ok: true, added });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
