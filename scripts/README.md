# Claude Code Proxy Scripts

This directory contains utility scripts for managing your Claude Code proxy setup.

## Available Scripts

### Settings Management Scripts

#### `update-claude-settings.js` (Recommended)
Cross-platform Node.js script to backup and update Claude Code settings for cc-proxy usage.

```bash
# Using npm
npm run settings:update

# Using node directly
node scripts/update-claude-settings.js
```

**Features:**
- ✅ Creates timestamped backup before making changes
- ✅ Validates JSON structure before and after updates
- ✅ Removes unnecessary auth tokens (handled by proxy)
- ✅ Sets correct proxy URL (http://localhost:4181)
- ✅ Works on Windows, macOS, and Linux

#### `update-claude-settings.sh` (Alternative)
Bash script with the same functionality for Unix-like systems.

```bash
# Using npm
npm run settings:update:bash

# Using bash directly
bash scripts/update-claude-settings.sh
```

### Backup and Restore Scripts

```bash
# Create a quick backup
npm run settings:backup

# Restore from latest backup
npm run settings:restore
```

## What These Scripts Do

1. **Backup**: Creates `~/.claude/backups/settings.json.backup.TIMESTAMP`
2. **Update**: Modifies `~/.claude/settings.json`:
   - Sets `ANTHROPIC_BASE_URL` to `http://localhost:4181`
   - Removes `ANTHROPIC_AUTH_TOKEN` (handled by cc-proxy)
3. **Validate**: Ensures JSON syntax is correct
4. **Report**: Shows exactly what was changed

## Manual Configuration

If you prefer to configure manually, update `~/.claude/settings.json`:

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4181"
    // Remove ANTHROPIC_AUTH_TOKEN if present
  }
}
```

## Verification

Test your proxy configuration:

```bash
# Check proxy health
curl -s http://localhost:4181/health | jq .

# View usage statistics
curl -s http://localhost:4181/usage | jq .

# Check recent API calls
curl -s http://localhost:4181/api/logs | jq .
```

## Troubleshooting

**Proxy not responding:**
```bash
# Check if proxy is running
docker ps | grep cc-proxy

# Start proxy if needed
docker-compose up -d

# Check proxy logs
docker logs cc-proxy --tail 50
```

**Settings not applied:**
```bash
# Verify settings file
cat ~/.claude/settings.json | jq .env.ANTHROPIC_BASE_URL

# Restore from backup
cp ~/.claude/backups/settings.json.backup.<TIMESTAMP> ~/.claude/settings.json
```

**Database connection issues:**
```bash
# Check database is running
docker ps | grep cc-db

# Verify database connection
docker exec cc-proxy printenv | grep DB_HOST
```

## Additional NPM Scripts

The project includes other useful scripts:

```bash
# Build and start proxy
npm run build
npm start

# Development mode with hot reload
npm run dev

# Run tests
npm test

# Database migrations
npm run db:migrate
npm run db:seed
```

## Safety Features

- **Automatic Backups**: Every run creates a timestamped backup
- **JSON Validation**: Checks file validity before and after changes
- **Error Handling**: Provides clear error messages and rollback instructions
- **Idempotent**: Safe to run multiple times

## Support

For issues or questions:
1. Check proxy logs: `docker logs cc-proxy`
2. Verify settings: `cat ~/.claude/settings.json | jq .`
3. Test proxy: `curl http://localhost:4181/health`
4. Check database: `docker logs cc-db`