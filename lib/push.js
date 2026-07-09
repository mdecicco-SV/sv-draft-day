// Web-push plumbing for "SV client drafted" notifications.
// Subscriptions live in Redis (dd:push:subs hash, endpoint -> subscription JSON);
// detection piggybacks on api/draft.js's cache-miss path (~1 upstream fetch / 2s
// during the draft), so no cron is needed. Everything here is fail-soft: a push
// problem must never break the live draft feed.
//
// Env: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (npx web-push generate-vapid-keys),
//      optional VAPID_SUBJECT (mailto: or https: contact, default below).

const webpush = require("web-push");

const SUBS_KEY = "dd:push:subs";
const SENT_KEY = (year) => `dd:push:sent:${year}`;     // pick overalls already announced
const CLIENTS_KEY = "dd:push:clients";                 // cached client-name keys (60s TTL)
const TEAMINTEL_URL = "https://sv-teamintel.vercel.app/teamintel.json";

// mirror of index.html normName — the join key for "is this pick one of ours"
const SUFFIX = /\b(jr|sr|ii|iii|iv|v)\b/g;
const normName = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[.'’`\-]/g, " ").replace(SUFFIX, "").replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();

function vapidReady() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

let _configured = false;
function configure() {
  if (_configured || !vapidReady()) return _configured;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:draftday@stadium-ventures.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  return (_configured = true);
}

// SV client-name keys from the shared teamintel feed, cached in Redis so the
// draft hot path doesn't hit sv-teamintel more than ~once a minute.
async function clientKeys(redis) {
  try {
    const cached = await redis.get(CLIENTS_KEY);
    if (cached) return new Set(JSON.parse(cached));
  } catch (e) {}
  const res = await fetch(TEAMINTEL_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`teamintel ${res.status}`);
  const ti = await res.json();
  const records = Array.isArray(ti) ? ti : (ti.records || []);
  const keys = [...new Set(records.map((r) => normName(r.player)).filter(Boolean))];
  try { await redis.set(CLIENTS_KEY, JSON.stringify(keys), "EX", 60); } catch (e) {}
  return new Set(keys);
}

const fmtM = (n) => n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`
  : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${n}`;

// Send one payload to matching subscriptions; prune endpoints the push service
// reports gone (404/410). opts.leadsOnly targets only subs that opted into
// unofficial "REPORTED" pushes (per-device flag, see api/push.js).
async function sendToAll(redis, payload, opts = {}) {
  if (!configure()) return { sent: 0 };
  const subs = await redis.hgetall(SUBS_KEY);
  let endpoints = Object.keys(subs || {});
  if (!endpoints.length) return { sent: 0 };
  const body = JSON.stringify(payload);
  let sent = 0;
  await Promise.allSettled(endpoints.map(async (ep) => {
    let sub;
    try { sub = JSON.parse(subs[ep]); } catch (e) { return; }
    if (opts.leadsOnly && !(sub && sub._leads)) return;   // reported pushes: opted-in devices only
    try {
      await webpush.sendNotification(sub, body, { TTL: 3600, urgency: "high" });
      sent++;
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) { try { await redis.hdel(SUBS_KEY, ep); } catch (e) {} }
    }
  }));
  return { sent };
}

// Announce one pick if it belongs to an SV client. Claims the pick's overall in
// sentKey before sending — sadd's return value (1 = we added it) makes the winner
// of concurrent invocations unambiguous. titlePrefix lets mock/manual triggers
// mark themselves so nobody panics on draft day.
async function notifyPick(redis, p, { sentKey, titlePrefix = "", tagPrefix = "sv-pick" } = {}) {
  if (!p || !p.player || p.overall == null) return { sent: 0 };
  const claimed = await redis.sadd(sentKey, String(p.overall));
  if (claimed !== 1) return { sent: 0 };
  const clients = await clientKeys(redis);
  if (!clients.has(normName(p.player))) return { sent: 0 };
  // iOS renders: title / "from <manifest short_name>" (mandatory attribution) / body
  return sendToAll(redis, {
    title: `${titlePrefix}SV Client Drafted`,
    body: `${p.player}\n${p.teamName || p.team || "?"} (#${p.overall}) — Rd ${p.round}${p.slot ? ` — slot ${fmtM(p.slot)}` : ""}`,
    tag: `${tagPrefix}-${p.overall}`,
    url: "/",
  });
}

// Diff freshly-normalized draft state against the already-announced set and push
// for any NEW pick of an SV client. First run after deploy primes the set
// silently so a mid-draft deploy doesn't replay the whole board.
async function notifyDraftedClients(redis, state) {
  if (!redis || !vapidReady() || !state || !Array.isArray(state.picks)) return;
  try {
    const drafted = state.picks.filter((p) => p.isDrafted && p.player && p.overall != null);
    if (!drafted.length) return;
    const key = SENT_KEY(state.year);
    const primed = await redis.exists(key);
    if (!primed) {
      // prime: mark everything already on the board as announced, no pushes
      await redis.sadd(key, ...drafted.map((p) => String(p.overall)));
      await redis.expire(key, 60 * 60 * 24 * 14);
      return;
    }
    // cheap early-out: nothing new on the board at all
    const announced = new Set(await redis.smembers(key));
    const fresh = drafted.filter((p) => !announced.has(String(p.overall)));
    if (!fresh.length) return;
    for (const p of fresh) {
      await notifyPick(redis, p, { sentKey: key, tagPrefix: `sv-pick-${state.year}` });
    }
  } catch (e) { /* never break the draft feed over push */ }
}

module.exports = { vapidReady, configure, sendToAll, notifyPick, notifyDraftedClients, clientKeys, normName, SUBS_KEY };
