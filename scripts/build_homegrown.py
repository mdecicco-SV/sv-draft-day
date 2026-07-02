#!/usr/bin/env python3
"""Bake homegrown-by-level counts per MLB org from the MLB StatsAPI.

Homegrown = a player on an org's active roster (any level, MLB through Rookie)
whose most recent amateur-draft selection was by that org. International
signees carry no draft record and are excluded, so this measures drafted-and-
retained talent — the draft-day-relevant sense of "homegrown".

Writes public/data/homegrown.json keyed by MLB team id:
  { "136": { "MLB": 4, "AAA": 2, "AA": 1, "A+": 3, "A": 0, "RK": 0, "total": 10 }, ... }

Run whenever a refresh is wanted:  python3 scripts/build_homegrown.py
"""
import json
import os
import time
import urllib.request

BASE = "https://statsapi.mlb.com/api/v1"
SEASON = 2026
LEVELS = [(1, "MLB"), (11, "AAA"), (12, "AA"), (13, "A+"), (14, "A"), (16, "RK")]
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "data", "homegrown.json")


def get(url):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())


def main():
    clubs = get(f"{BASE}/teams?sportId=1&season={SEASON}")["teams"]
    club_ids = {t["id"] for t in clubs}
    out = {str(cid): {lvl: 0 for _, lvl in LEVELS} | {"total": 0} for cid in club_ids}

    for sport_id, lvl in LEVELS:
        teams = clubs if sport_id == 1 else get(f"{BASE}/teams?sportId={sport_id}&season={SEASON}")["teams"]
        for t in teams:
            parent = t["id"] if sport_id == 1 else t.get("parentOrgId")
            if parent not in club_ids:
                continue
            url = f"{BASE}/teams/{t['id']}/roster?rosterType=active&season={SEASON}&hydrate=person(draft)"
            try:
                roster = get(url).get("roster", [])
            except Exception as e:
                print(f"  ! {t.get('name')}: {e}")
                continue
            for entry in roster:
                drafts = entry.get("person", {}).get("drafts", [])
                if not drafts:
                    continue
                # multiple selections possible (drafted, unsigned, re-drafted) and the
                # feed returns them unordered — the newest one is the signing club
                last = max(drafts, key=lambda d: int(d.get("year") or 0))
                if (last.get("team") or {}).get("id") == parent:
                    out[str(parent)][lvl] += 1
                    out[str(parent)]["total"] += 1
            time.sleep(0.08)
        print(f"✓ {lvl}")

    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
