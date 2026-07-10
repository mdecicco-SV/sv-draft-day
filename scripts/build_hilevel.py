#!/usr/bin/env python3
"""Bake public/data/hilevel.json — highest pro level reached per drafted player,
keyed by mlbid, for the Research tab's optional "Hi Level" display column.

Source ids: the slot-tracker CSV (phase June-Reg, ALL rounds/years — Research
covers the full tracker). Local checkout preferred, hosted copy as fallback.

Resolution, top-down (a player resolves at the first level that hits):
  MLB — people lookup shows an mlbDebutDate
  AAA / AA / A+ / A / Rk — batched people?personIds hydrate=stats(yearByYear,
  sportId=N) probes: 11=AAA, 12=AA, 13=A+, 14=A, 15=short-season A (folded
  into "A"), 16=Rookie. Ids still unresolved after all probes (unsigned HS
  kids, no pro record) are omitted — the front end renders them as "—".

Usage: python3 scripts/build_hilevel.py
"""
import csv, io, json, os, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CSV_LOCAL = os.path.expanduser("~/Desktop/claude/draft-slot-tracker/data.csv")
CSV_URL = "https://mdecicco-sv.github.io/draft-slot-tracker/data.csv"
OUT = os.path.join(ROOT, "public", "data", "hilevel.json")

# probe order is the hierarchy — first hit wins
SPORT_LEVELS = [(11, "AAA"), (12, "AA"), (13, "A+"), (14, "A"), (15, "A"), (16, "Rk")]


def get_json(url, tries=3):
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                return json.load(resp)
        except Exception as e:
            if attempt == tries - 1:
                print(f"  !! {e} — {url[:120]}", file=sys.stderr)
                return None
            time.sleep(1.5)


def load_mlbids():
    if os.path.exists(CSV_LOCAL):
        txt = open(CSV_LOCAL, newline="").read()
        print(f"csv: {CSV_LOCAL}", file=sys.stderr)
    else:
        with urllib.request.urlopen(CSV_URL, timeout=30) as resp:
            txt = resp.read().decode("utf-8")
        print(f"csv: {CSV_URL} (no local checkout)", file=sys.stderr)
    ids = set()
    for r in csv.DictReader(io.StringIO(txt)):
        if r.get("phase") != "June-Reg":
            continue
        i = (r.get("mlbid") or "").strip()
        if i.isdigit():
            ids.add(i)
    return sorted(ids, key=int)


def fetch_debuts(ids):
    """chunked people lookup → set of mlbids with an MLB debut"""
    debuted = set()
    for i in range(0, len(ids), 100):
        chunk = ids[i:i + 100]
        data = get_json("https://statsapi.mlb.com/api/v1/people?personIds="
                        + ",".join(chunk) + "&fields=people,id,mlbDebutDate")
        for p in (data or {}).get("people", []):
            if p.get("mlbDebutDate"):
                debuted.add(str(p["id"]))
        print(f"  debuts {min(i+100, len(ids))}/{len(ids)}", file=sys.stderr)
    return debuted


def probe_level(ids, sport_id):
    """batched yearByYear hydration at one sport level → set of mlbids with splits there"""
    hit = set()
    for i in range(0, len(ids), 100):
        chunk = ids[i:i + 100]
        data = get_json("https://statsapi.mlb.com/api/v1/people?personIds=" + ",".join(chunk)
                        + f"&hydrate=stats(group=[hitting,pitching],type=[yearByYear],sportId={sport_id})"
                        + "&fields=people,id,stats,splits,season")
        for p in (data or {}).get("people", []):
            if any(s.get("splits") for s in p.get("stats", [])):
                hit.add(str(p["id"]))
    return hit


def main():
    ids = load_mlbids()
    print(f"{len(ids)} tracker mlbids", file=sys.stderr)

    levels = {}
    debuted = fetch_debuts(ids)
    for i in debuted:
        levels[i] = "MLB"
    pool = [i for i in ids if i not in levels]
    print(f"  MLB: {len(debuted)} — probing minors for {len(pool)}", file=sys.stderr)

    for sport_id, label in SPORT_LEVELS:
        if not pool:
            break
        hit = probe_level(pool, sport_id)
        for i in hit:
            levels[i] = label
        pool = [i for i in pool if i not in levels]
        print(f"  {label} (sport {sport_id}): +{len(hit)}, {len(pool)} unresolved", file=sys.stderr)

    json.dump(levels, open(OUT, "w"), separators=(",", ":"))
    kb = os.path.getsize(OUT) // 1024
    counts = {}
    for v in levels.values():
        counts[v] = counts.get(v, 0) + 1
    print(f"wrote {OUT} ({kb} KB) — {counts}; {len(pool)} with no pro record (omitted)", file=sys.stderr)


if __name__ == "__main__":
    main()
