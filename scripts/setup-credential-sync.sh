#!/usr/bin/env bash
# Install LaunchAgent to auto-sync Claude credentials every 5 minutes

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST_FILE="$PROJECT_ROOT/com.claude.sync-credentials.plist"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
TARGET_PLIST="$LAUNCH_AGENTS_DIR/com.claude.sync-credentials.plist"

echo "📦 Installing Claude credential sync LaunchAgent..."

# Ensure LaunchAgents directory exists
mkdir -p "$LAUNCH_AGENTS_DIR"

# Copy plist to LaunchAgents directory
cp "$PLIST_FILE" "$TARGET_PLIST"

# Update the script path in the plist to use the absolute path
/usr/bin/sed -i '' "s|/Users/raulneiva/conductor/workspaces/claude-code-proxy/worcester/scripts/sync-credentials.sh|$SCRIPT_DIR/sync-credentials.sh|g" "$TARGET_PLIST"

# Load the LaunchAgent
/bin/launchctl unload "$TARGET_PLIST" 2>/dev/null || true
/bin/launchctl load "$TARGET_PLIST"

echo "✅ LaunchAgent installed and started!"
echo ""
echo "Details:"
echo "  - Sync interval: Every 5 minutes"
echo "  - Log file: /tmp/claude-sync-credentials.log"
echo "  - Error log: /tmp/claude-sync-credentials.err"
echo ""
echo "Commands:"
echo "  - Start:   launchctl load $TARGET_PLIST"
echo "  - Stop:    launchctl unload $TARGET_PLIST"
echo "  - Status:  launchctl list | grep com.claude"
echo "  - Logs:    tail -f /tmp/claude-sync-credentials.log"
echo ""
echo "The proxy container will automatically pick up credential changes."
