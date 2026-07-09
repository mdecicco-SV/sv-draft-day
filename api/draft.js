// Live spine for the draft hub.
// Proxies MLB's official draft tracker feed, normalizes it into a flat ordered
// board, derives "on the clock" + per-team bonus-pool math, and caches the
// result in Redis with a short TTL so a war room full of devices polling every
// few seconds coalesces into ~1 upstream fetch.
//
//   GET /api/draft            -> normalized live state (default year 2026)
//   GET /api/draft?year=2025  -> a completed draft (handy for testing)
//
// Redis (optional — falls back to direct fetch if REDIS_URL unset):
//   dd:cache:<year>  string  normalized JSON, TTL ~2s (coalesce upstream)

const Redis = require("ioredis");
const { abbr, classBucket } = require("../lib/teams");
const { notifyDraftedClients } = require("../lib/push");

const FEED = (year) => `https://statsapi.mlb.com/api/v1/draft/${year}`;
const CACHE_TTL_MS = 2000; // coalesce upstream fetches across clients
const DEFAULT_YEAR = 2026;

let redis = null;
function getRedis() {
  if (redis) return redis;
  if (!process.env.REDIS_URL) return null;
  redis = new Redis(process.env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 });
  redis.on("error", () => {}); // never crash the function on a redis blip
  return redis;
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Flatten the rounds->picks tree into one ordered list of normalized picks.
function normalize(raw, year) {
  const rounds = raw?.drafts?.rounds || [];
  const picks = [];
  for (const r of rounds) {
    for (const p of r.picks || []) {
      const teamId = p.team?.id ?? null;
      picks.push({
        overall: num(p.pickNumber),
        round: p.pickRound != null ? String(p.pickRound) : null,
        roundPick: num(p.roundPickNumber),
        teamId,
        team: abbr(teamId),
        teamName: p.team?.name ?? null,
        slot: num(p.pickValue),          // bonus-pool slot value
        bonus: num(p.signingBonus),      // actual signing bonus once posted
        rank: num(p.rank),               // MLB's pre-draft rank of the player taken
        playerId: p.person?.id ?? null,
        player: p.person?.fullName ?? null,
        headshot: p.headshotLink ?? null,
        school: p.school?.name ?? null,
        schoolClass: p.school?.schoolClass ?? null,
        bucket: classBucket(p.school?.schoolClass),
        isDrafted: !!p.isDrafted,
        isPass: !!p.isPass,
      });
    }
  }
  picks.sort((a, b) => (a.overall ?? 1e9) - (b.overall ?? 1e9));

  // First pick not yet made = on the clock.
  const onClockIdx = picks.findIndex((p) => !p.isDrafted && !p.isPass);
  const onClock = onClockIdx >= 0 ? picks[onClockIdx] : null;
  const lastPick = [...picks].reverse().find((p) => p.isDrafted) || null;

  // Per-team bonus pool: pool = sum of slot values; committed = sum of slots used
  // (picks made). Actual-bonus over/under is layered later as bonuses post.
  const pools = {};
  for (const p of picks) {
    if (!p.team) continue;
    const t = (pools[p.team] = pools[p.team] || {
      team: p.team, teamName: p.teamName, teamId: p.teamId,
      pool: 0, committedSlot: 0, spentBonus: 0, picksMade: 0, picksTotal: 0,
    });
    if (p.slot) { t.pool += p.slot; t.picksTotal += 1; }
    if (p.isDrafted) {
      if (p.slot) { t.committedSlot += p.slot; t.picksMade += 1; }
      if (p.bonus) t.spentBonus += p.bonus;
    }
  }
  for (const t of Object.values(pools)) {
    t.remainingSlot = t.pool - t.committedSlot;
    t.overUnder = t.spentBonus ? t.spentBonus - t.committedSlot : 0;
  }

  return {
    year: Number(year),
    fetchedAt: new Date().toISOString(),
    totalPicks: picks.length,
    madeCount: picks.filter((p) => p.isDrafted).length,
    onClockIndex: onClockIdx,
    onClock,
    lastPick,
    picks,
    pools: Object.values(pools).sort((a, b) => a.team.localeCompare(b.team)),
  };
}

async function fetchLive(year) {
  const res = await fetch(FEED(year), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`statsapi ${res.status}`);
  return normalize(await res.json(), year);
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const year = (req.query?.year && /^\d{4}$/.test(req.query.year)) ? req.query.year : DEFAULT_YEAR;
  const key = `dd:cache:${year}`;
  const r = getRedis();

  try {
    if (r) {
      const cached = await r.get(key);
      if (cached) {
        res.setHeader("X-Cache", "hit");
        return res.status(200).json(JSON.parse(cached));
      }
    }
    const state = await fetchLive(year);
    if (r) await r.set(key, JSON.stringify(state), "PX", CACHE_TTL_MS);
    res.setHeader("X-Cache", "miss");
    // Cache-miss = we just saw fresh upstream truth (~once per TTL across the war
    // room) — the one place to detect newly-drafted SV clients and push phones.
    // Default year only: a ?year=2025 replay must never notify. Fail-soft inside.
    if (r && Number(year) === DEFAULT_YEAR) await notifyDraftedClients(r, state);
    return res.status(200).json(state);
  } catch (err) {
    // On upstream failure, serve last-known cache (ignore TTL) if we have it.
    if (r) {
      const stale = await r.get(`dd:last:${year}`);
      if (stale) { res.setHeader("X-Cache", "stale"); return res.status(200).json(JSON.parse(stale)); }
    }
    return res.status(502).json({ error: String(err.message || err) });
  } finally {
    // Keep a no-TTL "last good" snapshot for failover.
    try { if (r) { const cur = await r.get(key); if (cur) await r.set(`dd:last:${year}`, cur); } } catch {}
  }
};
