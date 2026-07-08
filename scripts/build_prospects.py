#!/usr/bin/env python3
"""Bake public/data/prospects.json from org top-30 prospect lists.

Primary path — locally supplied CSVs, no repo pull:
    python3 scripts/build_prospects.py --mlb mlb_pipeline_t30.csv --ba ba_t30.csv \
        --mlb100 mlb_pipeline_top100.csv --ba100 ba_top100.csv

--mlb is an MLB.com Pipeline scrape (org, rank, player, position, eta, age,
..., current_team, overall_grade, mlb_id). The affiliate in current_team is
resolved to a level (AAA/AA/A+/A/ROK) via the MLB statsapi teams endpoint.
--ba is Baseball America's T30 (Team, Player, T-30 Rank).

With both, entries are re-ranked on a composite: score = mean(mlb_rank,
ba_rank), a source that omits the player counts 31 (MISS). Players only on
BA's list are appended with the fields BA provides. Each entry keeps the
per-source ranks as `mlb` / `ba`.

Legacy fallback (org-review scrape, columns team_abbrev/rank/name/...):
`--csv <path>`, or no args to pull it from Stadium-Ventures/sv-org-review
via `gh api` (needs the behrlich-sv account active).
"""
import argparse, csv, difflib, io, json, re, subprocess, sys, unicodedata
import urllib.request
from pathlib import Path

REPO_PATH = "repos/Stadium-Ventures/sv-org-review/contents/data/prospects_top_scraped.csv"
OUT = Path(__file__).resolve().parent.parent / "public" / "data" / "prospects.json"
MISS = 31          # rank charged to a source that leaves the player off its T30
FUZZY_MIN = 0.85   # SequenceMatcher floor for name-variant matching

STATSAPI = "https://statsapi.mlb.com/api/v1"
STATSAPI_TEAMS = STATSAPI + "/teams?sportIds=1,11,12,13,14,16,17&season=2026"
SPORT_LEVEL = {1: "MLB", 11: "AAA", 12: "AA", 13: "A+", 14: "A", 16: "ROK", 17: "ROK"}

# full team/org names (BA + MLB.com Pipeline both use these) -> live-feed abbrevs
TEAM_ABBREV = {
    "Arizona Diamondbacks": "ARI", "Athletics": "ATH", "Atlanta Braves": "ATL",
    "Baltimore Orioles": "BAL", "Boston Red Sox": "BOS", "Chicago Cubs": "CHC",
    "Chicago White Sox": "CHW", "Cincinnati Reds": "CIN", "Cleveland Guardians": "CLE",
    "Colorado Rockies": "COL", "Detroit Tigers": "DET", "Houston Astros": "HOU",
    "Kansas City Royals": "KC", "Los Angeles Angels": "LAA", "Los Angeles Dodgers": "LAD",
    "Miami Marlins": "MIA", "Milwaukee Brewers": "MIL", "Minnesota Twins": "MIN",
    "New York Mets": "NYM", "New York Yankees": "NYY", "Philadelphia Phillies": "PHI",
    "Pittsburgh Pirates": "PIT", "San Diego Padres": "SD", "San Francisco Giants": "SF",
    "Seattle Mariners": "SEA", "St. Louis Cardinals": "STL", "Tampa Bay Rays": "TB",
    "Texas Rangers": "TEX", "Toronto Blue Jays": "TOR", "Washington Nationals": "WSH",
}

SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}

# BA name -> MLB.com Pipeline name, where the outlets tag the same player
# differently enough that no automatic matcher should guess (nicknames)
ALIASES = {
    ("NYM", "Cameron Tilly"): "Cam Tilly",
    ("NYY", "Jeffrey Heuer"): "Mac Heuer",
    ("PIT", "Triston Gray"): "Murf Gray",
}

FILL = Path(__file__).resolve().parent / "prospect_fill.csv"


def norm(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    toks = [t for t in re.sub(r"[^a-z ]", " ", s).split() if t not in SUFFIXES]
    return " ".join(toks)


def abbrev(full):
    ab = TEAM_ABBREV.get(full.strip())
    if ab is None:
        sys.exit(f"unmapped team name: {full!r}")
    return ab


def to_int(s):
    s = (s or "").strip()
    return int(s) if s.lstrip("-").isdigit() else None


def parse_bonus(s):
    """'$2.90m' / '$425,000' / '' -> int dollars or None."""
    s = (s or "").strip().lower().replace(",", "").lstrip("$")
    if not s:
        return None
    m = re.fullmatch(r"([\d.]+)\s*m", s)
    try:
        return int(float(m.group(1)) * 1e6) if m else int(float(s))
    except ValueError:
        return None


def statsapi_teams():
    """All parent clubs + affiliates. Returns (name -> level, id -> (level, org_abbrev))."""
    with urllib.request.urlopen(STATSAPI_TEAMS, timeout=30) as r:
        teams = json.load(r)["teams"]
    by_name, by_id = {}, {}
    for t in teams:
        level = SPORT_LEVEL.get((t.get("sport") or {}).get("id"))
        parent = t["name"] if level == "MLB" else t.get("parentOrgName")
        by_name[t["name"]] = level
        by_id[t["id"]] = (level, TEAM_ABBREV.get(parent or ""))
    return by_name, by_id


_TEAMS_CACHE = None


def teams_maps():
    global _TEAMS_CACHE
    if _TEAMS_CACHE is None:
        try:
            _TEAMS_CACHE = statsapi_teams()
        except Exception as e:
            print(f"WARNING: statsapi teams lookup failed ({e}); levels will be blank",
                  file=sys.stderr)
            _TEAMS_CACHE = ({}, {})
    return _TEAMS_CACHE


def read_mlb_pipeline(path):
    """MLB.com Pipeline scrape: org,rank,player,position,eta,age,...,current_team,overall_grade,mlb_id."""
    levels = teams_maps()[0]
    out, unmapped = {}, set()
    for row in csv.DictReader(open(path)):
        team = abbrev(row["org"])
        rank = to_int(row.get("rank"))
        if rank is None:
            continue
        club = (row.get("current_team") or "").strip()
        level = levels.get(club)   # includes parent clubs -> "MLB" (prospect in the majors)
        if club and level is None:
            unmapped.add(club)
        out.setdefault(team, []).append({
            "rank": rank,
            "mlb": rank,
            "ba": None,
            "name": (row.get("player") or "").strip(),
            "pos": (row.get("position") or "").strip().upper(),
            "level": level,
            "age": to_int(row.get("age")),
            "_id": (row.get("mlb_id") or "").strip() or None,
        })
    if unmapped:
        print(f"WARNING: {len(unmapped)} affiliates missing from statsapi map: "
              f"{sorted(unmapped)}", file=sys.stderr)
    for team in out:
        out[team].sort(key=lambda p: p["rank"])
    return out


def read_orgreview(text):
    """Legacy org-review scrape. Re-runs get appended, so a (team, rank) can
    appear twice with different players — the later row is fresher. Keep last."""
    best = {}
    for row in csv.DictReader(io.StringIO(text)):
        team = (row.get("team_abbrev") or "").strip()
        rank = to_int(row.get("rank"))
        if team and rank is not None:
            best[(team, rank)] = row
    out = {}
    for (team, rank), row in best.items():
        out.setdefault(team, []).append({
            "rank": rank,
            "mlb": rank,
            "ba": None,
            "name": (row.get("name") or "").strip(),
            "pos": (row.get("pos") or "").strip().upper(),
            "level": (row.get("level") or "").strip() or None,
            "age": to_int(row.get("age")),
            "eta": to_int(row.get("eta")),
            "bonus": parse_bonus(row.get("bonus")),
            "from": (row.get("signed_from") or "").strip() or None,
            "mkt": (row.get("sign_mkt") or "").strip() or None,
        })
    for team in out:
        out[team].sort(key=lambda p: p["rank"])
    return out


def read_ba(path):
    out = {}
    for row in csv.DictReader(open(path)):
        team_full = (row.get("Team") or "").strip()
        if not team_full:
            continue
        rank = to_int(row.get("T-30 Rank"))
        if rank is None:
            continue
        team = abbrev(team_full)
        name = (row.get("Player") or "").strip()
        name = ALIASES.get((team, name), name)
        out.setdefault(team, []).append({"rank": rank, "name": name})
    return out


def rerank(out):
    """Composite order: mean of source ranks (missing source counts MISS)."""
    for rows in out.values():
        rows.sort(key=lambda p: (((p["mlb"] or MISS) + (p["ba"] or MISS)) / 2,
                                 min(p["mlb"] or MISS, p["ba"] or MISS),
                                 norm(p["name"])))
        for i, p in enumerate(rows, 1):
            p["rank"] = i


def merge_ba(out, ba, verbose=True):
    """Attach BA ranks to MLB.com entries by name (exact norm, then fuzzy);
    append BA-only players; re-rank each org on the composite score."""
    stats = {"exact": 0, "fuzzy": 0, "ba_only": 0, "mlb_only": 0}
    fuzzy_pairs, ba_only = [], []
    for team, ba_rows in ba.items():
        rows = out.setdefault(team, [])
        by_norm = {}
        for p in rows:
            by_norm.setdefault(norm(p["name"]), p)
        for b in ba_rows:
            key = norm(b["name"])
            p = by_norm.get(key)
            if p is None:
                cands = [k for k in by_norm if by_norm[k]["ba"] is None]
                hit = difflib.get_close_matches(key, cands, n=1, cutoff=FUZZY_MIN)
                if hit:
                    p = by_norm[hit[0]]
                    fuzzy_pairs.append((team, b["name"], p["name"]))
                    stats["fuzzy"] += 1
            else:
                stats["exact"] += 1
            if p is not None and p["ba"] is None:
                p["ba"] = b["rank"]
            else:
                rows.append({"rank": None, "mlb": None, "ba": b["rank"], "name": b["name"],
                             "pos": "", "level": None, "age": None})
                ba_only.append((team, b["rank"], b["name"]))
                stats["ba_only"] += 1
    for team, rows in out.items():
        stats["mlb_only"] += sum(1 for p in rows if p["ba"] is None)
    rerank(out)
    if verbose:
        print(f"BA merge: {stats['exact']} exact, {stats['fuzzy']} fuzzy, "
              f"{stats['ba_only']} BA-only appended, {stats['mlb_only']} MLB-only")
        for t, b, m in fuzzy_pairs:
            print(f"  fuzzy  {t}: BA {b!r} -> MLB {m!r}")
        for t, r, n in ba_only:
            print(f"  BAonly {t}: #{r} {n}")
    return out


def enrich_ba_only(out):
    """BA's T30 file is name+rank only. Fill pos/level/age for those entries
    from the statsapi people search, accepting only hits whose current club
    belongs to the same org (guards against same-name players elsewhere)."""
    import datetime, urllib.parse
    by_id = teams_maps()[1]
    if not by_id:
        return
    today = datetime.date.today()
    done = missed = 0
    misses = []

    def search(q):
        url = (STATSAPI + "/people/search?hydrate=currentTeam&names="
               + urllib.parse.quote(q))
        with urllib.request.urlopen(url, timeout=20) as r:
            return json.load(r).get("people", [])

    def org_hits(people, team):
        return [q for q in people
                if by_id.get((q.get("currentTeam") or {}).get("id"), (None, None))[1] == team]

    folded = 0
    for team, rows in out.items():
        idmap = {e["_id"]: e for e in rows if e.get("_id")}
        for p in list(rows):
            if p["pos"] or p["level"] or p["age"] is not None:
                continue
            # registered names differ from BA's (Leo vs Leonardo), so fall back
            # to a surname search scoped to the org, then best-name similarity
            queries = [p["name"]]
            toks = p["name"].split()
            if len(toks) > 1:
                queries.append(" ".join(toks[1:]))
                if len(toks) > 2:
                    queries.append(toks[-1])
            hits, tried = [], 0
            try:
                for q in queries:
                    people = search(q)
                    tried += len(people)
                    hits = org_hits(people, team)
                    if hits:
                        break
            except Exception as e:
                misses.append((team, p["name"], f"lookup failed: {e}"))
                missed += 1
                continue
            if not hits:
                misses.append((team, p["name"], f"{tried} result(s), none in org"))
                missed += 1
                continue
            # surname alone isn't identity — require compatible first names
            # (exact, or one prefixes the other: Leo/Leonardo, Cam/Cameron)
            def first_ok(q):
                a = (norm(p["name"]).split() or [""])[0]
                b = (norm(q.get("fullName") or "").split() or [""])[0]
                return a == b or (min(len(a), len(b)) >= 3
                                  and (a.startswith(b) or b.startswith(a)))
            named = [q for q in hits if first_ok(q)]
            if not named:
                misses.append((team, p["name"],
                               "org hit(s) with wrong first name: "
                               + ", ".join(repr(q.get("fullName")) for q in hits[:3])))
                missed += 1
                continue
            named.sort(key=lambda q: difflib.SequenceMatcher(
                None, norm(p["name"]), norm(q.get("fullName") or "")).ratio(), reverse=True)
            q = named[0]
            if norm(q.get("fullName") or "") != norm(p["name"]):
                print(f"  ~match {team}: BA {p['name']!r} -> statsapi {q.get('fullName')!r}")
            # identity check: BA spelled an MLB.com T30 player differently and the
            # name merge missed him — fold the BA rank into the existing entry
            pid = str(q.get("id") or "") or None
            existing = idmap.get(pid)
            if existing is not None and existing is not p:
                if existing["ba"] is None:
                    existing["ba"] = p["ba"]
                rows.remove(p)
                folded += 1
                print(f"  dedup  {team}: BA {p['name']!r} is MLB.com {existing['name']!r} — merged")
                continue
            if pid:
                p["_id"] = pid
                idmap[pid] = p
            pos = (q.get("primaryPosition") or {}).get("abbreviation") or ""
            if pos == "P":
                hand = ((q.get("pitchHand") or {}).get("code") or "").upper()
                pos = {"R": "RHP", "L": "LHP"}.get(hand, "P")
            p["pos"] = pos
            p["level"] = by_id[q["currentTeam"]["id"]][0]
            bd = q.get("birthDate")
            if bd:
                b = datetime.date.fromisoformat(bd)
                p["age"] = today.year - b.year - ((today.month, today.day) < (b.month, b.day))
            done += 1
    rerank(out)
    print(f"statsapi enrich: {done} BA-only players filled, {folded} duplicates folded, "
          f"{missed} unresolved")
    for t, n, why in misses:
        print(f"  miss   {t}: {n} ({why})", file=sys.stderr)


def apply_fill(out, path):
    """Hand-curated pos/level/age for players no feed or API covers
    (scripts/prospect_fill.csv, sourced from BA team pages). Fills blanks only."""
    filled, unmatched = 0, []
    entries = {(t, norm(p["name"])): p for t, rows in out.items() for p in rows}
    for row in csv.DictReader(open(path)):
        p = entries.get(((row.get("team") or "").strip(), norm(row.get("name") or "")))
        if p is None:
            unmatched.append(f"{row.get('team')}/{row.get('name')}")
            continue
        hit = False
        if not p["pos"] and (row.get("pos") or "").strip():
            p["pos"] = row["pos"].strip().upper()
            hit = True
        if p["level"] is None and (row.get("level") or "").strip():
            p["level"] = row["level"].strip()
            hit = True
        if p["age"] is None and to_int(row.get("age")) is not None:
            p["age"] = to_int(row.get("age"))
            hit = True
        filled += hit
    print(f"fill: {filled} players patched from {path.name}")
    if unmatched:
        print(f"WARNING: fill rows matching no entry: {', '.join(unmatched)}",
              file=sys.stderr)


def read_top100(path, rankcol):
    """League-wide top-100 CSV -> ({mlb_id: rank}, {(team, norm_name): rank})."""
    by_id, by_key = {}, {}
    for row in csv.DictReader(open(path)):
        rank = to_int(row.get(rankcol))
        if rank is None:
            continue
        pid = (row.get("mlb_id") or "").strip()
        if pid:
            by_id[pid] = rank
        by_key[(abbrev(row["org"]), norm(row.get("player") or ""))] = rank
    return by_id, by_key


def attach_t100(out, mlb100, ba100):
    """Stamp t100:{mlb,ba} on T30 entries appearing on either league-wide
    top-100 list. Match by mlb_id, else by (org, normalized name)."""
    hit = {"mlb": set(), "ba": set()}
    for team, rows in out.items():
        for p in rows:
            t = {}
            for src, (by_id, by_key) in (("mlb", mlb100), ("ba", ba100)):
                r = by_id.get(p.get("_id")) if p.get("_id") else None
                if r is None:
                    r = by_key.get((team, norm(p["name"])))
                if r is not None:
                    t[src] = r
                    hit[src].add(r)
            if t:
                p["t100"] = t
    for src, (_, by_key) in (("mlb", mlb100), ("ba", ba100)):
        missed = sorted((r, t, n) for (t, n), r in by_key.items() if r not in hit[src])
        if missed:
            print(f"WARNING: {len(missed)} {src} top-100 players not matched to any "
                  f"T30 entry:", file=sys.stderr)
            for r, t, n in missed:
                print(f"  {src}100 #{r} {t} {n}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mlb", help="MLB.com Pipeline T30 CSV (org/player/... format)")
    ap.add_argument("--csv", help="legacy org-review scrape CSV (local path)")
    ap.add_argument("--ba", help="Baseball America T30 CSV (Team, Player, T-30 Rank)")
    ap.add_argument("--mlb100", help="MLB.com Pipeline top-100 CSV (rank column: rank)")
    ap.add_argument("--ba100", help="Baseball America top-100 CSV (rank column: ba_rank)")
    args = ap.parse_args()

    if args.mlb:
        out = read_mlb_pipeline(args.mlb)
    else:
        if args.csv:
            text = Path(args.csv).read_text()
        else:
            text = subprocess.run(
                ["gh", "api", "-H", "Accept: application/vnd.github.raw", REPO_PATH],
                capture_output=True, text=True, check=True).stdout
        out = read_orgreview(text)

    if args.ba:
        out = merge_ba(out, read_ba(args.ba))
        enrich_ba_only(out)
        if FILL.exists():
            apply_fill(out, FILL)
    if args.mlb100 or args.ba100:
        attach_t100(out,
                    read_top100(args.mlb100, "rank") if args.mlb100 else ({}, {}),
                    read_top100(args.ba100, "ba_rank") if args.ba100 else ({}, {}))

    # lean output — per-source ranks feed the composite but aren't published;
    # t100 rides along only on players holding a league-wide top-100 spot
    keep = ("rank", "name", "pos", "level", "age")
    out = {t: [{**{k: p.get(k) for k in keep},
                **({"t100": p["t100"]} if p.get("t100") else {})}
               for p in rows] for t, rows in out.items()}

    OUT.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    n = sum(len(v) for v in out.values())
    print(f"wrote {OUT} — {len(out)} teams, {n} prospects")
    if len(out) != 30:
        print("WARNING: expected 30 teams", file=sys.stderr)


if __name__ == "__main__":
    main()
