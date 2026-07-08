#!/usr/bin/env python3
"""Bake public/data/drafthist.json — per-org draft history (2018-2025, rounds 1-10)
from the slot-tracker CSV, with a baked outcome per pick so the front end can score
"how has this org done with <position> at <price>" and surface comps.

Source: ~/Desktop/claude/draft-slot-tracker/data.csv (phase June-Reg only).
Outcomes:
  mlb — player has an MLB debut date (statsapi)
  t30 — no debut yet, but currently on ANY org Top-30 (public/data/prospects.json)
  act — still active in pro ball (statsapi active flag)
  out — inactive / released
Precedence mlb > t30 > act > out. mlb/t30 read as "hits" in the UI; recent classes
are naturally act-heavy, the front end handles the age weighting.

Usage: python3 scripts/build_drafthist.py
"""
import csv, json, os, re, sys, time, unicodedata, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CSV = os.path.expanduser("~/Desktop/claude/draft-slot-tracker/data.csv")
PROSPECTS = os.path.join(ROOT, "public", "data", "prospects.json")
OUT = os.path.join(ROOT, "public", "data", "drafthist.json")

TEAM_ABBR = {
    "Arizona Diamondbacks": "ARI", "Atlanta Braves": "ATL", "Baltimore Orioles": "BAL",
    "Boston Red Sox": "BOS", "Chicago Cubs": "CHC", "Chicago White Sox": "CHW",
    "Cincinnati Reds": "CIN", "Cleveland Guardians": "CLE", "Cleveland Indians": "CLE",
    "Colorado Rockies": "COL", "Detroit Tigers": "DET", "Houston Astros": "HOU",
    "Kansas City Royals": "KC", "Los Angeles Angels": "LAA", "Los Angeles Dodgers": "LAD",
    "Miami Marlins": "MIA", "Milwaukee Brewers": "MIL", "Minnesota Twins": "MIN",
    "New York Mets": "NYM", "New York Yankees": "NYY", "Athletics": "ATH",
    "Oakland Athletics": "ATH", "Philadelphia Phillies": "PHI", "Pittsburgh Pirates": "PIT",
    "San Diego Padres": "SD", "San Francisco Giants": "SF", "Seattle Mariners": "SEA",
    "St. Louis Cardinals": "STL", "Tampa Bay Rays": "TB", "Texas Rangers": "TEX",
    "Toronto Blue Jays": "TOR", "Washington Nationals": "WSH",
}

SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b\.?$")

def norm_name(s):
    """Mirror index.html normName so T30 matching can't drift."""
    s = unicodedata.normalize("NFD", (s or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[.'’`\-]", " ", s)
    s = SUFFIX.sub("", s)
    s = re.sub(r"[^a-z\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()

def pos_group(pos):
    """Primary listed position decides the group (CSV uses e.g. 'SS-2B', 'C-1B')."""
    p = (pos or "").upper().split("-")[0].strip()
    if p in ("P", "TWP"):
        return "P"
    if p == "C":
        return "C"
    if p in ("1B", "2B", "3B", "SS", "IF", "INF", "UT"):
        return "IF"
    if p in ("OF", "CF", "LF", "RF", "DH"):
        return "OF"
    return "?"

def load_rows():
    rows = []
    with open(CSV, newline="") as f:
        for r in csv.DictReader(f):
            if r.get("phase") != "June-Reg":
                continue
            try:
                rd = int(r["draftRound"])
                year = int(r["year"])
                ov = int((r["overall"] or "0").replace(",", ""))
            except ValueError:
                continue
            if rd > 10:
                continue
            team = TEAM_ABBR.get((r.get("teamname") or "").strip())
            if not team:
                print(f"  !! unmapped team {r.get('teamname')!r}", file=sys.stderr)
                continue
            bon = (r.get("bonus") or "").replace(",", "").strip()
            pos = (r.get("posit") or "").upper().split("-")[0].strip() or "?"
            if pos == "TWP":
                pos = "P"
            rows.append({
                "team": team, "y": year, "rd": rd, "ov": ov,
                "name": (r.get("fullName") or "").strip(),
                "pos": pos, "g": pos_group(r.get("posit")),
                "lvl": "HS" if (r.get("College or HS") or "").strip().upper() == "HS" else "C",
                "b": (r.get("Bats") or "").strip().upper() or None,
                "t": (r.get("Throws") or "").strip().upper() or None,
                "bon": int(bon) if bon.isdigit() else None,
                "mlbid": (r.get("mlbid") or "").strip(),
            })
    return rows

def fetch_status(mlbids):
    """statsapi people lookup in chunks → {mlbid: (debuted, active)}."""
    out = {}
    ids = [i for i in mlbids if i.isdigit()]
    for i in range(0, len(ids), 100):
        chunk = ids[i:i+100]
        url = ("https://statsapi.mlb.com/api/v1/people?personIds=" + ",".join(chunk)
               + "&fields=people,id,active,mlbDebutDate")
        for attempt in range(3):
            try:
                with urllib.request.urlopen(url, timeout=30) as resp:
                    data = json.load(resp)
                for p in data.get("people", []):
                    out[str(p["id"])] = (bool(p.get("mlbDebutDate")), bool(p.get("active")))
                break
            except Exception as e:
                if attempt == 2:
                    print(f"  !! statsapi chunk failed: {e}", file=sys.stderr)
                else:
                    time.sleep(1.5)
        print(f"  statsapi {min(i+100, len(ids))}/{len(ids)}", file=sys.stderr)
    return out

def main():
    rows = load_rows()
    print(f"{len(rows)} picks (rounds 1-10, 2018-2025)", file=sys.stderr)

    t30 = set()
    try:
        pj = json.load(open(PROSPECTS))
        for team, plist in pj.items():
            for p in plist:
                t30.add(norm_name(p.get("name")))
    except Exception as e:
        print(f"  !! prospects.json unreadable ({e}) — t30 outcomes will be empty", file=sys.stderr)

    status = fetch_status(sorted({r["mlbid"] for r in rows if r["mlbid"]}))

    orgs, counts = {}, {"mlb": 0, "t30": 0, "act": 0, "out": 0}
    for r in rows:
        debuted, active = status.get(r["mlbid"], (False, False))
        if debuted:
            o = "mlb"
        elif norm_name(r["name"]) in t30:
            o = "t30"
        elif active:
            o = "act"
        else:
            o = "out"
        counts[o] += 1
        pick = {k: r[k] for k in ("y", "rd", "ov", "name", "pos", "g", "lvl", "b", "t", "bon")}
        pick["out"] = o
        orgs.setdefault(r["team"], []).append(pick)

    for t in orgs:
        orgs[t].sort(key=lambda p: (-p["y"], p["ov"]))

    payload = {"years": [2018, 2025], "rounds": 10, "counts": counts, "orgs": orgs}
    json.dump(payload, open(OUT, "w"), separators=(",", ":"))
    kb = os.path.getsize(OUT) // 1024
    print(f"wrote {OUT} ({kb} KB) — outcomes {counts}", file=sys.stderr)

if __name__ == "__main__":
    main()
