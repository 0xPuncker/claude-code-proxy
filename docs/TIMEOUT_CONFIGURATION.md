# Timeout & Retry Configuration Guide

## Overview

The Claude Code Proxy includes intelligent timeout handling and retry logic to prevent hanging requests and improve reliability. This helps address the "Retrying in 0s · attempt X/10 · API_TIMEOUT_MS=3000000ms" messages you may be experiencing.

## Problem: Timeout Retry Messages

If you're seeing messages like:
```
Retrying in 0s · attempt 5/10 · API_TIMEOUT_MS=3000000ms, try increasing it
```

This typically indicates:
- The Claude Code client is experiencing timeouts when making requests
- The default timeout (50 minutes) is too long or requests are hanging
- Network issues or slow API responses

## Solution: Configure Proper Timeouts

### Environment Variables

Configure these environment variables to optimize timeout behavior:

```bash
# Timeout for non-streaming requests (default: 300000ms = 5 minutes)
API_TIMEOUT_MS=300000

# Timeout for streaming requests (default: 600000ms = 10 minutes)  
API_STREAMING_TIMEOUT_MS=600000

# Maximum retry attempts for timeouts (default: 3)
API_MAX_RETRIES=3

# Delay between retries in milliseconds (default: 1000ms)
API_RETRY_DELAY_MS=1000
```

### Recommended Configurations

#### For Fast Networks (Local Development)
```bash
API_TIMEOUT_MS=60000           # 1 minute
API_STREAMING_TIMEOUT_MS=120000 # 2 minutes
API_MAX_RETRIES=2
API_RETRY_DELAY_MS=500
```

#### For Standard Usage
```bash
API_TIMEOUT_MS=300000          # 5 minutes (default)
API_STREAMING_TIMEOUT_MS=600000 # 10 minutes (default)
API_MAX_RETRIES=3
API_RETRY_DELAY_MS=1000
```

#### For Slow Networks or Large Requests
```bash
API_TIMEOUT_MS=600000          # 10 minutes
API_STREAMING_TIMEOUT_MS=1800000 # 30 minutes
API_MAX_RETRIES=5
API_RETRY_DELAY_MS=2000
```

## How Timeout Handling Works

### 1. Request Timeout Detection
- Non-streaming requests: Timeout after `API_TIMEOUT_MS`
- Streaming requests: Timeout after `API_STREAMING_TIMEOUT_MS`
- Automatic detection of timeout errors (ETIMEDOUT, ESOCKETTIMEDOUT)

### 2. Exponential Backoff Retry
- First retry: `API_RETRY_DELAY_MS` (default: 1000ms)
- Second retry: `2 × API_RETRY_DELAY_MS` (default: 2000ms)
- Third retry: `4 × API_RETRY_DELAY_MS` (default: 4000ms)
- Maximum retries: `API_MAX_RETRIES` (default: 3)

### 3. Intelligent Error Handling
- Timeouts trigger automatic retry with fallback providers
- Network errors are logged with detailed error messages
- Circuit breaker prevents cascading failures

## Configuration Examples

### Docker Compose
```yaml
version: '3.8'
services:
  claude-code-proxy:
    image: claude-code-proxy:latest
    environment:
      - API_TIMEOUT_MS=300000
      - API_STREAMING_TIMEOUT_MS=600000
      - API_MAX_RETRIES=3
      - API_RETRY_DELAY_MS=1000
      - ZAI_API_KEY=${ZAI_API_KEY}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
    ports:
      - "4181:4181"
```

### Direct Environment Variables
```bash
# Set timeout variables
export API_TIMEOUT_MS=300000
export API_STREAMING_TIMEOUT_MS=600000
export API_MAX_RETRIES=3
export API_RETRY_DELAY_MS=1000

# Start the proxy
npm start
```

### Docker Run
```bash
docker run -d \
  -e API_TIMEOUT_MS=300000 \
  -e API_STREAMING_TIMEOUT_MS=600000 \
  -e API_MAX_RETRIES=3 \
  -e API_RETRY_DELAY_MS=1000 \
  -e ZAI_API_KEY=your_key \
  -e ANTHROPIC_API_KEY=your_key \
  -p 4181:4181 \
  claude-code-proxy:latest
```

## Troubleshooting Timeout Issues

### 1. Identify Timeout Patterns
Check proxy logs for timeout messages:
```bash
# View logs for timeout errors
docker-compose logs | grep -i timeout

# Check specific timeout patterns
docker-compose logs | grep "Request timeout"
```

### 2. Monitor Request Duration
Use the `/usage` endpoint to identify slow requests:
```bash
curl "http://127.0.0.1:4181/usage?days=1&limit=50" | jq '.recent_requests[] | select(.duration_ms > 10000)'
```

### 3. Test Timeout Configuration
```bash
# Test with shorter timeout to verify behavior
export API_TIMEOUT_MS=10000  # 10 seconds
npm start

# Make a test request
curl -X POST http://127.0.0.1:4181/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### 4. Adjust Based on Usage Patterns
- **Frequent timeouts**: Increase `API_TIMEOUT_MS` and `API_MAX_RETRIES`
- **Slow response times**: Increase `API_STREAMING_TIMEOUT_MS`
- **Network issues**: Increase `API_RETRY_DELAY_MS` for more backoff
- **Quick requests needed**: Decrease timeouts for faster failure detection

## Advanced Configuration

### Per-Request Timeouts
For specific use cases, you can modify the code to set per-request timeouts:

```typescript
// In src/index.ts
private async customTimeoutRequest(url: string, options: RequestOptions, customTimeoutMs: number): Promise<HttpResponse> {
  return await this.httpRequest(url, options, customTimeoutMs);
}
```

### Timeout vs Circuit Breaker
- **Timeout**: Maximum time to wait for a single request
- **Circuit Breaker**: Cooldown period after consecutive failures
- Both work together to provide reliable service

```bash
# Timeout configuration
API_TIMEOUT_MS=300000

# Circuit breaker configuration  
CIRCUIT_BREAKER_COOLDOWN_MS=60000
CIRCUIT_BREAKER_UNAVAILABLE_THRESHOLD=5
```

## Performance Optimization

### 1. Reduce Timeout for Fast Failure
```bash
# Fail fast on unresponsive requests
API_TIMEOUT_MS=30000       # 30 seconds
API_MAX_RETRIES=1          # Only retry once
API_RETRY_DELAY_MS=500     # Short retry delay
```

### 2. Increase Timeout for Complex Requests
```bash
# Allow more time for complex requests
API_TIMEOUT_MS=900000       # 15 minutes
API_STREAMING_TIMEOUT_MS=1800000 # 30 minutes
API_MAX_RETRIES=5          # More retries for long requests
API_RETRY_DELAY_MS=2000    # Longer delay between retries
```

### 3. Optimize Retry Strategy
```bash
# Balanced retry strategy
API_TIMEOUT_MS=300000
API_MAX_RETRIES=3
API_RETRY_DELAY_MS=1000    # Exponential: 1s, 2s, 4s
```

## Monitoring and Alerts

### Log Analysis
```bash
# Count timeout errors in the last hour
docker-compose logs --since="1h ago" | grep -c "Request timeout"

# Find timeout patterns
docker-compose logs --since="1h ago" | grep "Request timeout" | tail -20
```

### Health Check Integration
The `/health` endpoint includes proxy status:
```bash
curl http://127.0.0.1:4181/health
```

### Timeout Metrics
Monitor timeout rates over time:
```bash
# Get request metrics
curl "http://127.0.0.1:4181/usage?days=7" | jq '.daily_usage[] | {date, total_requests, error_count}'
```

## Best Practices

1. **Start with defaults**: Use default timeouts initially
2. **Monitor patterns**: Track timeout frequency and duration
3. **Adjust gradually**: Make incremental changes based on data
4. **Consider use case**: Different requests need different timeouts
5. **Test changes**: Verify timeout changes work as expected
6. **Document custom values**: Keep track of custom configurations
7. **Balance speed and reliability**: Faster timeouts vs better success rates

## Common Timeout Scenarios

### Scenario 1: Large Context Requests
```bash
# Large prompts or documents
API_TIMEOUT_MS=900000       # 15 minutes
API_STREAMING_TIMEOUT_MS=1800000 # 30 minutes
```

### Scenario 2: High Concurrency
```bash
# Many concurrent requests
API_TIMEOUT_MS=180000       # 3 minutes (shorter to free resources)
API_MAX_RETRIES=2          # Fewer retries to reduce load
```

### Scenario 3: Unreliable Network
```bash
# Intermittent connectivity
API_TIMEOUT_MS=600000       # 10 minutes
API_MAX_RETRIES=5          # More retries
API_RETRY_DELAY_MS=2000    # Longer delays
```

### Scenario 4: Development/Testing
```bash
# Quick feedback during development
API_TIMEOUT_MS=30000       # 30 seconds
API_MAX_RETRIES=1          # Minimal retries
```

## Support

For persistent timeout issues:
1. Check network connectivity: `ping api.z.ai`
2. Verify API key validity
3. Monitor provider status: `curl http://127.0.0.1:4181/providers`
4. Review proxy logs: `docker-compose logs -f`
5. Check circuit breaker state: `curl http://127.0.0.1:4181/providers/reset`

For more information, see:
- [Usage Tracking Guide](./USAGE_TRACKING.md)
- [Claude Settings Guide](./CLAUDE_SETTINGS_GUIDE.md)