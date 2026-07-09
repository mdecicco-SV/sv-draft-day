#!/usr/bin/env python3
"""Bake public/data/regime.json — front-office regime info per MLB org (GM /
scouting director tenure + provenance), used by the Team Fit "regime" read.

Source: Stadium-Ventures/sv-draft-fit public/data/regime_data.json (private repo,
fetched via `gh api`). Keyed by team abbrev with fields org, gm, gm_title,
gm_start_year, prior_org, scouting_director, sd_start_year, sd_prior_org, notes.

Keys and prior_org/sd_prior_org values use the source repo's abbrevs, which
differ from this app's in six spots — normalized on the way in:
  KCR->KC, SDP->SD, SFG->SF, TBR->TB, WSN->WSH, OAK->ATH

Usage: python3 scripts/build_regime.py
"""
import base64
import json
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "public", "data", "regime.json")

SRC_REPO = "Stadium-Ventures/sv-draft-fit"
SRC_PATH = "public/data/regime_data.json"

ABBR_FIX = {"KCR": "KC", "SDP": "SD", "SFG": "SF", "TBR": "TB", "WSN": "WSH", "OAK": "ATH"}

# Post-snapshot front-office changes the sv-draft-fit source (dormant since Apr '26)
# doesn't know about — merged on top of the fetched data so a rebake keeps them.
OVERRIDES = {
    "LAA": {"gm": "John Mozeliak", "gm_title": "Interim GM", "gm_start_year": 2026, "prior_org": "STL",
            "notes": "Minasian fired 2026-06-27; Mozeliak (STL 2007-25) interim while GM search runs. McIlvaine from Brewers."},
}


def fetch_source():
    out = subprocess.run(
        ["gh", "api", f"repos/{SRC_REPO}/contents/{SRC_PATH}", "--jq", ".content"],
        check=True, capture_output=True, text=True,
    ).stdout
    return json.loads(base64.b64decode(out))


def norm_abbr(a):
    return ABBR_FIX.get(a, a)


def main():
    raw = fetch_source()
    out = {}
    for team, rec in raw.items():
        rec = dict(rec)
        if rec.get("prior_org"):
            rec["prior_org"] = norm_abbr(rec["prior_org"])
        if rec.get("sd_prior_org"):
            rec["sd_prior_org"] = norm_abbr(rec["sd_prior_org"])
        out[norm_abbr(team)] = rec

    for team, patch in OVERRIDES.items():
        if team in out:
            out[team].update(patch)

    assert len(out) == 30, f"expected 30 teams, got {len(out)}"

    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    kb = os.path.getsize(OUT) // 1024
    print(f"wrote {OUT} ({kb} KB) — {len(out)} teams")
    sample = out.get("KC") or next(iter(out.values()))
    print("sample:", json.dumps(sample, indent=2))


if __name__ == "__main__":
    main()
