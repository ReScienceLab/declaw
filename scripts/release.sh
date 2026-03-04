#!/usr/bin/env bash
set -euo pipefail

# DeClaw — automated release script
# Usage:
#   bash scripts/release.sh patch    # 0.2.2 → 0.2.3
#   bash scripts/release.sh minor    # 0.2.2 → 0.3.0
#   bash scripts/release.sh major    # 0.2.2 → 1.0.0

LEVEL="${1:-patch}"

if [[ "$LEVEL" != "patch" && "$LEVEL" != "minor" && "$LEVEL" != "major" ]]; then
  echo "Usage: bash scripts/release.sh [patch|minor|major]"
  exit 1
fi

echo "=== DeClaw Release (${LEVEL}) ==="

# ── 0. Preflight checks ──────────────────────────────────────────────────────

# Must be on main
BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: must be on 'main' branch (currently on '${BRANCH}')"
  exit 1
fi

# Working tree must be clean
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  exit 1
fi

# Remote must be up to date
git fetch origin main --quiet
LOCAL=$(git rev-parse main)
REMOTE=$(git rev-parse origin/main)
if [[ "$LOCAL" != "$REMOTE" ]]; then
  echo "Error: local main ($LOCAL) differs from origin/main ($REMOTE). Pull or push first."
  exit 1
fi

# ── 1. Build + test ──────────────────────────────────────────────────────────

echo "Building..."
npm run build

echo "Running tests..."
node --test test/*.test.mjs

# ── 2. Version bump ──────────────────────────────────────────────────────────

# Bump package.json + package-lock.json (no git tag yet)
VERSION=$(npm version "$LEVEL" --no-git-tag-version | tr -d 'v')
echo "New version: ${VERSION}"

# Sync version to all version-bearing files:
#   - openclaw.plugin.json  (plugin manifest)
#   - skills/declaw/SKILL.md (ClawHub skill frontmatter)
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" openclaw.plugin.json
sed -i '' "s/^version: .*/version: ${VERSION}/" skills/declaw/SKILL.md

echo "Version synced to: package.json, openclaw.plugin.json, skills/declaw/SKILL.md"

# ── 3. Verify CHANGELOG ──────────────────────────────────────────────────────

if ! grep -q "\[${VERSION}\]" CHANGELOG.md; then
  echo ""
  echo "Warning: CHANGELOG.md does not contain a [${VERSION}] section."
  echo "Please update CHANGELOG.md before releasing."
  echo ""
  read -p "Continue without changelog entry? (y/N) " -n 1 -r
  echo
  if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
    echo "Aborting. Update CHANGELOG.md and re-run."
    # Revert version bumps
    git checkout -- package.json package-lock.json openclaw.plugin.json skills/declaw/SKILL.md
    exit 1
  fi
fi

# ── 4. Commit + tag ──────────────────────────────────────────────────────────

git add -A
git commit -m "chore: release v${VERSION}"
git tag "v${VERSION}"

echo "Committed and tagged v${VERSION}"

# ── 5. Push main + tag ───────────────────────────────────────────────────────

git push origin main --tags
echo "Pushed main + v${VERSION} tag"

# ── 6. GitHub Release (triggers npm publish via CI) ──────────────────────────

gh release create "v${VERSION}" --generate-notes --title "v${VERSION}"
echo "GitHub release created → npm publish will trigger via CI"

# ── 7. Backmerge to develop ──────────────────────────────────────────────────

git checkout develop
git merge main --no-edit
git push origin develop
git checkout main

echo "Backmerged main → develop"

# ── 8. Publish to ClawHub ────────────────────────────────────────────────────

echo "Publishing skill to ClawHub..."
if command -v npx &>/dev/null; then
  npx clawhub@latest publish skills/declaw
  echo "ClawHub publish complete → https://clawhub.ai/Jing-yilin/declaw"
else
  echo "Warning: npx not found — publish manually: npx clawhub@latest publish skills/declaw"
fi

# ── 9. Done ──────────────────────────────────────────────────────────────────

echo ""
echo "=== Released v${VERSION} ==="
echo ""
echo "Post-release checklist:"
echo "  1. Verify npm: https://www.npmjs.com/package/@resciencelab/declaw"
echo "  2. Verify ClawHub: https://clawhub.ai/Jing-yilin/declaw"
echo "  3. Deploy bootstrap (if server.mjs changed):"
echo "     bash -c 'B64=\$(base64 -i bootstrap/server.mjs); for pair in \"i-04670f4d1a72c7d5d:us-east-2\" \"i-096ba79b9ae854339:us-west-2\" \"i-084242224f1a49b13:eu-west-1\" \"i-0b909aacd92097e43:ap-northeast-1\" \"i-0141cd0f56a902978:ap-southeast-1\"; do IID=\${pair%%:*}; REGION=\${pair##*:}; aws ssm send-command --instance-ids \$IID --region \$REGION --document-name AWS-RunShellScript --parameters \"{\\\"commands\\\":[\\\"echo '\\'\\''\${B64}'\\'\\'\" | base64 -d > /opt/declaw-bootstrap/server.mjs\\\",\\\"systemctl restart declaw-bootstrap\\\"]}\" --query Command.CommandId --output text; done'"
