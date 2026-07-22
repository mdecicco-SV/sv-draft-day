# sv-draft-day

MLB Draft war-room hub (live pick board, clock, bonus pools, intel). Seasonal:
dormant off-season behind the `LIVE_POLLING` switch in `public/index.html`;
re-armed each draft. See README.md for architecture.

## SV Internal Hub registry
This app is registered at https://sv-internal-hub.vercel.app/apps/sv-draft-day.
Whenever a change in this session adds, removes, or alters any of the following, update `sv-app.json` at the repo root **in the same session** — don't leave it for later:
- scheduled jobs / crons
- data sources in or destinations out (Slack channels, sheets, DBs, emails)
- hosting, deployment, or access/auth
- monitoring or known issues
- ownership or who uses it

Also update the `runbook` steps if the local-dev or deploy process changed.
The hub reads `sv-app.json` hourly and merges it over `registry/sv-draft-day.json`
in Stadium-Ventures/sv-internal-hub — this repo is in the org, so editing the
root file is all that's needed.

Canonical repo: **Stadium-Ventures/sv-draft-day** (public, transferred into the
org). `mdecicco-SV/sv-draft-day` is only a GitHub redirect to it; local remotes
pointing at the old name still work.
