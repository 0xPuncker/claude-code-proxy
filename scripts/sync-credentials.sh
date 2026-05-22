#!/usr/bin/env bash
# Reads the Claude Code OAuth token from macOS Keychain and writes it to
# ~/.claude/claude-credentials.json so Docker can mount it as a file.
#
# Run once manually after login, or wire into a LaunchAgent for auto-refresh.
# Usage: bash scripts/sync-credentials.sh [--watch]

set -euo pipefail

DEST="${CLAUDE_CREDENTIALS_FILE:-$HOME/.claude/claude-credentials.json}"
KEYCHAIN_SERVICE="Claude Code-credentials"

extract_and_write() {
  local raw
  raw=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null) || {
    echo "ERROR: Could not read '$KEYCHAIN_SERVICE' from Keychain." >&2
    echo "Make sure you are logged into Claude Code CLI." >&2
    exit 1
  }

  # Validate it has the expected shape before writing
  echo "$raw" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert 'claudeAiOauth' in d, 'missing claudeAiOauth key'
assert d['claudeAiOauth'].get('accessToken'), 'accessToken is empty'
" 2>/dev/null || {
    echo "ERROR: Keychain entry does not contain a valid claudeAiOauth token." >&2
    exit 1
  }

  echo "$raw" > "$DEST"
  chmod 600 "$DEST"

  local expires_at
  expires_at=$(echo "$raw" | python3 -c "
import sys, json, datetime
d = json.load(sys.stdin)
ms = d['claudeAiOauth'].get('expiresAt', 0)
if ms:
    dt = datetime.datetime.fromtimestamp(ms / 1000).strftime('%Y-%m-%d %H:%M:%S')
    print(dt)
else:
    print('unknown')
" 2>/dev/null)

  echo "Credentials synced → $DEST (expires: $expires_at)"
}

if [[ "${1:-}" == "--watch" ]]; then
  echo "Watching for token refresh every 5 minutes..."
  while true; do
    extract_and_write
    sleep 300
  done
else
  extract_and_write
fi
