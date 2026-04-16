# Prisma Setup & Migration Guide

Complete guide for setting up and using Prisma ORM with the Claude Code Proxy.

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Up Database

**Option A: Use Docker Compose (Recommended)**
```bash
docker-compose up -d postgres
```

**Option B: Local PostgreSQL**
```bash
# Create database
createdb claude_proxy

# Set environment variable
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/claude_proxy"
```

### 3. Run Migrations

```bash
# Development migration (creates migration)
npm run prisma:migrate

# Production migration (applies existing migrations)
npm run prisma:migrate:deploy
```

### 4. Generate Prisma Client

```bash
npm run prisma:generate
# Or included in build process:
npm run build
```

### 5. (Optional) Seed Database

```bash
npm run prisma:seed
```

## 📋 Available Scripts

### Prisma Commands

```bash
# Generate Prisma Client
npm run prisma:generate

# Create and apply development migration
npm run prisma:migrate

# Deploy migrations to production
npm run prisma:migrate:deploy

# Reset database (⚠️ deletes all data)
npm run prisma:migrate:reset

# Open Prisma Studio (database GUI)
npm run prisma:studio

# Seed database with example data
npm run prisma:seed
```

### Build Commands

```bash
# Build with Prisma client generation
npm run build

# Development mode with Prisma
npm run dev
```

## 🗄️ Database Schema

### Models

#### Request
```typescript
model Request {
  id           Int      @id @default(autoincrement())
  timestamp    DateTime @default(now()) @db.Timestamptz()
  method       String   @db.VarChar(10)
  path         String   @db.VarChar(255)
  model        String?  @db.VarChar(100)
  provider     String   @db.VarChar(50)
  statusCode   Int      @map("status_code")
  durationMs   Int?     @map("duration_ms")
  streaming    Boolean  @default(false)
  fallback     Boolean  @default(false)
  errorMessage String?  @map("error_message") @db.Text
  createdAt    DateTime @default(now()) @db.Timestamptz()
  
  tokenUsage   TokenUsage[]
}
```

#### TokenUsage
```typescript
model TokenUsage {
  id                  Int      @id @default(autoincrement())
  requestId           Int      @map("request_id")
  inputTokens         Int      @map("input_tokens")
  outputTokens        Int      @map("output_tokens")
  cacheCreationTokens Int      @default(0) @map("cache_creation_tokens")
  cacheReadTokens     Int      @default(0) @map("cache_read_tokens")
  totalTokens         Int      @map("total_tokens")
  createdAt           DateTime @default(now()) @db.Timestamptz()
  
  request             Request  @relation(fields: [requestId], references: [id], onDelete: Cascade)
}
```

#### DailyUsage
```typescript
model DailyUsage {
  id                       Int      @id @default(autoincrement())
  date                     DateTime @db.Date
  model                    String
  provider                 String
  totalRequests           Int      @default(0) @map("total_requests")
  totalInputTokens        Int      @default(0) @map("total_input_tokens")
  totalOutputTokens       Int      @default(0) @map("total_output_tokens")
  totalCacheReadTokens    Int      @default(0) @map("total_cache_read_tokens")
  totalCacheCreationTokens Int     @default(0) @map("total_cache_creation_tokens")
  totalTokens             Int      @default(0) @map("total_tokens")
  totalDurationMs         BigInt   @default(0) @map("total_duration_ms")
  updatedAt               DateTime @default(now()) @db.Timestamptz()
  
  @@unique([date, model, provider])
}
```

## 🔍 Using Prisma Client

### Basic Usage

```typescript
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// Create a request record
const request = await prisma.request.create({
  data: {
    method: 'POST',
    path: '/v1/messages',
    model: 'claude-sonnet-4-20250514',
    provider: 'zai',
    statusCode: 200,
    durationMs: 1250,
    streaming: true,
    fallback: false,
  }
})

// Create token usage
const tokenUsage = await prisma.tokenUsage.create({
  data: {
    requestId: request.id,
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 0,
    cacheReadTokens: 100,
    totalTokens: 1600,
  }
})

// Query recent requests
const recentRequests = await prisma.request.findMany({
  orderBy: { timestamp: 'desc' },
  take: 10,
  include: {
    tokenUsage: true
  }
})

// Get daily usage statistics
const dailyStats = await prisma.dailyUsage.findMany({
  where: {
    date: {
      gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    }
  },
  orderBy: { date: 'desc' }
})
```

### Advanced Queries

#### Token Usage by Provider
```typescript
const providerUsage = await prisma.tokenUsage.groupBy({
  by: ['request'],
  _sum: {
    inputTokens: true,
    outputTokens: true,
    totalTokens: true,
  },
  where: {
    request: {
      provider: 'zai'
    }
  }
})
```

#### Average Duration by Model
```typescript
const avgDuration = await prisma.request.aggregate({
  _avg: {
    durationMs: true
  },
  where: {
    model: 'claude-sonnet-4-20250514',
    statusCode: { lt: 400 }
  }
})
```

#### Error Rate Analysis
```typescript
const errorStats = await prisma.request.groupBy({
  by: ['provider', 'statusCode'],
  _count: true,
  where: {
    statusCode: { gte: 400 }
  }
})
```

## 🎨 Prisma Studio

### Database GUI

```bash
npm run prisma:studio
```

Opens a web-based database GUI at `http://localhost:5555`

**Features:**
- View and edit all data
- Create, update, delete records
- Filter and search
- Relationships visualization
- Query builder

## 🔄 Migration Workflow

### Development

```bash
# 1. Modify schema.prisma
# 2. Create migration
npx prisma migrate dev --name add_new_field

# 3. Apply changes to database
npx prisma migrate dev
```

### Production

```bash
# 1. Deploy migration
npx prisma migrate deploy

# 2. Generate client
npx prisma generate
```

### Migration Best Practices

1. **Descriptive Names**: Use clear migration names
   ```bash
   npx prisma migrate dev --name add_user_preferences_table
   ```

2. **Test Locally**: Always test migrations locally first
   ```bash
   # Reset and re-test
   npx prisma migrate reset
   npx prisma migrate dev
   npm run prisma:seed
   ```

3. **Backup First**: Before production migrations
   ```bash
   pg_dump claude_proxy > backup.sql
   npx prisma migrate deploy
   ```

4. **Version Control**: Keep migrations in git
   ```bash
   git add prisma/migrations/
   git commit -m "Add new feature migration"
   ```

## 📊 Performance Optimization

### Indexes

The schema includes optimized indexes:

```sql
-- Request queries
CREATE INDEX idx_requests_timestamp ON requests("timestamp" DESC);
CREATE INDEX idx_requests_provider ON requests("provider");
CREATE INDEX idx_requests_model ON requests("model");
CREATE INDEX idx_requests_status ON requests("status_code");

-- Token usage queries
CREATE INDEX idx_token_usage_request_id ON token_usage("request_id");

-- Daily usage queries
CREATE INDEX idx_daily_usage_date ON daily_usage("date" DESC);
CREATE INDEX idx_daily_usage_model ON daily_usage("model", "provider");
```

### Query Optimization

```typescript
// ❌ Inefficient - N+1 queries
const requests = await prisma.request.findMany()
for (const request of requests) {
  const usage = await prisma.tokenUsage.findUnique({
    where: { requestId: request.id }
  })
}

// ✅ Efficient - Single query with include
const requests = await prisma.request.findMany({
  include: {
    tokenUsage: true
  }
})
```

### Connection Pooling

```typescript
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    }
  },
  // Connection pool configuration
  log: ['query', 'error', 'warn'],
})
```

## 🐛 Troubleshooting

### Migration Issues

**Problem**: Migration fails with "relation does not exist"
```bash
# Solution: Check migration order
npx prisma migrate reset --force
npm run prisma:migrate
```

**Problem**: Client generation fails
```bash
# Solution: Clean and regenerate
rm -rf node_modules/@prisma/client
npm run prisma:generate
```

### Database Connection Issues

**Problem**: "Connection refused"
```bash
# Check PostgreSQL is running
docker-compose ps postgres

# Check connection string
echo $DATABASE_URL
```

**Problem**: "Password authentication failed"
```bash
# Update credentials in .env
# Reset database if needed
npx prisma migrate reset
```

### Performance Issues

**Problem**: Slow queries
```bash
# Enable query logging
DEBUG="prisma:query" npm start

# Check for missing indexes
npx prisma studio
# Analyze slow queries in PostgreSQL
```

## 🚀 Production Deployment

### Environment Variables

```bash
# Required
DATABASE_URL="postgresql://user:password@host:5432/database"

# Optional
DIRECT_URL="postgresql://user:password@host:5432/database"
```

### Deployment Steps

1. **Set environment variables**
2. **Run migrations**
   ```bash
   npm run prisma:migrate:deploy
   ```
3. **Generate client**
   ```bash
   npm run build
   ```
4. **Seed production data** (optional)
   ```bash
   DATABASE_URL="$PRODUCTION_DB_URL" npm run prisma:seed
   ```

### Docker Deployment

```dockerfile
# Dockerfile
FROM node:18-alpine
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Generate Prisma Client
COPY prisma ./prisma/
RUN npx prisma generate

# Copy source
COPY dist ./dist

# Run migrations
CMD ["npm", "run", "prisma:migrate:deploy", "&&", "npm", "start"]
```

## 📖 Additional Resources

- [Prisma Documentation](https://www.prisma.io/docs/)
- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [Usage Tracking Guide](./USAGE_TRACKING.md)
- [Postman Collection Guide](../postman/README.md)

## 🤝 Contributing

When adding new database features:

1. **Update Schema**: Modify `prisma/schema.prisma`
2. **Create Migration**: `npx prisma migrate dev --name description`
3. **Update Types**: Regenerate Prisma client
4. **Test Locally**: Verify functionality works
5. **Update Docs**: Document new fields/relationships
6. **Commit All**: Include migration files in commit

## 📞 Support

For Prisma-specific issues:
- Prisma Docs: https://www.prisma.io/docs/
- GitHub Issues: https://github.com/prisma/prisma/issues

For proxy-specific issues:
- Project Issues: https://github.com/raulneiva/claude-code-proxy/issues
- Documentation: See `/docs` folder
