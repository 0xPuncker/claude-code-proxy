# Prisma Studio Setup Script for Windows
# Run with: .\scripts\setup-prisma-studio.ps1

Write-Host "🔧 Claude Code Proxy - Prisma Studio Setup" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

# Check if DATABASE_URL is already set
if ($env:DATABASE_URL) {
    Write-Host "✅ DATABASE_URL is already configured" -ForegroundColor Green
    Write-Host "📊 Current URL: $env:DATABASE_URL"
    Write-Host ""
    Write-Host "Starting Prisma Studio..."
    npm run prisma:studio
    exit 0
}

Write-Host "📝 Database URL Configuration" -ForegroundColor Yellow
Write-Host ""
Write-Host "Choose your database setup:" -ForegroundColor White
Write-Host ""
Write-Host "1) PostgreSQL (local Docker)" -ForegroundColor Cyan
Write-Host "2) PostgreSQL (local installation)" -ForegroundColor Cyan
Write-Host "3) Supabase (cloud)" -ForegroundColor Cyan
Write-Host "4) Existing DATABASE_URL" -ForegroundColor Cyan
Write-Host "5) Manual DATABASE_URL setup" -ForegroundColor Cyan
Write-Host ""

$choice = Read-Host "Enter choice (1-5)"

switch ($choice) {
    "1" {
        # Docker PostgreSQL
        Write-Host ""
        Write-Host "🐳 Setting up PostgreSQL in Docker..." -ForegroundColor Yellow

        # Check if Docker is running
        $dockerCheck = docker info 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "❌ Docker is not running. Please start Docker Desktop first." -ForegroundColor Red
            exit 1
        }

        # Check if container already exists
        $existingContainer = docker ps -a --filter "name=cc-proxy-postgres" --format "{{.Names}}"
        if ($existingContainer -eq "cc-proxy-postgres") {
            Write-Host "✅ PostgreSQL container already exists" -ForegroundColor Green
            docker start cc-proxy-postgres
        } else {
            # Start PostgreSQL container
            Write-Host "Starting PostgreSQL container..." -ForegroundColor Yellow
            docker run -d `
                --name cc-proxy-postgres `
                --restart unless-stopped `
                -e POSTGRES_DB=claude_proxy `
                -e POSTGRES_USER=postgres `
                -e POSTGRES_PASSWORD=postgres `
                -p 5432:5432 `
                postgres:16-alpine

            Write-Host "⏳ Waiting for PostgreSQL to start..." -ForegroundColor Yellow
            Start-Sleep -Seconds 5
        }

        # Run Prisma migrations
        Write-Host "📊 Running database migrations..." -ForegroundColor Yellow
        npx prisma migrate deploy

        # Generate Prisma Client
        Write-Host "🔧 Generating Prisma Client..." -ForegroundColor Yellow
        npx prisma generate

        $env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/claude_proxy"
        Write-Host "✅ PostgreSQL setup complete!" -ForegroundColor Green
    }

    "2" {
        # Local PostgreSQL installation
        Write-Host ""
        Write-Host "📝 Local PostgreSQL Configuration" -ForegroundColor Yellow
        Write-Host "Enter your PostgreSQL connection details:" -ForegroundColor White
        Write-Host ""

        $dbHost = Read-Host "Host (default: localhost)"
        $dbPort = Read-Host "Port (default: 5432)"
        $dbName = Read-Host "Database name (default: claude_proxy)"
        $dbUser = Read-Host "User (default: postgres)"
        $dbPass = Read-Host "Password" -MaskSecure

        # Set defaults
        if (-not $dbHost) { $dbHost = "localhost" }
        if (-not $dbPort) { $dbPort = "5432" }
        if (-not $dbName) { $dbName = "claude_proxy" }
        if (-not $dbUser) { $dbUser = "postgres" }

        $env:DATABASE_URL = "postgresql://${dbUser}:${dbPass}@${dbHost}:${dbPort}/${dbName}"

        # Test connection
        Write-Host "🔍 Testing database connection..." -ForegroundColor Yellow
        $testResult = npx prisma db push --skip-generate --accept-data-loss 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "✅ Connection successful!" -ForegroundColor Green
            npx prisma generate
        } else {
            Write-Host "❌ Connection failed. Please check your credentials." -ForegroundColor Red
            exit 1
        }
    }

    "3" {
        # Supabase
        Write-Host ""
        Write-Host "🌐 Supabase Configuration" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "To get your Supabase connection string:" -ForegroundColor White
        Write-Host "1. Go to https://supabase.com/dashboard"
        Write-Host "2. Select your project"
        Write-Host "3. Go to Settings → Database"
        Write-Host "4. Copy the 'Connection string' (URI format)"
        Write-Host "5. Replace 'postgres://:[YOUR-PASSWORD]@' with your actual password"
        Write-Host ""

        $supabaseUrl = Read-Host "Paste your Supabase connection string"
        $env:DATABASE_URL = $supabaseUrl

        # Test connection
        Write-Host "🔍 Testing Supabase connection..." -ForegroundColor Yellow
        $testResult = npx prisma db push --skip-generate --accept-data-loss 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "✅ Connection successful!" -ForegroundColor Green
            npx prisma generate
        } else {
            Write-Host "❌ Connection failed. Please check your connection string." -ForegroundColor Red
            exit 1
        }
    }

    "4" {
        # Existing DATABASE_URL
        Write-Host ""
        $existingUrl = Read-Host "Paste your DATABASE_URL"
        $env:DATABASE_URL = $existingUrl

        Write-Host "🔍 Testing connection..." -ForegroundColor Yellow
        $testResult = npx prisma db push --skip-generate --accept-data-loss 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "✅ Connection successful!" -ForegroundColor Green
            npx prisma generate
        } else {
            Write-Host "❌ Connection failed. Please check your DATABASE_URL." -ForegroundColor Red
            exit 1
        }
    }

    "5" {
        # Manual setup
        Write-Host ""
        Write-Host "📝 Manual DATABASE_URL Setup" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "Steps to configure Prisma Studio:" -ForegroundColor White
        Write-Host ""
        Write-Host "1. Add DATABASE_URL to your .env file:" -ForegroundColor Cyan
        Write-Host "   DATABASE_URL=postgresql://user:password@localhost:5432/claude_proxy" -ForegroundColor Gray
        Write-Host ""
        Write-Host "2. Or run Prisma Studio with URL:" -ForegroundColor Cyan
        Write-Host "   DATABASE_URL='your-url' npm run prisma:studio" -ForegroundColor Gray
        Write-Host ""
        Write-Host "3. Common database URLs:" -ForegroundColor Cyan
        Write-Host "   Docker PostgreSQL: postgresql://postgres:postgres@localhost:5432/claude_proxy" -ForegroundColor Gray
        Write-Host "   Local PostgreSQL: postgresql://postgres:your-password@localhost:5432/claude_proxy" -ForegroundColor Gray
        Write-Host ""
        Write-Host "4. Then run: npm run prisma:studio" -ForegroundColor Cyan
        Write-Host ""
        exit 0
    }

    default {
        Write-Host "❌ Invalid choice" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "📝 Adding DATABASE_URL to .env file..." -ForegroundColor Yellow

if (Test-Path .env) {
    $envContent = Get-Content .env
    $hasDatabaseUrl = $false

    foreach ($line in $envContent) {
        if ($line -match "^DATABASE_URL=") {
            $hasDatabaseUrl = $true
            break
        }
    }

    if ($hasDatabaseUrl) {
        # Update existing DATABASE_URL
        (Get-Content .env) -replace "^DATABASE_URL=.*", "DATABASE_URL=$env:DATABASE_URL" | Set-Content .env
        Write-Host "✅ Updated existing DATABASE_URL in .env" -ForegroundColor Green
    } else {
        # Add new DATABASE_URL
        Add-Content -Path .env -Value "`n# Database URL for Prisma"
        Add-Content -Path .env -Value "DATABASE_URL=$env:DATABASE_URL"
        Write-Host "✅ Added DATABASE_URL to .env" -ForegroundColor Green
    }
} else {
    Write-Host "⚠️  .env file not found. Creating..." -ForegroundColor Yellow
    "# Database URL for Prisma" | Out-File -FilePath .env -Encoding utf8
    "DATABASE_URL=$env:DATABASE_URL" | Out-File -FilePath .env -Append -Encoding utf8
    Write-Host "✅ Created .env with DATABASE_URL" -ForegroundColor Green
}

Write-Host ""
Write-Host "🚀 Starting Prisma Studio..." -ForegroundColor Green
Write-Host "📊 Prisma Studio will open at: http://localhost:5555" -ForegroundColor Cyan
Write-Host ""

npm run prisma:studio
