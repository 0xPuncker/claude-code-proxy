#!/usr/bin/env bash
# Install a LaunchAgent that auto-syncs the Claude OAuth token from the macOS
# Keychain to ~/.claude/claude-credentials.json every 5 minutes, so the proxy
# container (which can't read the Keychain) always has a fresh token.
#
# The sync script and the LaunchAgent are installed to STABLE, workspace-
# independent locations under $HOME — never inside a Conductor workspace.
# Pointing the agent at a workspace path is what broke this before: the
# workspace was deleted, the script vanished, and the token went stale.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_SCRIPT="$SCRIPT_DIR/sync-credentials.sh"

# Stable install locations (independent of any workspace)
INSTALL_DIR="$HOME/.claude"
INSTALLED_SCRIPT="$INSTALL_DIR/sync-credentials.sh"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LABEL="com.claude.sync-credentials"
TARGET_PLIST="$LAUNCH_AGENTS_DIR/$LABEL.plist"

echo "📦 Installing Claude credential sync LaunchAgent..."

mkdir -p "$INSTALL_DIR" "$LAUNCH_AGENTS_DIR"

# Install the sync script to the stable location so it survives workspace
# deletion. The script itself has no workspace dependencies.
install -m 0755 "$SOURCE_SCRIPT" "$INSTALLED_SCRIPT"

# Generate the plist pointing at the stable script path.
cat > "$TARGET_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$INSTALLED_SCRIPT</string>
    </array>
    <key>StartInterval</key>
    <integer>300</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/claude-sync-credentials.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/claude-sync-credentials.err</string>
</dict>
</plist>
PLIST

# (Re)load the LaunchAgent. Prefer the modern bootstrap API, fall back to
# load/unload on older macOS.
GUI_DOMAIN="gui/$(id -u)"
if /bin/launchctl bootout "$GUI_DOMAIN/$LABEL" 2>/dev/null; then :; fi
if ! /bin/launchctl bootstrap "$GUI_DOMAIN" "$TARGET_PLIST" 2>/dev/null; then
  /bin/launchctl unload "$TARGET_PLIST" 2>/dev/null || true
  /bin/launchctl load "$TARGET_PLIST"
fi

# Run it once immediately and confirm it succeeded.
/bin/launchctl kickstart -k "$GUI_DOMAIN/$LABEL" 2>/dev/null || true
sleep 2

echo "✅ LaunchAgent installed and started!"
echo ""
echo "Details:"
echo "  - Script:        $INSTALLED_SCRIPT"
echo "  - Plist:         $TARGET_PLIST"
echo "  - Sync interval: Every 5 minutes (+ at login)"
echo "  - Log file:      /tmp/claude-sync-credentials.log"
echo "  - Error log:     /tmp/claude-sync-credentials.err"
echo ""
echo "Commands:"
echo "  - Status:  launchctl list | grep $LABEL    (Status 0 = last run OK)"
echo "  - Run now: launchctl kickstart -k $GUI_DOMAIN/$LABEL"
echo "  - Stop:    launchctl bootout $GUI_DOMAIN/$LABEL"
echo "  - Logs:    tail -f /tmp/claude-sync-credentials.log"
echo ""
echo "The proxy container reads the credentials file on every request, so it"
echo "picks up refreshed tokens automatically — no container restart needed."
