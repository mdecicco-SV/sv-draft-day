// Pure helpers for the X-lead → reported-pick pipeline. Server-side twins of
// index.html's leadTeamAbbr / target-pick logic, kept dependency-light so they
// are unit-testable in plain node.

const { normName } = require("./names");

// abbrev set mirrors lib/teams.js / index.html ABBR_TO_ID
const ABBREVS = new Set(["LAA","ARI","BAL","BOS","CHC","CIN","CLE","COL","DET","HOU","KC","LAD","WSH",
  "NYM","ATH","PIT","SD","SEA","SF","STL","TB","TEX","TOR","MIN","PHI","ATL","CHW","MIA","NYY","MIL"]);
const teamAlias = (t) => (t === "OAK" ? "ATH" : t);

// "CIN" / "Reds" / "Cincinnati Reds" -> "CIN", matched against the payload's pools
// (which carry team + teamName). null when unresolvable.
function resolveTeamAbbrev(teamStr, pools) {
  if (!teamStr) return null;
  const up = teamAlias(String(teamStr).trim().toUpperCase());
  if (ABBREVS.has(up)) return up;
  const low = String(teamStr).trim().toLowerCase();
  const hit = (pools || []).find((p) => {
    const n = (p.teamName || "").toLowerCase();
    return n && (n.includes(low) || low.includes(n.split(" ").pop()));
  });
  return hit ? hit.team : null;
}

// The pick a validation files at: the lead's pick number if it's real, that
// team's, and still open (undrafted + unreported); else the team's first open
// pick; else null. reportedOveralls = Set of overalls already reported.
function targetPick(picks, teamAb, leadPick, reportedOveralls) {
  const rep = reportedOveralls || new Set();
  const open = (p) => !p.isDrafted && !p.isPass && !rep.has(p.overall);
  if (leadPick != null) {
    const p = picks.find((x) => x.overall === Number(leadPick));
    if (p && open(p) && (!teamAb || p.team === teamAb)) return p.overall;
  }
  if (!teamAb) return null;
  const nxt = picks.find((p) => p.team === teamAb && open(p));
  return nxt ? nxt.overall : null;
}

// Group active leads by player+team; return groups with >= minSources distinct
// handles. A handle tweeting the same intel twice counts once. Teams group by
// RESOLVED abbrev (pass pools) so "CIN" and "Reds" corroborate each other.
function corroborated(leads, { minSources = 2, ttlMs = 45 * 60 * 1000, minConf = 0.55, now = Date.now(), pools = [] } = {}) {
  const groups = new Map();
  for (const l of leads || []) {
    if (!l || !l.player || !l.team) continue;
    if ((l.confidence ?? 0) < minConf) continue;
    if (l.at && !isNaN(new Date(l.at)) && now - new Date(l.at).getTime() > ttlMs) continue;
    const teamKey = resolveTeamAbbrev(l.team, pools) || normName(String(l.team));
    const key = `${normName(l.player)}|${teamKey}`;
    const g = groups.get(key) || { key, player: l.player, team: l.team, pick: null, srcs: new Set() };
    if (l.src) g.srcs.add(String(l.src).toLowerCase());
    if (l.pick != null && g.pick == null) g.pick = l.pick;
    groups.set(key, g);
  }
  return [...groups.values()]
    .filter((g) => g.srcs.size >= minSources)
    .map((g) => ({ ...g, srcs: [...g.srcs] }));
}

module.exports = { resolveTeamAbbrev, targetPick, corroborated };
