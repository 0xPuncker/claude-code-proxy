# Auto-Sync Claude Credentials

The proxy needs fresh Claude OAuth credentials to use your subscription (savings plan) instead of API keys. This setup automatically syncs credentials from the macOS Keychain to a file that the proxy container reads.

## How It Works

1. **macOS Keychain** stores your Claude OAuth token (service: `Claude Code-credentials`)
2. **sync-credentials.sh** extracts the token and writes to `~/.claude/claude-credentials.json`
3. **LaunchAgent** runs the sync script every 5 minutes automatically
4. **Docker mount** shares the credentials file with the `cc-proxy` container (read-write)

## One-Time Setup

Run the setup script to install the LaunchAgent:

```bash
bash scripts/setup-credential-sync.sh
```

This will:
- Copy the LaunchAgent plist to `~/Library/LaunchAgents/`
- Start the background job that syncs every 5 minutes
- Log output to `/tmp/claude-sync-credentials.log`

## Manual Sync

To manually refresh credentials (e.g., after CLI login):

```bash
bash scripts/sync-credentials.sh
```

## Monitoring

Check sync status:

```bash
# View recent sync logs
tail -f /tmp/claude-sync-credentials.log

# Check if LaunchAgent is running
launchctl list | grep com.claude

# View token expiry
cat ~/.claude/claude-credentials.json | python3 -c "
import sys, json, datetime
d = json.load(sys.stdin)
ms = d['claudeAiOauth'].get('expiresAt', 0)
if ms:
    dt = datetime.datetime.fromtimestamp(ms / 1000).strftime('%Y-%m-%d %H:%M:%S')
    print(f'Token expires: {dt}')
"
```

## Troubleshooting

### LaunchAgent not running

```bash
# Unload and reload
launchctl unload ~/Library/LaunchAgents/com.claude.sync-credentials.plist
launchctl load ~/Library/LaunchAgents/com.claude.sync-credentials.plist
```

### Token still expired after sync

The CLI auto-refreshes tokens when used directly. Run a CLI command to trigger refresh:

```bash
claude --version
bash scripts/sync-credentials.sh
podman restart cc-proxy
```

### Proxy can't read credentials

Check the mount is read-write:

```bash
podman inspect cc-proxy --format '{{range .Mounts}}{{if eq .Destination "/app/credentials.json"}}{{.Mode}}{{end}}{{end}}'
```

Should return `rw`. If `ro`, update `docker-compose.yml`:

```yaml
volumes:
  - ~/.claude/claude-credentials.json:/app/credentials.json:rw
```

## Docker Integration

The proxy container mounts the credentials file:

```yaml
cc-proxy:
  volumes:
    - ~/.claude/claude-credentials.json:/app/credentials.json:rw
```

Changes to the file on the host are immediately visible to the container (no restart needed for token updates, only for initial mount changes).
