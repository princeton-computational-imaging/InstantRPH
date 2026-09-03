#!/usr/bin/env bash
# Sync the site to a server, skipping the files nothing on the page requests
# (see tools/deploy-exclude.txt for what and why). Without this, every deploy
# uploads ~150 MB of dead assets alongside what the page actually needs.
#
# Usage: tools/deploy.sh user@host:/path/to/webroot/ [extra rsync args...]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:?Usage: $0 user@host:/path/to/webroot/ [extra rsync args...]}"
shift || true

rsync -avz --delete \
    --exclude-from="$ROOT/tools/deploy-exclude.txt" \
    --exclude '.git' --exclude '.gitignore' \
    --exclude 'tools' \
    "$@" \
    "$ROOT"/ "$DEST"
