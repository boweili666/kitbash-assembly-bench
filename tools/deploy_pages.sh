#!/usr/bin/env bash
# Publish the simulator as a public static site on GitHub Pages (branch gh-pages).
#
#   tools/deploy_pages.sh
#
# Rebuilds the bundles, builds the site (tools/build_site.py) and adds one
# commit on top of origin/gh-pages - no history rewrite. The first run creates
# the branch. Pages must be set to "Deploy from branch: gh-pages / (root)"
# (once, in the repo settings or: gh api repos/OWNER/REPO/pages -X POST
# -f 'source[branch]=gh-pages' -f 'source[path]=/').
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
remote="$(git remote get-url origin)"
rev="$(git rev-parse --short HEAD)"
branch="$(git branch --show-current)"

python3 build.py
python3 tools/build_drone_intro.py

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git -C "$tmp" init -q
if git ls-remote --exit-code --heads "$remote" gh-pages >/dev/null 2>&1; then
  git -C "$tmp" fetch -q --depth 1 "$remote" gh-pages
  git -C "$tmp" checkout -q -b gh-pages FETCH_HEAD
  git -C "$tmp" rm -rq --ignore-unmatch .
else
  git -C "$tmp" checkout -q --orphan gh-pages
fi
python3 tools/build_site.py "$tmp"
git -C "$tmp" add -A
if git -C "$tmp" diff --cached --quiet; then
  echo "Site unchanged - nothing to deploy."
  exit 0
fi
git -C "$tmp" -c user.name="$(git config user.name)" -c user.email="$(git config user.email)" \
  commit -q -m "Deploy $rev ($branch)"
git -C "$tmp" push -q "$remote" gh-pages
echo "Deployed $rev -> gh-pages"
