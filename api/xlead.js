// Leading pick intel from the X insider list — surfaces "TEAM taking PLAYER"
// reports ahead of the MLB feed flipping isDrafted.
//
//   GET    /api/xlead        -> { enabled, leads:[...], fetchedAt }
//   DELETE /api/xlead?id=..  -> dismiss a bad lead (war-room manual)
//
// ARCHITECTURE. X polling is NOT done here — it's a Google Apps Script
// (scripts/sv_draftday_capture_v1.0.0.gs) that queries 8 insider accounts every
// 15 min over the draft window and appends rows to a "DraftDay_Feed" sheet tab
// (date, source, matched_query, handle, text, url, ingested_at, posted). That
// sidesteps X rate limits entirely and keeps the bearer token off Vercel.
//
// This endpoint READS that sheet (published CSV), parses new tweet text into
// {player, team, pick, confidence} via Claude Haiku, and serves the leads. It's
// client-coalesced (Redis TTL lock) so the war room hits the sheet + the parser
// ~once per poll window regardless of device count. Dormant until configured.
//
// Env: DRAFTDAY_SHEET_CSV_URL  (a "publish to web" / gviz CSV url for the tab)
//         — or DRAFTDAY_SHEET_ID (+ optional DRAFTDAY_SHEET_GID) to build one;
//      DD_POLL_SECONDS (default 30), ANTHROPIC_API_KEY (shared w/ /api/ask), REDIS_URL.

const Redis = require("ioredis");
const { logNote } = require("../lib/reportlog");
const { resolveTeamAbbrev, targetPick, corroborated } = require("../lib/leads");
const { normName } = require("../lib/names");

const POLL_MS = (parseInt(process.env.DD_POLL_SECONDS, 10) || 30) * 1000;
const YEAR = 2026;
const AUTOVAL_KEY = "dd:xlead:autoval";  // player+team groups already auto-validated (never re-fire)
const AUTO_VALIDATE_SOURCES = parseInt(process.env.AUTO_VALIDATE_SOURCES, 10) || 2;
const LEADS_KEY = "dd:xlead:leads";      // JSON array, newest first, capped
const SEEN_KEY = "dd:xlead:seen";        // tweet urls already parsed (set)
const LOCK_KEY = "dd:xlead:lock";        // TTL lock -> one refresh per window
const DISMISS_KEY = "dd:xlead:dismissed";
const MAX_LEADS = 60;
const MAX_PARSE_PER_RUN = 40;            // cap Haiku batch size per refresh
const PARSE_MODEL = process.env.XLEAD_MODEL || "claude-sonnet-5";   // Sonnet minimum for lead parsing (per Brandon, 7/10)

let redis = null;
function getRedis() {
  if (redis) return redis;
  if (!process.env.REDIS_URL) return null;
  redis = new Redis(process.env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 });
  redis.on("error", () => {});
  return redis;
}

function sheetCsvUrl() {
  if (process.env.DRAFTDAY_SHEET_CSV_URL) return process.env.DRAFTDAY_SHEET_CSV_URL;
  const id = process.env.DRAFTDAY_SHEET_ID;
  if (!id) return null;
  const gid = process.env.DRAFTDAY_SHEET_GID;
  // gviz csv export of the named tab (or a specific gid) — works for any sheet
  // shared "anyone with the link can view".
  return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&` +
    (gid ? `gid=${gid}` : `sheet=DraftDay_Feed`);
}

// Minimal RFC-4180 CSV parser (tweet text carries commas, quotes, newlines).
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function fetchSheetRows(url) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`sheet ${r.status}`);
  const rows = parseCsv(await r.text());
  if (!rows.length) return [];
  const hdr = rows[0].map((h) => h.trim().toLowerCase());
  const ix = (name) => hdr.indexOf(name);
  const iText = ix("text"), iUrl = ix("url"), iHandle = ix("handle"), iDate = ix("date");
  if (iText < 0 || iUrl < 0) return [];   // not the feed shape
  return rows.slice(1).filter((r) => r[iUrl]).map((r) => ({
    text: (r[iText] || "").trim(),
    url: (r[iUrl] || "").trim(),
    src: (r[iHandle] || "").replace(/^@/, "").trim() || "?",
    at: (r[iDate] || "").trim(),
  }));
}

// One Claude call for the batch of new tweets -> parsed selections.
async function parseTweets(tweets) {
  if (!process.env.ANTHROPIC_API_KEY || !tweets.length) return [];
  const numbered = tweets.map((t, i) => `[${i}] @${t.src}: ${t.text.replace(/\s+/g, " ").slice(0, 400)}`).join("\n");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: PARSE_MODEL,
      max_tokens: 1500,
      system: `You extract MLB draft pick reports from insider tweets during the 2026 MLB Draft.
A "selection report" says or strongly implies a specific TEAM is selecting/taking/expected to take a specific PLAYER (past or imminent).
Ignore: rankings chatter, general mock drafts posted before the draft, signing-bonus talk without a selection, retweets of official announcements.
Return ONLY a JSON array, one object per selection report found:
{"i": <tweet index>, "player": "Full Name", "team": "team name or abbreviation as written", "pick": <overall pick number or null>, "confidence": 0.0-1.0}
confidence: 0.9+ = flat statement by the reporter; 0.6-0.8 = hedged ("hearing", "expected"); below 0.5 = speculation. Empty array if none.`,
      messages: [{ role: "user", content: `Tweets:\n${numbered}\n\nJSON array:` }],
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `anthropic ${r.status}`);
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr;
  try { arr = JSON.parse(m[0]); } catch (e) { return []; }
  return (Array.isArray(arr) ? arr : []).filter((x) => x && x.player && x.team && tweets[x.i])
    .map((x) => ({
      id: tweets[x.i].url,
      player: String(x.player), team: String(x.team),
      pick: Number.isFinite(+x.pick) ? +x.pick : null,
      confidence: Math.max(0, Math.min(1, +x.confidence || 0.5)),
      src: tweets[x.i].src, at: tweets[x.i].at,
      text: tweets[x.i].text.replace(/\s+/g, " ").slice(0, 200),
    }));
}

async function refresh(r, url) {
  // TTL lock: first request in each window does the read+parse, rest serve cache
  const locked = await r.set(LOCK_KEY, "1", "PX", POLL_MS, "NX");
  if (!locked) return;
  try {
    const tweets = await fetchSheetRows(url);
    if (!tweets.length) return;
    // only parse tweets we haven't parsed before (dedupe by url via a Redis set)
    const fresh = [];
    for (const t of tweets) {
      if (fresh.length >= MAX_PARSE_PER_RUN) break;
      if (await r.sismember(SEEN_KEY, t.url)) continue;
      fresh.push(t);
    }
    if (!fresh.length) return;
    await r.sadd(SEEN_KEY, ...fresh.map((t) => t.url));
    await r.expire(SEEN_KEY, 60 * 60 * 24 * 3);
    const parsed = await parseTweets(fresh);
    if (!parsed.length) return;
    const cur = JSON.parse((await r.get(LEADS_KEY)) || "[]");
    const have = new Set(cur.map((l) => l.id));
    const fresh2 = parsed.filter((l) => !have.has(l.id));
    const merged = [...fresh2, ...cur].slice(0, MAX_LEADS);
    await r.set(LEADS_KEY, JSON.stringify(merged));
    // We hold the refresh lock — the single-writer seam for notebook records and
    // corroboration auto-validation (client-side would fire once per device).
    const state = JSON.parse((await r.get(`dd:cache:${YEAR}`)) || (await r.get(`dd:last:${YEAR}`)) || "null");
    for (const l of fresh2) {
      await logNote({
        note: `📡 @${l.src}: ${l.team} → ${l.player}${l.pick ? ` at #${l.pick}` : ""} — ${l.text} · ${l.id}`,
        player_name: l.player,
        team: resolveTeamAbbrev(l.team, state ? state.pools : []),
        agent: "x-feed",
      });
    }
    await autoValidate(r, merged, state);
  } catch (err) {
    // swallow — next window retries; never surfaces to the war room
  }
}

// Two distinct insiders on the same player+team = the war room's validation bar
// (AUTO_VALIDATE_SOURCES). Files the reported pick exactly as a manual report
// would, once per group ever — an undo is a human call the bot must not re-override.
async function autoValidate(r, leads, state) {
  if (!state || !state.picks) return;
  const groups = corroborated(leads, { minSources: AUTO_VALIDATE_SOURCES, pools: state.pools || [] });
  if (!groups.length) return;
  const repRaw = await r.hgetall(`dd:reported:${YEAR}`);
  const reportedOveralls = new Set(Object.keys(repRaw || {}).map(Number));
  const reportedPlayers = new Set(Object.values(repRaw || {}).map((j) => {
    try { return normName(JSON.parse(j).player); } catch (e) { return null; }
  }).filter(Boolean));
  const draftedPlayers = new Set(state.picks.filter((p) => p.isDrafted && p.player).map((p) => normName(p.player)));
  for (const g of groups) {
    if (await r.sismember(AUTOVAL_KEY, g.key)) continue;
    const pk = normName(g.player);
    if (draftedPlayers.has(pk) || reportedPlayers.has(pk)) {   // moot — never re-fire
      await r.sadd(AUTOVAL_KEY, g.key); await r.expire(AUTOVAL_KEY, 60 * 60 * 24 * 3);
      continue;
    }
    const teamAb = resolveTeamAbbrev(g.team, state.pools);
    const overall = targetPick(state.picks, teamAb, g.pick, reportedOveralls);
    if (overall == null) continue;   // unresolvable right now — retry on a later refresh
    const rec = { overall, player: g.player, team: teamAb, at: new Date().toISOString(), auto: true, srcs: g.srcs };
    await r.hset(`dd:reported:${YEAR}`, String(overall), JSON.stringify(rec));
    await r.del(`dd:cache:${YEAR}`);
    await r.sadd(AUTOVAL_KEY, g.key); await r.expire(AUTOVAL_KEY, 60 * 60 * 24 * 3);
    reportedOveralls.add(overall); reportedPlayers.add(pk);
    await logNote({
      note: `⚡ auto-validated (${g.srcs.length} sources: ${g.srcs.map((s) => "@" + s).join(" ")}): ${g.player} → ${teamAb || g.team} at #${overall}`,
      player_name: g.player, team: teamAb, agent: "auto",
    });
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  const r = getRedis();
  const url = sheetCsvUrl();
  const enabled = !!(url && r && process.env.ANTHROPIC_API_KEY);

  try {
    if (req.method === "DELETE") {
      if (!r) return res.status(503).json({ error: "no redis" });
      const id = String(req.query?.id || "");
      if (!id) return res.status(400).json({ error: "id required" });
      await r.sadd(DISMISS_KEY, id);
      return res.status(200).json({ ok: true });
    }
    if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });
    if (!enabled) return res.status(200).json({ enabled: false, leads: [] });

    await refresh(r, url);
    const [rawLeads, dismissed] = await Promise.all([r.get(LEADS_KEY), r.smembers(DISMISS_KEY)]);
    const drop = new Set(dismissed || []);
    const leads = JSON.parse(rawLeads || "[]").filter((l) => !drop.has(l.id));
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ enabled: true, leads, fetchedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
