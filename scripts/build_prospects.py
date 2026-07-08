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

STATSAPI_TEAMS = "https://statsapi.mlb.com/api/v1/teams?sportIds=11,12,13,14,16,17&season=2026"
SPORT_LEVEL = {11: "AAA", 12: "AA", 13: "A+", 14: "A", 16: "ROK", 17: "ROK"}

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


def affiliate_levels():
    """affiliate club name -> AAA/AA/A+/A/ROK via statsapi."""
    with urllib.request.urlopen(STATSAPI_TEAMS, timeout=30) as r:
        teams = json.load(r)["teams"]
    return {t["name"]: SPORT_LEVEL.get((t.get("sport") or {}).get("id")) for t in teams}


def read_mlb_pipeline(path):
    """MLB.com Pipeline scrape: org,rank,player,position,eta,age,...,current_team,overall_grade,mlb_id."""
    try:
        levels = affiliate_levels()
    except Exception as e:
        print(f"WARNING: statsapi affiliate lookup failed ({e}); levels will be blank",
              file=sys.stderr)
        levels = {}
    out, unmapped = {}, set()
    for row in csv.DictReader(open(path)):
        team = abbrev(row["org"])
        rank = to_int(row.get("rank"))
        if rank is None:
            continue
        club = (row.get("current_team") or "").strip()
        # current_team can be the parent club — the prospect is in the majors
        level = "MLB" if club in TEAM_ABBREV else levels.get(club)
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
            "eta": to_int(row.get("eta")),
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
        out.setdefault(abbrev(team_full), []).append(
            {"rank": rank, "name": (row.get("Player") or "").strip()})
    return out


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
                             "pos": "", "level": None, "age": None, "eta": None})
                ba_only.append((team, b["rank"], b["name"]))
                stats["ba_only"] += 1
    for team, rows in out.items():
        stats["mlb_only"] += sum(1 for p in rows if p["ba"] is None)
        rows.sort(key=lambda p: (((p["mlb"] or MISS) + (p["ba"] or MISS)) / 2,
                                 min(p["mlb"] or MISS, p["ba"] or MISS),
                                 norm(p["name"])))
        for i, p in enumerate(rows, 1):
            p["rank"] = i
    if verbose:
        print(f"BA merge: {stats['exact']} exact, {stats['fuzzy']} fuzzy, "
              f"{stats['ba_only']} BA-only appended, {stats['mlb_only']} MLB-only")
        for t, b, m in fuzzy_pairs:
            print(f"  fuzzy  {t}: BA {b!r} -> MLB {m!r}")
        for t, r, n in ba_only:
            print(f"  BAonly {t}: #{r} {n}")
    return out


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
    if args.mlb100 or args.ba100:
        attach_t100(out,
                    read_top100(args.mlb100, "rank") if args.mlb100 else ({}, {}),
                    read_top100(args.ba100, "ba_rank") if args.ba100 else ({}, {}))

    # lean output — per-source ranks feed the composite but aren't published;
    # t100 rides along only on players holding a league-wide top-100 spot
    keep = ("rank", "name", "pos", "level", "age", "eta")
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
