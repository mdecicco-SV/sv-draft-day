#!/usr/bin/env python3
"""Bake public/data/draftdb.json — the merged 2021-2025 MLB draft database that
feeds the org-fit / player-comp algorithm (see sv-draft-fit's PlayerInput/OrgFitScore).

Source: Stadium-Ventures/sv-draft-fit, public/data/draft_database_2021_2025.json —
a flat JSON array of DraftPick records (see that repo's src/lib/types.ts for the
authoritative field list: year, round, overall, mlbid, fg_id, name, first_name,
last_name, position, position_normalized, bats, throws, hs_or_college, school,
hs_name, hs_place, birth_date, team, team_abbrev, bonus, slot_value, bonus_vs_slot,
bonus_vs_slot_pct, home_city, home_state, school_class, height, weight,
spring_training_location/state/league, mlb_debut_date, reached_mlb, active,
current_team, total_war, war_source, war_seasons, mlb_career_hitting,
mlb_career_pitching, mlb_seasons, age_at_draft, college_stats,
college_career_stats, pg_stats).

The source file is already a clean, faithful DraftPick[]; this builder keeps the
flat-array shape but projects each pick down to only the fields the fit scoring
consumes (the full records — college_stats / pg_stats / MLB career objects — are
the bulk of the ~6MB source and would be too heavy as a browser payload):

  year, round, overall, mlbid (int|null), name, position_normalized,
  hs_or_college, team_abbrev, reached_mlb (coerced to bool),
  total_war (number|null), bonus_vs_slot_pct (number|null)

reached_mlb refresh: the source snapshot's reached_mlb flags go stale between
sv-draft-fit rebuilds (debuts keep happening), so at bake time every row with an
mlbid is re-checked against MLB StatsAPI (people?personIds=... in chunks of 100,
mirroring scripts/build_warhist.py fetch_debuts) and reached_mlb is set from the
live mlbDebutDate. Rows without an mlbid keep the source flag.

Normalization:
  - team_abbrev: source uses BBRef-style codes (KCR, SDP, SFG, TBR, WSN) and
    'OAK' for the Athletics; normalized here to the short codes this app uses
    elsewhere (KC, SD, SF, TB, WSH, ATH). The full `team` name is dropped from
    the payload — team_abbrev is the join key.
  - one 2021 anomaly: 21 "Cleveland Indians" picks carry an empty team_abbrev
    in the source (pre-rebrand team object didn't resolve to an abbrev code) —
    backfilled to CLE via the `team` full-name string before it is dropped.

sv-draft-fit is a private repo, so the source is pulled via `gh api` (the `gh`
CLI must already be authenticated with access to Stadium-Ventures). The repo's
contents API truncates this file's content (~6MB, over the API's ~1MB inline
cap), so this fetches the blob sha from the tree and reads it via the git
blobs API instead.

Usage: python3 scripts/build_draftdb.py [--cache PATH]  # cache: reuse/save raw fetch
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "public", "data", "draftdb.json")

SRC_REPO = "Stadium-Ventures/sv-draft-fit"
SRC_PATH = "public/data/draft_database_2021_2025.json"

# BBRef/legacy code -> short code used across this app.
ABBREV_FIX = {
    "KCR": "KC", "SDP": "SD", "SFG": "SF", "TBR": "TB", "WSN": "WSH", "OAK": "ATH",
}

# Fallback when team_abbrev is missing/blank in the source: full team name -> abbrev
# (post-fix, i.e. already the short code this app uses).
NAME_TO_ABBREV = {
    "Arizona Diamondbacks": "ARI", "Athletics": "ATH", "Oakland Athletics": "ATH",
    "Atlanta Braves": "ATL", "Baltimore Orioles": "BAL", "Boston Red Sox": "BOS",
    "Chicago Cubs": "CHC", "Chicago White Sox": "CHW", "Cincinnati Reds": "CIN",
    "Cleveland Guardians": "CLE", "Cleveland Indians": "CLE",
    "Colorado Rockies": "COL", "Detroit Tigers": "DET", "Houston Astros": "HOU",
    "Kansas City Royals": "KC", "Los Angeles Angels": "LAA",
    "Los Angeles Dodgers": "LAD", "Miami Marlins": "MIA", "Milwaukee Brewers": "MIL",
    "Minnesota Twins": "MIN", "New York Mets": "NYM", "New York Yankees": "NYY",
    "Philadelphia Phillies": "PHI", "Pittsburgh Pirates": "PIT",
    "San Diego Padres": "SD", "San Francisco Giants": "SF", "Seattle Mariners": "SEA",
    "St. Louis Cardinals": "STL", "Tampa Bay Rays": "TB", "Texas Rangers": "TEX",
    "Toronto Blue Jays": "TOR", "Washington Nationals": "WSH",
}


def num_or_none(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def int_or_none(v):
    if v is None or v == "":
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def slim(pick):
    """Project a full DraftPick record down to the fit-scoring payload."""
    ab = (pick.get("team_abbrev") or "").strip()
    ab = ABBREV_FIX.get(ab, ab)
    if not ab:
        ab = NAME_TO_ABBREV.get((pick.get("team") or "").strip(), ab)
    return {
        "year": pick.get("year"),
        "round": pick.get("round"),
        "overall": pick.get("overall"),
        "mlbid": int_or_none(pick.get("mlbid")),
        "name": pick.get("name"),
        "position_normalized": pick.get("position_normalized"),
        "hs_or_college": pick.get("hs_or_college"),
        "team_abbrev": ab,
        "reached_mlb": bool(pick.get("reached_mlb")),
        "total_war": num_or_none(pick.get("total_war")),
        "bonus_vs_slot_pct": num_or_none(pick.get("bonus_vs_slot_pct")),
    }


def gh_json(args):
    out = subprocess.run(["gh", "api"] + args, capture_output=True, text=True, check=True)
    return out.stdout


def fetch_source():
    """Pull draft_database_2021_2025.json from sv-draft-fit via the git blob API
    (the contents API truncates it — see docstring)."""
    tree = json.loads(gh_json([f"repos/{SRC_REPO}/git/trees/HEAD?recursive=1"]))
    sha = next(e["sha"] for e in tree["tree"] if e["path"] == SRC_PATH)
    blob = json.loads(gh_json([f"repos/{SRC_REPO}/git/blobs/{sha}"]))
    return json.loads(base64.b64decode(blob["content"]))


def fetch_debuts(mlbids, cache_path=None):
    """statsapi people lookup in chunks of 100 -> {mlbid(int): mlbDebutDate or None}.
    Mirrors scripts/build_warhist.py fetch_debuts. Cached to cache_path when given
    so re-runs skip the fetch."""
    if cache_path and os.path.exists(cache_path):
        return {int(k): v for k, v in json.load(open(cache_path)).items()}
    out = {}
    ids = sorted({str(i) for i in mlbids if i})
    for i in range(0, len(ids), 100):
        chunk = ids[i:i+100]
        url = ("https://statsapi.mlb.com/api/v1/people?personIds=" + ",".join(chunk)
               + "&fields=people,id,mlbDebutDate")
        for attempt in range(3):
            try:
                with urllib.request.urlopen(url, timeout=30) as resp:
                    data = json.load(resp)
                for p in data.get("people", []):
                    out[int(p["id"])] = p.get("mlbDebutDate")
                break
            except Exception as e:
                if attempt == 2:
                    print(f"  !! statsapi debut chunk failed: {e}", file=sys.stderr)
                else:
                    time.sleep(1.5)
        print(f"  debuts {min(i+100, len(ids))}/{len(ids)}", file=sys.stderr)
    if cache_path:
        json.dump({str(k): v for k, v in out.items()}, open(cache_path, "w"))
    return out


def refresh_reached_mlb(picks, cache_path=None):
    """Re-check reached_mlb against live statsapi mlbDebutDate for every pick
    with an mlbid (rows without one keep the source flag). Returns the picks
    whose flag flipped false->true (recent debuts the source snapshot missed)."""
    debuts = fetch_debuts([p["mlbid"] for p in picks if p["mlbid"]], cache_path)
    flipped = []
    for p in picks:
        if p["mlbid"] is None or p["mlbid"] not in debuts:
            continue
        reached = bool(debuts[p["mlbid"]])
        if reached and not p["reached_mlb"]:
            flipped.append(p)
        p["reached_mlb"] = reached
    return flipped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", help="read/write the raw fetched source here (skip refetch if present)")
    args = ap.parse_args()

    if args.cache and os.path.exists(args.cache):
        with open(args.cache, encoding="utf-8") as f:
            raw = json.load(f)
    else:
        raw = fetch_source()
        if args.cache:
            with open(args.cache, "w", encoding="utf-8") as f:
                json.dump(raw, f)

    picks = [slim(p) for p in raw]

    n_reached_src = sum(1 for p in picks if p["reached_mlb"])
    flipped = refresh_reached_mlb(picks, args.cache + ".debuts.json" if args.cache else None)

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(picks, f, separators=(",", ":"))

    kb = os.path.getsize(OUT) // 1024
    teams = sorted({p["team_abbrev"] for p in picks if p["team_abbrev"]})
    years = sorted({p["year"] for p in picks})
    n_reached = sum(1 for p in picks if p["reached_mlb"])
    n_war = sum(1 for p in picks if p["total_war"] is not None)
    n_bonus = sum(1 for p in picks if p["bonus_vs_slot_pct"] is not None)

    print(f"wrote {OUT} ({kb} KB)")
    print(f"picks: {len(picks)}")
    print(f"teams: {len(teams)} -> {teams}")
    print(f"years: {years[0]}-{years[-1]}")
    print(f"reached_mlb=true: {n_reached_src} (source) -> {n_reached} (statsapi refresh)")
    print(f"flipped false->true ({len(flipped)}):")
    for p in sorted(flipped, key=lambda p: (p["year"], p["overall"])):
        print(f"  {p['name']} ({p['team_abbrev']} {p['year']}, ov {p['overall']})")
    print(f"total_war not null: {n_war}")
    print(f"bonus_vs_slot_pct not null: {n_bonus}")
    if picks:
        print("sample pick:", json.dumps(picks[0], indent=2))


if __name__ == "__main__":
    main()
