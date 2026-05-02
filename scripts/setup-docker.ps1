#!/usr/bin/env pwsh
# Docker Setup Script for Claude Code Proxy on Windows
# Auto-detects user paths and configures environment

Write-Host "=== Claude Code Proxy Docker Setup ===" -ForegroundColor Cyan
Write-Host ""

# Get Windows user profile path
$UserHome = $env:USERPROFILE
$ClaudeCreds = "$UserHome\.claude\.credentials.json"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

Write-Host "🔍 Detected paths:" -ForegroundColor Yellow
Write-Host "  User home: $UserHome"
Write-Host "  Claude credentials: $ClaudeCreds"
Write-Host ""

# Check if credentials file exists
if (-not (Test-Path $ClaudeCreds)) {
    Write-Host "⚠️  Warning: Claude credentials not found at $ClaudeCreds" -ForegroundColor Yellow
    Write-Host "   Subscription fallback will be disabled." -ForegroundColor Yellow
    Write-Host ""
}

# Convert Windows path to Docker format (C:\Users\... -> /c/Users/...)
$DockerCredsPath = $ClaudeCreds -replace '^([A-Z]):', '/$1' -replace '\\', '/'

Write-Host "📝 Creating .env.docker file..." -ForegroundColor Yellow

$EnvContent = @"
# Docker Environment Variables for Claude Code Proxy
# Auto-generated on $(Get-Date -Format "o")

# =============================================================================
# API KEYS (REQUIRED)
# =============================================================================
# Z.AI API configuration - Get your API key from https://z.ai
ZAI_API_KEY=be655a9c7dde4f32944be7c3ea3bad50.vC9I0UOOqC4GQFT2

# Anthropic API configuration - Get your API key from https://console.anthropic.com
ANTHROPIC_API_KEY=

# =============================================================================
# CLAUDE SUBSCRIPTION (OAuth)
# =============================================================================
# Enable Claude.ai Max/Pro subscription as fallback tier
CLAUDE_SUBSCRIPTION_ENABLED=true

# =============================================================================
# PROXY CONFIGURATION
# =============================================================================
PROXY_PORT=4181
PROXY_CONTAINER_NAME=cc-proxy
LOG_LEVEL=info

# =============================================================================
# DATABASE CONFIGURATION
# =============================================================================
POSTGRES_DB=claude_proxy
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
DB_PORT=5432
DB_HOST=cc-db
DB_CONTAINER_NAME=cc-db
DB_SSL=false
DB_MAX_CONNECTIONS=10
DB_IDLE_TIMEOUT_MS=30000
DB_CONNECTION_TIMEOUT_MS=2000
DB_HEALTHCHECK_INTERVAL=10s
DB_HEALTHCHECK_TIMEOUT=5s
DB_HEALTHCHECK_RETRIES=5

# =============================================================================
# ADMINER CONFIGURATION
# =============================================================================
ADMINER_PORT=8080
ADMINER_VERSION=latest
ADMINER_CONTAINER_NAME=cc-adminer
ADMINER_DESIGN=nette
ADMINER_DEFAULT_SERVER=cc-db

# =============================================================================
# POSTGRESQL CONFIGURATION
# =============================================================================
POSTGRES_VERSION=15

# =============================================================================
# CIRCUIT BREAKER CONFIGURATION
# =============================================================================
CIRCUIT_BREAKER_ENABLED=true
CIRCUIT_BREAKER_COOLDOWN_MS=60000
CIRCUIT_BREAKER_DEGRADED_THRESHOLD=3
CIRCUIT_BREAKER_UNAVAILABLE_THRESHOLD=5
CIRCUIT_BREAKER_HEALTH_CHECK_INTERVAL=30000
ANTHROPIC_WEEKLY_LIMIT=0
QUOTA_WARNING_THRESHOLD=80

# =============================================================================
# ENVIRONMENT CONFIGURATION
# =============================================================================
NODE_ENV=production
RESTART_POLICY=unless-stopped
COMPOSE_PROJECT_NAME=claude-code-proxy

# =============================================================================
# WINDOWS PATHS (auto-detected)
# =============================================================================
# Claude credentials path (converted for Docker)
CLAUDE_CREDENTIALS_PATH=$DockerCredsPath
"@

# Write .env.docker
$EnvFilePath = "$ProjectRoot\.env.docker"
$EnvContent | Out-File -FilePath $EnvFilePath -Encoding UTF8

Write-Host "✅ Created: $EnvFilePath" -ForegroundColor Green
Write-Host ""
Write-Host "📊 Configuration summary:" -ForegroundColor Cyan
Write-Host "  Claude credentials mount: $DockerCredsPath"
Write-Host ""

Write-Host "🚀 Next steps:" -ForegroundColor Cyan
Write-Host "  1. Edit .env.docker and add your API keys if needed"
Write-Host "  2. Run: docker-compose --env-file .env.docker up -d"
Write-Host "  3. Check status: docker-compose --env-file .env.docker logs -f cc-proxy"
Write-Host ""
Write-Host "✅ Setup complete!" -ForegroundColor Green
