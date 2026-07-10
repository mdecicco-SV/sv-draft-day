#!/usr/bin/env node
// Bake the SV player registry (be-sv-repo/data/players/*.json — the hand-curated client
// dossiers) into public/data/svregistry.json for the draft-history card's SV badge.
// Canonical dossiers only: <slug>.json with no dot in the slug and no leading underscore
// (sidecars like <slug>.live_state.json are skipped, per that repo's SCHEMA.md). Coaches
// are excluded — the badge marks players. Match on identity.full_name + aliases, never
// the slug (display names prefer nicknames; slugs are frozen legacy keys).
// Usage: node scripts/build_svregistry.js   (override source with SV_REGISTRY_DIR)
const fs = require("fs"), path = require("path");
const { normName } = require("../lib/names.js");

const SRC = process.env.SV_REGISTRY_DIR
  || path.join(process.env.HOME || "", "be-sv-repo", "data", "players");
const OUT = path.join(__dirname, "..", "public", "data", "svregistry.json");

const files = fs.readdirSync(SRC).filter(f =>
  f.endsWith(".json") && !f.startsWith("_") && !f.slice(0, -5).includes("."));

const names = {};
let players = 0;
for (const f of files) {
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(SRC, f), "utf8")); } catch (e) { continue; }
  const id = d.identity || d;
  const role = d.role || (d.current_state || {}).role || id.role;
  if (String(role || "").toLowerCase() === "coach") continue;
  const full = id.full_name; if (!full) continue;
  players++;
  for (const n of [full, ...(id.aliases || [])]) {
    const k = normName(n);
    if (k) names[k] = full;
  }
}

fs.writeFileSync(OUT, JSON.stringify({ built: new Date().toISOString().slice(0, 10),
  players, names }, null, 1));
console.log(`svregistry.json: ${players} players, ${Object.keys(names).length} name keys`);
