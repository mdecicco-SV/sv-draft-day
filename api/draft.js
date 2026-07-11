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

// Traded picks MLB's feed hasn't processed yet (Passan 7/10/26: Pirates sent
// CB-A #34 to the White Sox). year -> overall -> teamId; pool math downstream
// follows the override. Harmless no-op once statsapi catches up.
const PICK_TEAM_OVERRIDES = { 2026: { 34: 145 } };
const OVERRIDE_TEAM_NAMES = { 145: "Chicago White Sox" };

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
  for (const p of picks) {
    const oid = (PICK_TEAM_OVERRIDES[Number(year)] || {})[p.overall];
    if (oid && oid !== p.teamId) {
      p.teamId = oid; p.team = abbr(oid);
      p.teamName = OVERRIDE_TEAM_NAMES[oid] || p.teamName;
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

// War-room reported picks (/api/reported) overlaid onto the payload. Self-GC:
// once the feed confirms a pick (isDrafted), its record is dropped — the
// official feed always wins, whatever name it carries.
async function attachReported(r, state, year) {
  state.reported = [];
  if (!r) return;
  try {
    const key = `dd:reported:${year}`;
    const raw = await r.hgetall(key);
    for (const [ov, json] of Object.entries(raw || {})) {
      const pick = state.picks.find((p) => p.overall === Number(ov));
      if (!pick || pick.isDrafted) { await r.hdel(key, ov); continue; }
      try { state.reported.push(JSON.parse(json)); } catch (e) {}
    }
    state.reported.sort((a, b) => a.overall - b.overall);
  } catch (e) {}
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
    await attachReported(r, state, year);
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
