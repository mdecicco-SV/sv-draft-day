#!/usr/bin/env bash
# Re-bake the hub's data from the latest sources (composite_latest.csv, org-review
# xlsx, MLB slot order, leverage) and deploy. Run after updating the composite.
set -e
cd "$(dirname "$0")/.."
echo "▸ rebuilding data…"
python3 scripts/build_data.py
if git diff --quiet public/data; then
  echo "✓ no data changes — nothing to deploy."
  exit 0
fi
git add public/data
git commit -m "Refresh data $(date +%F)"
git push
echo "✓ pushed — Vercel auto-deploys in ~30s."
