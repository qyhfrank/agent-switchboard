#!/usr/bin/env bash
#
# Usage: scripts/release.sh [patch|minor|major|<version>]
# Default: patch
#
# Validates the project, bumps version, commits, tags, and pushes.
# Designed to guarantee CI will pass before the tag reaches GitHub.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# ── Helpers ──────────────────────────────────────────────────

red()   { printf '\033[1;31m%s\033[0m\n' "$*"; }
green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
cyan()  { printf '\033[1;36m%s\033[0m\n' "$*"; }
step()  { cyan "▸ $*"; }

die() { red "✖ $*" >&2; exit 1; }

# ── Pre-flight checks ───────────────────────────────────────

[[ -f package.json ]] || die "package.json not found"

if ! git diff --quiet || ! git diff --cached --quiet; then
  die "Working tree is dirty. Commit or stash your changes first."
fi

if [[ "$(git symbolic-ref --short HEAD)" != "main" ]]; then
  die "Not on main branch. Switch to main before releasing."
fi

git fetch origin main --quiet
local_sha=$(git rev-parse HEAD)
remote_sha=$(git rev-parse origin/main)
if [[ "$local_sha" != "$remote_sha" ]]; then
  die "Local main is not in sync with origin/main. Pull or push first."
fi

# ── Determine new version ───────────────────────────────────

current=$(node -p "require('./package.json').version")
bump="${1:-patch}"

case "$bump" in
  patch)
    IFS='.' read -r maj min pat <<< "$current"
    new_version="$maj.$min.$((pat + 1))"
    ;;
  minor)
    IFS='.' read -r maj min pat <<< "$current"
    new_version="$maj.$((min + 1)).0"
    ;;
  major)
    IFS='.' read -r maj min pat <<< "$current"
    new_version="$((maj + 1)).0.0"
    ;;
  *)
    new_version="$bump"
    ;;
esac

step "Releasing v$new_version (was $current)"

# ── Full validation suite ────────────────────────────────────

step "Lint"
pnpm run lint

step "Typecheck"
pnpm run typecheck

step "Test"
pnpm run test

step "Build"
pnpm run build

green "✔ All checks passed"

# ── Bump, commit, tag, push ──────────────────────────────────

step "Bumping version in package.json"
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.version = '$new_version';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

step "Committing and tagging"
ASB_SKIP_HOOKS=1 git add package.json
ASB_SKIP_HOOKS=1 git commit -m "$new_version"
git tag "v$new_version"

step "Pushing to origin"
git push origin main --follow-tags

green "✔ v$new_version released successfully"
echo "  npm: https://www.npmjs.com/package/agent-switchboard"
echo "  ci:  https://github.com/qyhfrank/agent-switchboard/actions"
