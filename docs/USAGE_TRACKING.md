# Usage Tracking Guide

## Overview

The Claude Code Proxy now includes comprehensive usage tracking with PostgreSQL storage. This feature allows you to monitor:

- **Request metrics**: Count, duration, status codes, streaming vs non-streaming
- **Token usage**: Input/output tokens, cache read/write tokens
- **Provider performance**: Z.AI vs Anthropic API performance
- **Model usage**: Track usage by specific models
- **Error tracking**: Monitor fallback rates and error patterns

## Setup

### Quick Start with Docker

The easiest way to enable usage tracking is using Docker Compose:

```bash
# Set your API keys
export ZAI_API_KEY=your_zai_api_key
export ANTHROPIC_API_KEY=your_anthropic_api_key

# Start with PostgreSQL
docker-compose up -d

# Check logs
docker-compose logs -f claude-code-proxy
```

### Manual Setup with PostgreSQL

1. **Install PostgreSQL** (if not already installed):
   ```bash
   # macOS
   brew install postgresql@15
   brew services start postgresql@15
   
   # Ubuntu/Debian
   sudo apt-get install postgresql postgresql-contrib
   sudo systemctl start postgresql
   ```

2. **Create Database**:
   ```bash
   createdb claude_proxy
   ```

3. **Initialize Schema**:
   ```bash
   psql claude_proxy < src/database/schema.sql
   ```

4. **Configure Environment Variables**:
   ```bash
   export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/claude_proxy
   export DB_HOST=localhost
   export DB_PORT=5432
   export DB_NAME=claude_proxy
   export DB_USER=postgres
   export DB_PASSWORD=postgres
   ```

5. **Start the Proxy**:
   ```bash
   npm start
   ```

## Database Schema

The tracking system uses three main tables:

### 1. `requests` Table
Stores individual request records:
- Request timestamp, method, path
- Model used and provider (zai/anthropic)
- Status code, duration, streaming flag
- Fallback indicator and error messages

### 2. `token_usage` Table
Stores token usage per request:
- Input/output tokens
- Cache creation/read tokens
- Total tokens calculated

### 3. `daily_usage` Table
Aggregated daily statistics:
- Total requests per model/provider
- Cumulative token counts
- Average duration metrics

## API Endpoints

### Health Check
```bash
curl http://localhost:4181/health
```

Response includes tracking status:
```json
{
  "status": "healthy",
  "tracking": true,
  "endpoints": {
    "health": "/health",
    "proxy": "/v1/messages",
    "usage": "/usage"
  }
}
```

### Usage Statistics
```bash
# Get last 7 days of usage
curl http://localhost:4181/usage

# Get last 30 days of usage
curl http://localhost:4181/usage?days=30

# Get last 50 recent requests
curl http://localhost:4181/usage?limit=50

# Combine parameters
curl "http://localhost:4181/usage?days=14&limit=200"
```

Response format:
```json
{
  "daily_usage": [
    {
      "id": 1,
      "date": "2026-04-16",
      "model": "claude-sonnet-4-20250514",
      "provider": "zai",
      "total_requests": 150,
      "total_input_tokens": 125000,
      "total_output_tokens": 89000,
      "total_cache_read_tokens": 5000,
      "total_cache_creation_tokens": 2000,
      "total_tokens": 221000,
      "total_duration_ms": 45600
    }
  ],
  "recent_requests": [
    {
      "id": 1,
      "timestamp": "2026-04-16T10:30:00.000Z",
      "method": "POST",
      "path": "/v1/messages",
      "model": "claude-sonnet-4-20250514",
      "provider": "zai",
      "status_code": 200,
      "duration_ms": 1250,
      "streaming": true,
      "fallback": false,
      "error_message": null
    }
  ],
  "tracking_enabled": true,
  "generated_at": "2026-04-16T10:30:00.000Z"
}
```

## Database Queries

### Get Total Token Usage
```sql
SELECT 
  provider,
  model,
  SUM(input_tokens) as total_input,
  SUM(output_tokens) as total_output,
  SUM(total_tokens) as total_all
FROM requests r
LEFT JOIN token_usage t ON r.id = t.request_id
GROUP BY provider, model;
```

### Get Daily Costs (Example Pricing)
```sql
SELECT 
  DATE(timestamp) as date,
  provider,
  SUM(input_tokens) * 0.003 / 1000 as input_cost,
  SUM(output_tokens) * 0.015 / 1000 as output_cost,
  SUM(input_tokens) * 0.003 / 1000 + SUM(output_tokens) * 0.015 / 1000 as total_cost
FROM requests r
LEFT JOIN token_usage t ON r.id = t.request_id
GROUP BY DATE(timestamp), provider;
```

### Error Rate Analysis
```sql
SELECT 
  provider,
  COUNT(*) as total_requests,
  SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as error_count,
  AVG(CASE WHEN status_code >= 400 THEN 1.0 ELSE 0.0 END) * 100 as error_rate,
  AVG(duration_ms) as avg_duration
FROM requests
GROUP BY provider;
```

### Model Usage Comparison
```sql
SELECT 
  model,
  provider,
  COUNT(*) as request_count,
  AVG(duration_ms) as avg_duration,
  SUM(input_tokens) as total_input_tokens,
  SUM(output_tokens) as total_output_tokens
FROM requests r
LEFT JOIN token_usage t ON r.id = t.request_id
WHERE timestamp >= NOW() - INTERVAL '7 days'
GROUP BY model, provider
ORDER BY request_count DESC;
```

## Performance Monitoring

### Identify Slow Requests
```sql
SELECT 
  id,
  timestamp,
  model,
  provider,
  duration_ms,
  status_code
FROM requests
WHERE duration_ms > 5000
ORDER BY duration_ms DESC
LIMIT 10;
```

### Cache Performance
```sql
SELECT 
  AVG(cache_read_tokens) as avg_cache_read,
  AVG(cache_creation_tokens) as avg_cache_creation,
  SUM(cache_read_tokens) as total_cache_read,
  SUM(cache_creation_tokens) as total_cache_creation,
  COUNT(*) as total_requests
FROM token_usage
WHERE request_id IN (
  SELECT id FROM requests WHERE timestamp >= NOW() - INTERVAL '7 days'
);
```

## Configuration Options

### Database Connection Pool
```bash
# Maximum concurrent connections
DB_MAX_CONNECTIONS=10

# Connection idle timeout (ms)
DB_IDLE_TIMEOUT_MS=30000

# Connection timeout (ms)
DB_CONNECTION_TIMEOUT_MS=2000

# SSL/TLS
DB_SSL=true
```

### Disable Tracking
If you don't want to use database tracking, simply don't set the `DATABASE_URL` environment variable. The proxy will work normally without tracking.

## Docker Compose Services

### PostgreSQL
- **Port**: 5432
- **Database**: claude_proxy
- **User/Password**: postgres/postgres
- **Volume**: postgres_data

### Adminer (Database UI)
- **URL**: http://localhost:8080
- **Server**: postgres
- **Username**: postgres
- **Password**: postgres
- **Database**: claude_proxy

## Troubleshooting

### Database Connection Issues
```bash
# Check if PostgreSQL is running
docker-compose ps postgres

# View PostgreSQL logs
docker-compose logs postgres

# Test connection
psql -h localhost -U postgres -d claude_proxy
```

### Tracking Not Working
1. Verify environment variables are set
2. Check database schema is initialized
3. Review proxy logs for errors
4. Test database connectivity

### Performance Issues
1. Increase `DB_MAX_CONNECTIONS` for high traffic
2. Add indexes to frequently queried columns
3. Use connection pooling
4. Archive old data periodically

## Data Retention

### Archive Old Data
```sql
-- Archive requests older than 90 days
CREATE TABLE requests_archive AS 
SELECT * FROM requests 
WHERE timestamp < NOW() - INTERVAL '90 days';

-- Archive token usage
CREATE TABLE token_usage_archive AS
SELECT t.* FROM token_usage t
JOIN requests r ON t.request_id = r.id
WHERE r.timestamp < NOW() - INTERVAL '90 days';

-- Delete archived data
DELETE FROM requests 
WHERE timestamp < NOW() - INTERVAL '90 days';
```

### Regular Maintenance
```sql
-- Vacuum and analyze
VACUUM ANALYZE requests;
VACUUM ANALYZE token_usage;
VACUUM ANALYZE daily_usage;

-- Reindex if needed
REINDEX TABLE requests;
REINDEX TABLE token_usage;
REINDEX TABLE daily_usage;
```

## Integration Examples

### Grafana Dashboard
Connect Grafana to PostgreSQL for real-time monitoring:
- Request rate over time
- Token usage trends
- Error rates
- Provider performance comparison
- Cost analysis

### Prometheus Exporter
Create a metrics endpoint for Prometheus:
```typescript
app.get('/metrics', async (req, res) => {
  const metrics = await usageTracker.getMetrics();
  res.set('Content-Type', 'text/plain');
  res.send(metricsToPrometheus(metrics));
});
```

### Webhook Notifications
Send alerts based on usage patterns:
```typescript
if (dailyUsage.total_cost > BUDGET_THRESHOLD) {
  sendAlert({ type: 'budget_exceeded', amount: dailyUsage.total_cost });
}
```

## Security Considerations

1. **Database Access**: Restrict database access to localhost or VPN
2. **API Keys**: Never commit API keys to repository
3. **SQL Injection**: The code uses parameterized queries
4. **Data Privacy**: Consider data retention policies
5. **Backup**: Regular database backups recommended

## Support

For issues or questions:
- GitHub: https://github.com/raulneiva/claude-code-proxy
- Database: Check PostgreSQL logs
- Proxy: Check proxy logs with `LOG_LEVEL=debug`
