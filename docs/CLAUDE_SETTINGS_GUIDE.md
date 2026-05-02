# Claude Code Proxy - Settings Management Guide

This guide explains how to manage your Claude Code settings to use the proxy.

## Quick Start

Run the setup command to configure Claude Code to use the proxy:

```bash
npm run setup:claude
```

This will:
1. Back up your current `~/.claude/settings.json` with a timestamp
2. Add the proxy configuration to your settings
3. Enable the proxy for all Claude Code requests

**After running this command, restart Claude Code for changes to take effect.**

## Available Commands

### `npm run setup:claude`

Configure Claude Code to use the proxy.

- **What it does**: Backs up your current settings and adds `ANTHROPIC_API_URL` environment variable pointing to `http://localhost:4181`
- **When to use**: First-time setup or if you want to reconfigure the proxy
- **Safety**: Creates a timestamped backup in `~/.claude/backups/` before making changes

### `npm run settings:backup`

Create a manual backup of your current Claude Code settings.

- **What it does**: Creates a timestamped backup of `~/.claude/settings.json`
- **When to use**: Before making manual changes to your settings
- **Location**: Backups are stored in `~/.claude/backups/`

### `npm run settings:restore`

Restore your settings from the most recent backup.

- **What it does**: Restores settings from the latest backup file
- **When to use**: If you want to revert to your pre-proxy configuration
- **After running**: Restart Claude Code for changes to take effect

### `npm run providers:reset`

Reset all provider health states to healthy.

- **What it does**: Resets the circuit breaker, making all providers available immediately
- **When to use**: If both providers are in cooldown and you want to force them available
- **Note**: This is a shortcut for `curl -s -X POST http://localhost:4181/providers/reset`

### `npm run providers:status`

Check the current status of all providers.

- **What it does**: Shows health state and cooldown status for each provider
- **When to use**: Monitor which providers are available and their current state
- **Note**: This is a shortcut for `curl -s http://localhost:4181/providers`

## How It Works

The proxy works by intercepting API requests from Claude Code and intelligently routing them to different providers:

1. **Primary Provider**: Anthropic API (if available and under quota)
2. **Fallback Provider**: Z.AI (if Anthropic is unavailable or over quota)
3. **Last Resort**: Claude subscription mode (if both APIs are unavailable)

The circuit breaker automatically:
- Detects context window errors and rate limits
- Switches providers when issues are detected
- Places providers in cooldown to prevent cascading failures
- Recovers providers automatically after cooldown period

## Manual Configuration

If you prefer to configure Claude Code manually, edit `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_API_URL": "http://localhost:4181"
  }
}
```

Then restart Claude Code.

## Troubleshooting

### Claude Code isn't using the proxy

1. Check that `~/.claude/settings.json` contains the proxy URL
2. Restart Claude Code completely (not just the terminal)
3. Verify the proxy is running: `curl http://localhost:4181/health`

### Both providers show as unavailable

1. Check provider status: `npm run providers:status`
2. If both are in cooldown, reset them: `npm run providers:reset`
3. Monitor the health endpoint to see automatic recovery

### Want to stop using the proxy

1. Restore your original settings: `npm run settings:restore`
2. Or manually edit `~/.claude/settings.json` to remove `ANTHROPIC_API_URL`
3. Restart Claude Code

## Backup Management

Backups are stored in `~/.claude/backups/` with the format:
- `settings.json.backup.YYYY-MM-DD_HHMMSS`

The restore command automatically finds and uses the most recent backup. To manage backups manually:

```bash
# List all backups (Windows)
dir %USERPROFILE%\.claude\backups

# List all backups (Unix/Mac)
ls -la ~/.claude/backups

# Restore a specific backup (manual)
cp ~/.claude/backups/settings.json.backup.YYYY-MM-DD_HHMMSS ~/.claude/settings.json
```

## Security Notes

- The proxy runs on `localhost:4181` and is not exposed to the network
- Your API keys are stored in the proxy's `.env` file, not in Claude Code settings
- The proxy does not store or log any request content beyond usage metrics
- Backup files may contain sensitive configuration - keep them secure
