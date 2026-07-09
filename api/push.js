// Push-subscription endpoint for the mobile companion.
//   GET    /api/push                          -> { enabled, publicKey } (VAPID key for subscribe)
//   POST   /api/push {subscription[,leads]}   -> store subscription (Redis hash by endpoint)
//   POST   /api/push {subscription, test:true}-> store + send a test notification to it
//   DELETE /api/push {endpoint}               -> remove subscription
//
// `leads:true` flags a device to also receive unofficial "REPORTED" (X-lead)
// pushes — official SV-client picks go to every subscriber regardless.
// Requires REDIS_URL + VAPID keys (see lib/push.js); degrades to {enabled:false}.

const Redis = require("ioredis");
const { vapidReady, configure, SUBS_KEY } = require("../lib/push");

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
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const r = getRedis();
  const enabled = vapidReady() && !!r;

  try {
    if (req.method === "GET") {
      return res.status(200).json({ enabled, publicKey: enabled ? process.env.VAPID_PUBLIC_KEY : null });
    }
    if (!enabled) return res.status(503).json({ error: "push not configured (VAPID keys / REDIS_URL)" });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    if (req.method === "POST") {
      const sub = body.subscription;
      if (!sub || !sub.endpoint || !sub.keys) return res.status(400).json({ error: "subscription required" });
      if (body.leads) sub._leads = true;   // opt-in for unofficial REPORTED pushes
      await r.hset(SUBS_KEY, sub.endpoint, JSON.stringify(sub));
      if (body.test) {
        configure();
        const webpush = require("web-push");
        try {
          await webpush.sendNotification(sub, JSON.stringify({
            title: "SV Draft Day 🔔", body: "Notifications are on — you'll hear it here when a client goes.", url: "/",
          }), { TTL: 300 });
        } catch (err) {
          return res.status(200).json({ ok: true, test: false, testError: String(err.statusCode || err.message || err) });
        }
        return res.status(200).json({ ok: true, test: true });
      }
      return res.status(200).json({ ok: true });
    }

    if (req.method === "DELETE") {
      const ep = body.endpoint || req.query?.endpoint;
      if (!ep) return res.status(400).json({ error: "endpoint required" });
      await r.hdel(SUBS_KEY, ep);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
