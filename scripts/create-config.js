const fs = require('fs');

const content = `# Claude Code Proxy - Environment Configuration Guide

This document describes all available environment variables for configuring the Claude Code Proxy.

## Quick Start

1. Copy this guide and create your .env file
2. Set your required API keys
3. Adjust optional settings as needed
4. Start the proxy with your configuration

bash
# Required minimum configuration
ZAI_API_KEY=your-zai-api-key-here
ANTHROPIC_API_KEY=your-anthropic-api-key-here

# Start the proxy
npm start


## API Keys (Required)

### Z.AI API Key
- Variable: ZAI_API_KEY
- Description: Fallback provider API key
- Get your key: https://z.ai/
- Default: (empty)
- Required: Yes, for production use

### Anthropic API Key
- Variable: ANTHROPIC_API_KEY
- Description: Primary provider API key
- Get your key: https://console.anthropic.com/
- Default: (empty)
- Required: Yes, for production use

## Provider Priority

The proxy uses the following priority order:

### 1. Anthropic API (Primary)
- Used first when available
- Subject to weekly quota limits
- Monitored by circuit breaker

### 2. Claude Subscription (Fallback)
- Used when Anthropic API fails or quota exceeded
- Reads from ~/.claude/.credentials.json
- Requires valid OAuth token

### 3. Z.AI (Last Resort)
- Used when both Anthropic and Subscription fail
- No quota limits
- Monitored by circuit breaker

## Anthropic API Quota Configuration

### Weekly Token Limit
- Variable: ANTHROPIC_WEEKLY_LIMIT
- Description: Weekly token limit for Anthropic API
- Default: 0 (no limit)
- Example: ANTHROPIC_WEEKLY_LIMIT=1000000 (1M tokens/week)

How it works:
- Set to your weekly token limit to enable quota tracking
- Proxy automatically switches to Z.AI when limit is reached
- Week starts on Monday 00:00:00 UTC
- Usage is tracked per provider

### Quota Warning Threshold
- Variable: QUOTA_WARNING_THRESHOLD
- Description: Percentage to trigger quota warning
- Default: 80 (warn at 80% usage)
- Range: 0-100
- Example: QUOTA_WARNING_THRESHOLD=90 (warn at 90%)

Token Limit Example:

bash
# Enable quota tracking with 1M tokens per week
ANTHROPIC_WEEKLY_LIMIT=1000000
QUOTA_WARNING_THRESHOLD=80

# Proxy will:
# 1. Track all token usage from Anthropic API
# 2. Warn when 800K tokens (80%) are used
# 3. Switch to Z.AI when 1M tokens (100%) are reached
# 4. Reset counter every Monday at 00:00:00 UTC



## Circuit Breaker Configuration

### Enable Circuit Breaker
- Variable: CIRCUIT_BREAKER_ENABLED
- Description: Enable automatic provider switching based on health
- Options: true, false
- Default: true
- Example: CIRCUIT_BREAKER_ENABLED=true

### Cooldown Period
- Variable: CIRCUIT_BREAKER_COOLDOWN_MS
- Description: Milliseconds before retrying a failed provider
- Default: 60000 (1 minute)
- Example: CIRCUIT_BREAKER_COOLDOWN_MS=120000 (2 minutes)

## Timeout Configuration

### Request Timeout
- Variable: API_TIMEOUT_MS
- Description: Maximum time for non-streaming requests
- Default: 300000 (5 minutes)
- Example: API_TIMEOUT_MS=600000 (10 minutes)

### Streaming Timeout
- Variable: API_STREAMING_TIMEOUT_MS
- Description: Maximum time for streaming requests
- Default: 600000 (10 minutes)
- Example: API_STREAMING_TIMEOUT_MS=900000 (15 minutes)

### Max Retries
- Variable: API_MAX_RETRIES
- Description: Maximum retry attempts for failed requests
- Default: 3
- Example: API_MAX_RETRIES=5

## Complete Example Configuration

bash
# Required API Keys
ZAI_API_KEY=zai-sk-xxxxxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxx

# Server Configuration
PROXY_PORT=4181
LOG_LEVEL=info

# Claude Subscription
CLAUDE_SUBSCRIPTION_ENABLED=true

# Circuit Breaker
CIRCUIT_BREAKER_ENABLED=true
CIRCUIT_BREAKER_COOLDOWN_MS=60000

# Anthropic Quota
ANTHROPIC_WEEKLY_LIMIT=1000000
QUOTA_WARNING_THRESHOLD=80

# Timeouts
API_TIMEOUT_MS=300000
API_STREAMING_TIMEOUT_MS=600000
API_MAX_RETRIES=3
API_RETRY_DELAY_MS=1000



## Security Best Practices

1. Never commit .env files to version control
2. Use different keys for development and production
3. Rotate API keys regularly
4. Set appropriate quota limits to prevent unexpected charges
5. Monitor logs for unusual activity or quota usage

For more information, see:
- README.md - General project information
- docs/TIMEOUT_CONFIGURATION.md - Detailed timeout guide
`;

fs.writeFileSync('ENV_CONFIGURATION.md', content);
console.log('Created ENV_CONFIGURATION.md');
