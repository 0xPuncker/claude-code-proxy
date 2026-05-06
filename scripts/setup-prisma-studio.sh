#!/bin/bash
# Setup script for Prisma Studio database configuration

echo "🔧 Claude Code Proxy - Prisma Studio Setup"
echo "=========================================="
echo ""

# Check if DATABASE_URL is already set
if [ -n "$DATABASE_URL" ]; then
    echo "✅ DATABASE_URL is already configured"
    echo "📊 Current URL: $DATABASE_URL"
    echo ""
    echo "Starting Prisma Studio..."
    npm run prisma:studio
    exit 0
fi

echo "📝 Database URL Configuration"
echo ""
echo "Choose your database setup:"
echo ""
echo "1) PostgreSQL (local Docker)"
echo "2) PostgreSQL (local installation)"
echo "3) Supabase (cloud)"
echo "4) Existing DATABASE_URL"
echo "5) Skip database (disable tracking)"
echo ""
read -p "Enter choice (1-5): " choice

case $choice in
    1)
        # Docker PostgreSQL
        echo ""
        echo "🐳 Setting up PostgreSQL in Docker..."

        # Check if Docker is running
        if ! docker info > /dev/null 2>&1; then
            echo "❌ Docker is not running. Please start Docker first."
            exit 1
        fi

        # Start PostgreSQL container
        echo "Starting PostgreSQL container..."
        docker run -d \
            --name cc-proxy-postgres \
            --restart unless-stopped \
            -e POSTGRES_DB=claude_proxy \
            -e POSTGRES_USER=postgres \
            -e POSTGRES_PASSWORD=postgres \
            -p 5432:5432 \
            postgres:16-alpine

        echo "⏳ Waiting for PostgreSQL to start..."
        sleep 5

        # Run Prisma migrations
        echo "📊 Running database migrations..."
        npx prisma migrate deploy

        # Generate Prisma Client
        echo "🔧 Generating Prisma Client..."
        npx prisma generate

        DATABASE_URL="postgresql://postgres:postgres@localhost:5432/claude_proxy"
        echo "✅ PostgreSQL setup complete!"
        ;;

    2)
        # Local PostgreSQL installation
        echo ""
        echo "📝 Local PostgreSQL Configuration"
        echo "Enter your PostgreSQL connection details:"
        echo ""
        read -p "Host (default: localhost): " db_host
        read -p "Port (default: 5432): " db_port
        read -p "Database name (default: claude_proxy): " db_name
        read -p "User (default: postgres): " db_user
        read -s -p "Password: " db_pass
        echo ""

        db_host=${db_host:-localhost}
        db_port=${db_port:-5432}
        db_name=${db_name:-claude_proxy}
        db_user=${db_user:-postgres}

        DATABASE_URL="postgresql://${db_user}:${db_pass}@${db_host}:${db_port}/${db_name}"

        # Test connection
        echo "🔍 Testing database connection..."
        if npx prisma db push --skip-generate --accept-data-loss > /dev/null 2>&1; then
            echo "✅ Connection successful!"
            npx prisma generate
        else
            echo "❌ Connection failed. Please check your credentials."
            exit 1
        fi
        ;;

    3)
        # Supabase
        echo ""
        echo "🌐 Supabase Configuration"
        echo ""
        echo "To get your Supabase connection string:"
        echo "1. Go to https://supabase.com/dashboard"
        echo "2. Select your project"
        echo "3. Go to Settings → Database"
        echo "4. Copy the 'Connection string' (URI format)"
        echo "5. Replace 'postgres://:[YOUR-PASSWORD]@' with your actual password"
        echo ""
        read -p "Paste your Supabase connection string: " supabase_url

        DATABASE_URL="$supabase_url"

        # Test connection
        echo "🔍 Testing Supabase connection..."
        if npx prisma db push --skip-generate --accept-data-loss > /dev/null 2>&1; then
            echo "✅ Connection successful!"
            npx prisma generate
        else
            echo "❌ Connection failed. Please check your connection string."
            exit 1
        fi
        ;;

    4)
        # Existing DATABASE_URL
        echo ""
        read -p "Paste your DATABASE_URL: " existing_url
        DATABASE_URL="$existing_url"

        echo "🔍 Testing connection..."
        if npx prisma db push --skip-generate --accept-data-loss > /dev/null 2>&1; then
            echo "✅ Connection successful!"
            npx prisma generate
        else
            echo "❌ Connection failed. Please check your DATABASE_URL."
            exit 1
        fi
        ;;

    5)
        # Skip database
        echo ""
        echo "⚠️  Skipping database configuration"
        echo "Usage tracking will be disabled."
        echo ""
        echo "To enable tracking later, set DATABASE_URL in your .env file"
        exit 0
        ;;

    *)
        echo "❌ Invalid choice"
        exit 1
        ;;
esac

echo ""
echo "📝 Adding DATABASE_URL to .env file..."
if [ -f .env ]; then
    if grep -q "^DATABASE_URL=" .env; then
        # Update existing DATABASE_URL
        sed -i.bak "s|^DATABASE_URL=.*|DATABASE_URL=$DATABASE_URL|" .env
        echo "✅ Updated existing DATABASE_URL in .env"
    else
        # Add new DATABASE_URL
        echo "" >> .env
        echo "# Database URL for Prisma" >> .env
        echo "DATABASE_URL=$DATABASE_URL" >> .env
        echo "✅ Added DATABASE_URL to .env"
    fi
else
    echo "❌ .env file not found. Please create it first."
    exit 1
fi

echo ""
echo "🚀 Starting Prisma Studio..."
echo "📊 Prisma Studio will open at: http://localhost:5555"
echo ""
export DATABASE_URL="$DATABASE_URL"
npm run prisma:studio
