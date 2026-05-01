#!/bin/bash
# Claude Code Proxy Settings Update Script
# Backs up and updates ~/.claude/settings.json to use cc-proxy

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CC_PROXY_URL="http://localhost:4181"
BACKUP_DIR="$HOME/.claude/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/settings.json.backup.$TIMESTAMP"

echo -e "${BLUE}=== Claude Code Proxy Settings Update ===${NC}"
echo ""

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Check if settings file exists
if [ ! -f "$CLAUDE_SETTINGS" ]; then
    echo -e "${RED}❌ Error: Settings file not found at $CLAUDE_SETTINGS${NC}"
    exit 1
fi

# Create backup
echo -e "${YELLOW}📁 Creating backup...${NC}"
cp "$CLAUDE_SETTINGS" "$BACKUP_FILE"
echo -e "${GREEN}✅ Backup created: $BACKUP_FILE${NC}"
echo ""

# Validate backup
if [ ! -s "$BACKUP_FILE" ]; then
    echo -e "${RED}❌ Error: Backup file is empty${NC}"
    exit 1
fi

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo -e "${YELLOW}⚠️  jq not found. Installing jq...${NC}"
    if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" ]]; then
        echo -e "${YELLOW}Please install jq using: winget install jq${NC}"
        exit 1
    else
        echo -e "${YELLOW}Please install jq using: sudo apt-get install jq${NC}"
        exit 1
    fi
fi

# Validate backup JSON
echo -e "${YELLOW}🔍 Validating backup...${NC}"
if jq empty "$BACKUP_FILE" 2>/dev/null; then
    echo -e "${GREEN}✅ Backup JSON is valid${NC}"
else
    echo -e "${RED}❌ Backup JSON is invalid${NC}"
    exit 1
fi
echo ""

# Update settings
echo -e "${YELLOW}⚙️  Updating settings for cc-proxy...${NC}"
jq --arg url "$CC_PROXY_URL" '
  if .env.ANTHROPIC_AUTH_TOKEN then
    del(.env.ANTHROPIC_AUTH_TOKEN) |
    .env.ANTHROPIC_BASE_URL = $url
  else
    .env.ANTHROPIC_BASE_URL = $url
  end
' "$CLAUDE_SETTINGS" > "${CLAUDE_SETTINGS}.tmp"

# Validate new settings
if jq empty "${CLAUDE_SETTINGS}.tmp" 2>/dev/null; then
    mv "${CLAUDE_SETTINGS}.tmp" "$CLAUDE_SETTINGS"
    echo -e "${GREEN}✅ Settings updated successfully${NC}"
else
    echo -e "${RED}❌ Error: Generated invalid JSON${NC}"
    rm "${CLAUDE_SETTINGS}.tmp"
    exit 1
fi
echo ""

# Display changes
echo -e "${BLUE}📊 Configuration changes:${NC}"
echo -e "${GREEN}BEFORE:${NC}"
jq -r '.env | "  ANTHROPIC_BASE_URL: \(.ANTHROPIC_BASE_URL // "not set")"' "$BACKUP_FILE" 2>/dev/null || echo "  ANTHROPIC_BASE_URL: not set"
jq -r '.env | "  ANTHROPIC_AUTH_TOKEN: \(.ANTHROPIC_AUTH_TOKEN // "not set")"' "$BACKUP_FILE" 2>/dev/null || echo "  ANTHROPIC_AUTH_TOKEN: not set"

echo -e "${GREEN}AFTER:${NC}"
jq -r '.env | "  ANTHROPIC_BASE_URL: \(.ANTHROPIC_BASE_URL // "not set")"' "$CLAUDE_SETTINGS" 2>/dev/null || echo "  ANTHROPIC_BASE_URL: not set"
jq -r '.env | "  ANTHROPIC_AUTH_TOKEN: removed (handled by proxy)"' "$CLAUDE_SETTINGS" 2>/dev/null
echo ""

# Test proxy connection
echo -e "${YELLOW}🔗 Testing proxy connection...${NC}"
if curl -s -o /dev/null -w "%{http_code}" "$CC_PROXY_URL/health" | grep -q "200"; then
    echo -e "${GREEN}✅ Proxy is accessible at $CC_PROXY_URL${NC}"
else
    echo -e "${YELLOW}⚠️  Warning: Proxy may not be running at $CC_PROXY_URL${NC}"
    echo -e "${YELLOW}   Start the proxy with: docker-compose up -d${NC}"
fi
echo ""

# Summary
echo -e "${BLUE}🎉 Update completed successfully!${NC}"
echo ""
echo -e "${BLUE}Summary:${NC}"
echo -e "  • Backup: $BACKUP_FILE"
echo -e "  • Settings: $CLAUDE_SETTINGS"
echo -e "  • Proxy URL: $CC_PROXY_URL"
echo ""
echo -e "${BLUE}📝 Useful commands:${NC}"
echo -e "  # Check proxy health:"
echo -e "  curl -s $CC_PROXY_URL/health | jq ."
echo ""
echo -e "  # View usage stats:"
echo -e "  curl -s $CC_PROXY_URL/usage | jq ."
echo ""
echo -e "  # Restore backup if needed:"
echo -e "  cp $BACKUP_FILE $CLAUDE_SETTINGS"
echo ""

echo -e "${GREEN}✅ All done! Your Claude Code is now configured to use cc-proxy.${NC}"