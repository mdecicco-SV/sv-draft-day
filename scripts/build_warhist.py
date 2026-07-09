#!/usr/bin/env python3
"""Bake public/data/warhist.json — the pro-WAR draft lookback behind the Team Fit
Track-record upgrade: how much big-league value has each org actually extracted
from picks like <this player>, vs what those picks were expected to return?

Era = draft classes 2018+ (matches slot-history/aWAR coverage; first 2018-class
debut was Sept 2019). Two value metrics, different coverage — they complement,
not compete:
  bWAR  Baseball-Reference career WAR, realized-to-date. Carries the
        era-internal expected-value curve and the org WAR-over-expected (WOE)
        that grades orgs.
  aWAR  SV / MLBPA Mod3 metric (public/data/aWAR.xlsx). Draft classes 2018-2024
        only — it's the FEATURED value on recent-class comps, plus a
        recent-class aWAR/pick org stat.

Sources (free, no keys, run anywhere):
  statsapi.mlb.com/api/v1/draft/{year}                 draft sweep, overall <= 315
  baseball-reference.com/data/war_daily_{bat,pitch}.txt  career bWAR by mlb_ID
  public/data/aWAR.xlsx                                  aWAR (read dependency-free)

Method:
  - Career bWAR per player = sum across both B-Ref files; aggregates use max(WAR,0)
    ("value produced"); per-pick rows keep the raw number.
  - Expected-bWAR curve: mean clamped career bWAR by pick band, over ALL swept
    picks (2018-2025) — realized-to-date career bWAR by pick band. Era-internal
    and roughly zero-centered by construction (young classes depress both sides
    equally across orgs).
  - Org WOE: per org × {overall, posGroup, pickBand, HS/College}, over ALL
    swept picks: woe = (warSum - expSum) / (n + K), K=8 — shrink toward league,
    same idea as histSignal() in index.html.
  - aWAR: career aWAR per MLB.com Id (latest-Season "Career thru Season aWAR"),
    joined to the sweep by id (name fallback, "Last, First" -> normName). Attached
    as `aw` on per-pick rows; recent-class (2018-24) aWAR/pick baked per org.
  - Per-pick rows per org (newest first): {y, ov, n, g, lvl, bon, w(bWAR), aw?}.
  - Debut speed: median years from draft to MLB debut (statsapi mlbDebutDate),
    split HS vs College, over all swept picks that debuted (they're all 2018+
    classes now, no maturity gate needed) — baked as orgs[t].debutSpeed =
    {all, HS, College} alongside all/byG, plus league-wide medians in
    meta.lgDebutSpeed = {HS, College, all}.

Usage: python3 scripts/build_warhist.py [--awar path.xlsx|csv] [--cache-dir DIR]
"""
import argparse, csv, datetime, json, os, re, sys, time, unicodedata, urllib.request
import zipfile, xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "public", "data", "warhist.json")
AWAR_DEFAULT = os.path.join(ROOT, "public", "data", "aWAR.xlsx")

YEARS = list(range(2018, 2026))
ERA_FROM = 2018                # proven-value era = draft classes 2018+ (slot-history/aWAR coverage)
RECENT_FROM = 2018             # aWAR coverage starts here
MAX_OVERALL = 315              # ~rounds 1-10 in the modern format
SHRINK_K = 8

ID_TO_ABBR = {
    108:"LAA",109:"ARI",110:"BAL",111:"BOS",112:"CHC",113:"CIN",114:"CLE",115:"COL",
    116:"DET",117:"HOU",118:"KC",119:"LAD",120:"WSH",121:"NYM",133:"ATH",134:"PIT",
    135:"SD",136:"SEA",137:"SF",138:"STL",139:"TB",140:"TEX",141:"TOR",142:"MIN",
    143:"PHI",144:"ATL",145:"CHW",146:"MIA",147:"NYY",158:"MIL",
}

PICK_BANDS = [(1,5),(6,10),(11,20),(21,32),(33,50),(51,75),(76,110),(111,160),(161,230),(231,MAX_OVERALL)]
BAND_KEYS = [f"{lo}-{hi}" for lo, hi in PICK_BANDS]

def band_of(overall):
    for (lo, hi), k in zip(PICK_BANDS, BAND_KEYS):
        if lo <= overall <= hi:
            return k
    return None

SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b\.?")

def norm_name(s):
    """Mirror index.html normName. Accepts 'Last, First' (aWAR) -> swaps to 'First Last'."""
    s = (s or "").strip()
    if "," in s:
        a, b = s.split(",", 1)
        s = f"{b.strip()} {a.strip()}"
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[.'’`\-]", " ", s)
    s = SUFFIX.sub("", s)
    s = re.sub(r"[^a-z\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()

def pos_group(pos):
    p = (pos or "").upper()
    if p in ("P","SP","RP","RHP","LHP","TWP"): return "P"
    if p == "C": return "C"
    if p in ("1B","2B","3B","SS","IF","INF","UT"): return "IF"
    if p in ("OF","CF","LF","RF","DH"): return "OF"
    return "?"

def level_of(school_class, school_name, birth_year, draft_year):
    c = (school_class or "").upper()
    if c.startswith("HS"): return "HS"
    if c.startswith(("4YR","JC")): return "College"
    s = (school_name or "").lower()
    if any(k in s for k in ("high school"," hs","academy","prep")) and not any(
            k in s for k in ("university","college","state","institute","a&m")):
        return "HS"
    if any(k in s for k in ("university","college","state","institute","a&m","cc of","junior college","tech")):
        return "College"
    if birth_year and draft_year - birth_year <= 18:
        return "HS"
    if birth_year and draft_year - birth_year >= 20:
        return "College"
    return None

def get(url, tries=3):
    req = urllib.request.Request(url, headers={"Accept": "application/json",
        "User-Agent": "sv-draft-day warhist builder"})
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:
            if i == tries - 1: raise
            time.sleep(2 * (i + 1))

def load_war(cache_dir):
    """mlb_ID -> career bWAR; also norm-name -> career bWAR for the fallback join."""
    by_id, by_name = {}, {}
    for fn in ("war_daily_bat.txt", "war_daily_pitch.txt"):
        path = os.path.join(cache_dir, fn) if cache_dir else None
        if path and os.path.exists(path):
            text = open(path, encoding="utf-8", errors="replace").read()
        else:
            print(f"  fetching {fn} …", file=sys.stderr)
            text = get(f"https://www.baseball-reference.com/data/{fn}").decode("utf-8", "replace")
            if path:
                open(path, "w", encoding="utf-8").write(text)
        for row in csv.DictReader(text.splitlines()):
            w = row.get("WAR")
            if w in (None, "", "NULL", "NA"): continue
            try: w = float(w)
            except ValueError: continue
            mid = (row.get("mlb_ID") or "").strip()
            if mid and mid.isdigit():
                by_id[mid] = by_id.get(mid, 0.0) + w
            nk = norm_name(row.get("name_common"))
            if nk:
                by_name[nk] = by_name.get(nk, 0.0) + w
    return by_id, by_name

def sweep_drafts(cache_dir):
    picks = []
    for y in YEARS:
        path = os.path.join(cache_dir, f"draft_{y}.json") if cache_dir else None
        if path and os.path.exists(path):
            raw = json.load(open(path))
        else:
            print(f"  draft {y} …", file=sys.stderr)
            raw = json.loads(get(f"https://statsapi.mlb.com/api/v1/draft/{y}"))
            if path: json.dump(raw, open(path, "w"))
        for rd in raw.get("drafts", {}).get("rounds", []):
            for p in rd.get("picks", []):
                ov = p.get("pickNumber")
                person = p.get("person") or {}
                if not ov or int(ov) > MAX_OVERALL or not person.get("fullName"): continue
                if p.get("isPass") or not p.get("isDrafted", True): continue
                team = ID_TO_ABBR.get((p.get("team") or {}).get("id"))
                if not team: continue
                by = None
                bd = person.get("birthDate")
                if bd:
                    try: by = int(bd[:4])
                    except ValueError: pass
                bon = p.get("signingBonus")
                try: bon = int(float(bon)) if bon not in (None, "") else None
                except (ValueError, TypeError): bon = None
                picks.append({
                    "y": y, "ov": int(ov), "team": team,
                    "name": person["fullName"], "mlbid": str(person.get("id") or ""),
                    "g": pos_group((person.get("primaryPosition") or {}).get("abbreviation")),
                    "lvl": level_of((p.get("school") or {}).get("schoolClass"),
                                    (p.get("school") or {}).get("name"), by, y),
                    "bon": bon,
                })
    return picks

# ---- aWAR: dependency-free xlsx read (zip + XML), CSV fallback --------------------
def _xlsx_rows(path):
    z = zipfile.ZipFile(path)
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    ss = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(f"{ns}si"):
            ss.append("".join(t.text or "" for t in si.iter(f"{ns}t")))
    def cellval(c):
        v = c.find(f"{ns}v")
        if v is None: return None
        return ss[int(v.text)] if c.get("t") == "s" else v.text
    root = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
    for row in root.findall(f"{ns}sheetData/{ns}row"):
        yield [cellval(c) for c in row.findall(f"{ns}c")]

def load_awar(path):
    """Career aWAR per MLB.com Id (latest-Season 'Career thru Season aWAR'), plus a
    norm-name fallback map. Handles xlsx (default) and csv. Returns (by_id, by_name)."""
    if path.lower().endswith((".xlsx", ".xlsm")):
        rows = list(_xlsx_rows(path))
        hdr = [str(c).strip() if c is not None else "" for c in rows[0]]
        data = [dict(zip(hdr, r)) for r in rows[1:]]
    else:
        data = list(csv.DictReader(open(path, encoding="utf-8-sig")))
        hdr = data[0].keys() if data else []
    def col(d, *names):
        for n in names:
            for k in d:
                if k and k.strip().lower() == n: return d[k]
        return None
    # keep the latest season per id (career-thru-season is cumulative)
    latest = {}   # id -> (season, careerAwar, name)
    name_latest = {}
    for d in data:
        pid = col(d, "mlb.com id", "mlbid", "mlb_id", "id")
        career = col(d, "career thru season awar", "career awar", "awar", "a_war", "war")
        season = col(d, "season", "year")
        name = col(d, "player", "name", "player_name")
        try: career = float(career)
        except (ValueError, TypeError): continue
        try: se = int(float(season))
        except (ValueError, TypeError): se = 0
        pid = str(pid).strip() if pid not in (None, "") else None
        if pid and pid.replace(".0", "").isdigit():
            pid = pid.replace(".0", "")
            if pid not in latest or se >= latest[pid][0]:
                latest[pid] = (se, career, name)
        nk = norm_name(name)
        if nk and (nk not in name_latest or se >= name_latest[nk][0]):
            name_latest[nk] = (se, career)
    by_id = {pid: round(v[1], 1) for pid, v in latest.items()}
    by_name = {nk: round(v[1], 1) for nk, v in name_latest.items()}
    return by_id, by_name

def blank():
    return {"n": 0, "warSum": 0.0, "expSum": 0.0}

def add(cell, war_c, exp):
    cell["n"] += 1; cell["warSum"] += war_c; cell["expSum"] += exp

def finish(cell):
    woe = (cell["warSum"] - cell["expSum"]) / (cell["n"] + SHRINK_K)
    return {"n": cell["n"], "warSum": round(cell["warSum"], 1),
            "expSum": round(cell["expSum"], 1), "woe": round(woe, 3)}

def median(vals):
    vals = sorted(vals)
    n = len(vals)
    if n == 0: return None
    mid = n // 2
    return vals[mid] if n % 2 else (vals[mid - 1] + vals[mid]) / 2

def fetch_debuts(mlbids, cache_dir):
    """statsapi people lookup in chunks of 100 -> {mlbid: debutYear or None}.
    Cached to <cache_dir>/debuts.json when cache_dir given so re-runs skip the fetch."""
    cache_path = os.path.join(cache_dir, "debuts.json") if cache_dir else None
    if cache_path and os.path.exists(cache_path):
        return json.load(open(cache_path))
    out = {}
    ids = [i for i in mlbids if i.isdigit()]
    for i in range(0, len(ids), 100):
        chunk = ids[i:i+100]
        url = ("https://statsapi.mlb.com/api/v1/people?personIds=" + ",".join(chunk)
               + "&fields=people,id,mlbDebutDate")
        for attempt in range(3):
            try:
                with urllib.request.urlopen(url, timeout=30) as resp:
                    data = json.load(resp)
                for p in data.get("people", []):
                    debut = p.get("mlbDebutDate")
                    out[str(p["id"])] = int(debut[:4]) if debut else None
                break
            except Exception as e:
                if attempt == 2:
                    print(f"  !! statsapi debut chunk failed: {e}", file=sys.stderr)
                else:
                    time.sleep(1.5)
        print(f"  debuts {min(i+100, len(ids))}/{len(ids)}", file=sys.stderr)
    if cache_path:
        json.dump(out, open(cache_path, "w"))
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--awar", default=AWAR_DEFAULT if os.path.exists(AWAR_DEFAULT) else None,
                    help="A-WAR file (xlsx/csv); defaults to public/data/aWAR.xlsx")
    ap.add_argument("--cache-dir", help="cache raw feeds here (re-runs skip downloads)")
    args = ap.parse_args()
    if args.cache_dir: os.makedirs(args.cache_dir, exist_ok=True)

    war_id, war_name = load_war(args.cache_dir)
    print(f"bWAR table: {len(war_id)} players by mlb_ID", file=sys.stderr)
    picks = sweep_drafts(args.cache_dir)
    print(f"draft sweep: {len(picks)} picks {YEARS[0]}-{YEARS[-1]} (ov<= {MAX_OVERALL})", file=sys.stderr)

    aw_id, aw_name = ({}, {})
    if args.awar:
        aw_id, aw_name = load_awar(args.awar)
        print(f"aWAR: {len(aw_id)} players by id from {os.path.basename(args.awar)}", file=sys.stderr)

    id_hits = name_hits = aw_hits = 0
    for p in picks:
        w = war_id.get(p["mlbid"])
        if w is not None: id_hits += 1
        else:
            w = war_name.get(norm_name(p["name"]))
            if w is not None: name_hits += 1
        p["war"] = round(w, 1) if w is not None else 0.0
        p["warC"] = max(p["war"], 0.0)
        a = aw_id.get(p["mlbid"])
        if a is None: a = aw_name.get(norm_name(p["name"]))
        if a is not None: p["aw"] = a; aw_hits += 1
    print(f"bWAR join: {id_hits} id, {name_hits} name, {len(picks)-id_hits-name_hits} no-MLB; "
          f"aWAR attached to {aw_hits} picks", file=sys.stderr)

    debuts = fetch_debuts(sorted({p["mlbid"] for p in picks if p["mlbid"]}), args.cache_dir)
    for p in picks:
        p["debutYear"] = debuts.get(p["mlbid"])
    debuted_n = sum(1 for p in picks if p["debutYear"])
    print(f"debuts: {debuted_n}/{len(picks)} picks have an MLB debut year", file=sys.stderr)

    # expected-bWAR curve over the full swept era (2018+, realized-to-date)
    curve = {k: [0, 0.0] for k in BAND_KEYS}
    for p in picks:
        b = band_of(p["ov"])
        if b: curve[b][0] += 1; curve[b][1] += p["warC"]
    exp_mean = {k: (round(s / n, 2) if n else 0.0) for k, (n, s) in curve.items()}
    exp_of = lambda ov: exp_mean.get(band_of(ov), 0.0)

    orgs = {}
    for p in picks:
        o = orgs.setdefault(p["team"], {"all": blank(), "byG": {}, "byB": {}, "byLvl": {},
                                        "aw": {"n": 0, "sum": 0.0}, "picks": [],
                                        "debutYears": {"all": [], "HS": [], "College": []}})
        row = {"y": p["y"], "ov": p["ov"], "n": p["name"], "g": p["g"], "w": p["war"]}
        if p["lvl"]: row["lvl"] = p["lvl"]
        if p["bon"]: row["bon"] = p["bon"]
        if "aw" in p: row["aw"] = p["aw"]
        o["picks"].append(row)
        # recent-class aWAR/pick (2018-24) — the SV-native production read
        if p["y"] >= RECENT_FROM and "aw" in p:
            o["aw"]["n"] += 1; o["aw"]["sum"] += max(p["aw"], 0.0)
        e = exp_of(p["ov"])
        add(o["all"], p["warC"], e)
        if p["g"] != "?": add(o["byG"].setdefault(p["g"], blank()), p["warC"], e)
        b = band_of(p["ov"])
        if b: add(o["byB"].setdefault(b, blank()), p["warC"], e)
        if p["lvl"]: add(o["byLvl"].setdefault(p["lvl"], blank()), p["warC"], e)
        if p["debutYear"]:
            yrs = p["debutYear"] - p["y"]
            o["debutYears"]["all"].append(yrs)
            if p["lvl"] in ("HS", "College"):
                o["debutYears"][p["lvl"]].append(yrs)

    out_orgs = {}
    for t, o in orgs.items():
        o["picks"].sort(key=lambda r: (-r["y"], r["ov"]))
        rec = {
            "all": finish(o["all"]),
            "byG": {k: finish(v) for k, v in o["byG"].items()},
            "byB": {k: finish(v) for k, v in o["byB"].items()},
            "byLvl": {k: finish(v) for k, v in o["byLvl"].items()},
            "picks": o["picks"],
        }
        if o["aw"]["n"]:
            rec["awRecent"] = {"n": o["aw"]["n"], "sum": round(o["aw"]["sum"], 1),
                               "perPick": round(o["aw"]["sum"] / o["aw"]["n"], 2)}
        debut_speed = {k: {"medianYears": median(yrs), "n": len(yrs)}
                       for k, yrs in o["debutYears"].items() if yrs}
        if debut_speed:
            rec["debutSpeed"] = debut_speed
        out_orgs[t] = rec

    # league-wide debut-speed medians (all swept 2018+ picks that debuted) — baked
    # into meta so the front end reads these instead of hardcoding.
    lg_hs = [p["debutYear"] - p["y"] for p in picks if p["debutYear"] and p["lvl"] == "HS"]
    lg_college = [p["debutYear"] - p["y"] for p in picks if p["debutYear"] and p["lvl"] == "College"]
    lg_all = [p["debutYear"] - p["y"] for p in picks if p["debutYear"]]
    lg_debut_speed = {"HS": median(lg_hs), "College": median(lg_college), "all": median(lg_all)}

    payload = {
        "meta": {
            "years": [YEARS[0], YEARS[-1]], "eraFrom": ERA_FROM,
            "recentFrom": RECENT_FROM, "maxOverall": MAX_OVERALL, "k": SHRINK_K, "clamped": True,
            "awar": bool(args.awar),
            "builtAt": datetime.datetime.now().isoformat(timespec="seconds"),
            "posNote": "pos group = current primaryPosition (drafted position not in feed)",
            "eraNote": "era = slot-history/aWAR coverage range (draft classes 2018+; "
                       "first 2018-class MLB debut was Sept '19) — expMean/WOE/debutSpeed "
                       "are realized-to-date over this full era, no maturity gate",
            "debutSpeedNote": "median years from draft to MLB debut, HS vs College picks, "
                               "over all swept (2018+) picks; non-debuted picks excluded",
            "lgDebutSpeed": lg_debut_speed,
        },
        "expBands": BAND_KEYS,
        "expMean": exp_mean,
        "orgs": out_orgs,
    }
    json.dump(payload, open(OUT, "w"), separators=(",", ":"))
    kb = os.path.getsize(OUT) // 1024
    print(f"wrote {OUT} ({kb} KB)")
    print("expected career bWAR by band:", json.dumps(exp_mean))
    kc = out_orgs.get("KC", {})
    print("sample KC all:", json.dumps(kc.get("all")), "| awRecent:", json.dumps(kc.get("awRecent")))
    print(f"league debut speed — HS median {lg_debut_speed['HS']}y (n={len(lg_hs)}), "
          f"College median {lg_debut_speed['College']}y (n={len(lg_college)}), "
          f"all median {lg_debut_speed['all']}y (n={len(lg_all)})")

if __name__ == "__main__":
    main()
