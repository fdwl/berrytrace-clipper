#!/bin/bash
# Sync script: Pull latest from upstream (main) and rebuild with custom branding
# Usage: ./scripts/sync-upstream.sh

set -e

CURRENT_BRANCH=$(git branch --show-current)
UPSTREAM_REMOTE="origin"
UPSTREAM_BRANCH="main"

echo "=========================================="
echo "Berrytrace Clipper - Sync Upstream Script"
echo "=========================================="
echo ""

if [ "$CURRENT_BRANCH" != "berrytrace" ]; then
    echo "WARNING: You are not on the 'berrytrace' branch."
    echo "Current branch: $CURRENT_BRANCH"
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

echo "[1/4] Fetching latest from upstream..."
git fetch $UPSTREAM_REMOTE

echo ""
echo "[2/4] Checking if main branch has diverged..."
LOCAL=$(git rev-parse @)
REMOTE=$(git rev-parse $UPSTREAM_REMOTE/$UPSTREAM_BRANCH)
BASE=$(git merge-base @ $UPSTREAM_REMOTE/$UPSTREAM_BRANCH)

if [ $LOCAL = $REMOTE ]; then
    echo "No changes on upstream. Nothing to sync."
    exit 0
elif [ $LOCAL = $BASE ]; then
    echo "Fast-forward merge available."
elif [ $REMOTE = $BASE ]; then
    echo "WARNING: Your branch has diverged from upstream."
    read -p "This is an unusual state. Continue? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
else
    echo "WARNING: Branches have diverged. Manual merge may be required."
    read -p "Continue? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

echo ""
echo "[3/4] Checking for conflicts in tracked files..."
if ! git diff --quiet $UPSTREAM_REMOTE/$UPSTREAM_BRANCH -- src/ webpack.config.js package.json; then
    echo "WARNING: Upstream has changes to source files."
    echo "Your custom files may conflict."
    echo ""
    echo "Affected files:"
    git diff --name-only $UPSTREAM_REMOTE/$UPSTREAM_BRANCH -- src/ webpack.config.js package.json
    echo ""
    read -p "Merge these changes? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Sync aborted. Please resolve manually."
        exit 1
    fi
    git merge $UPSTREAM_REMOTE/$UPSTREAM_BRANCH
else
    echo "No conflicts in tracked files."
fi

echo ""
echo "[4/4] Building with custom branding..."
npm run build

echo ""
echo "=========================================="
echo "Sync complete!"
echo "=========================================="
echo ""
echo "To load the extension in Chrome:"
echo "1. Go to chrome://extensions/"
echo "2. Enable 'Developer mode'"
echo "3. Click 'Load unpacked'"
echo "4. Select the 'dist' folder"
echo ""
