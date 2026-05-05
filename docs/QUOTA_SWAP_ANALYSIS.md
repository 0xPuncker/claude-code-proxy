# Claude Code Proxy - Provider Swap Analysis

## Current System Behavior

### Swap Triggers (Automatic)

The proxy **automatically swaps** providers when:

1. **Quota Exceeded** (80% of weekly limit by default)
   - Provider marked as `QUOTA_EXCEEDED`
   - Immediate swap to next available provider
   - No further requests sent to exceeded provider

2. **Rate Limiting** (HTTP 429)
   - Immediate provider swap
   - Provider enters cooldown period (default: 60 seconds)
   - Automatic retry after cooldown

3. **Service Unavailable** (HTTP 502, 503)
   - Immediate provider swap
   - Provider enters cooldown period
   - Circuit breaker monitors recovery

4. **Consecutive Failures**
   - 3 consecutive errors → `DEGRADED` state
   - 5 consecutive errors → `UNAVAILABLE` state
   - Automatic health checks to detect recovery

5. **Network Errors**
   - Immediate swap to next provider
   - Failed provider marked for recovery check

### Provider Priority Order

```
1. Anthropic API (Primary)
   ↓ (fails, quota exceeded, or rate limited)
2. Claude Subscription (Fallback)
   ↓ (fails or no credentials)
3. Z.AI (Last Resort)
```

## Quota Analysis: Weekly vs Daily

### Current Implementation: WEEKLY Quota

The system tracks usage **per week** (Monday 00:00:00 UTC to Sunday).

**Example with 1M token weekly limit:**

| Day | Tokens Used | Total Used | % of Weekly | Status |
|-----|-------------|------------|-------------|---------|
| Mon | 150,000     | 150,000    | 15%         | ✓ Anthropic |
| Tue | 150,000     | 300,000    | 30%         | ✓ Anthropic |
| Wed | 150,000     | 450,000    | 45%         | ✓ Anthropic |
| Thu | 150,000     | 600,000    | 60%         | ✓ Anthropic |
| Fri | 150,000     | 750,000    | 75%         | ✓ Anthropic |
| Sat | 50,000      | 800,000    | **80%**     | ⚠️ **SWITCH to Z.AI** |
| Sun | 0           | 800,000    | 80%         | ⚠️ Z.AI (200K wasted) |

**Problem**: You lose 200K tokens (20% of your weekly limit) because the swap happens at 80%.

### Recommended Thresholds

#### Conservative (Safe)
- **Threshold**: 75%
- **Behavior**: Leaves 25% buffer
- **Best for**: Critical applications, no downtime tolerance
- **Example**: 1M limit → Swap at 750K tokens

#### Balanced (Recommended)
- **Threshold**: 90%
- **Behavior**: Leaves 10% buffer
- **Best for**: Most use cases
- **Example**: 1M limit → Swap at 900K tokens

#### Aggressive (Maximum Usage)
- **Threshold**: 95%
- **Behavior**: Leaves 5% buffer
- **Best for**: Cost optimization, tolerance for occasional rate limits
- **Example**: 1M limit → Swap at 950K tokens

#### Maximum Utilization
- **Threshold**: 100%
- **Behavior**: Uses entire quota
- **Best for**: Development, testing
- **Risk**: May hit rate limits during swap

### Daily Quota Calculation

To calculate your ideal threshold based on daily usage:

**Formula**:
```bash
# If you want X tokens per day
WEEKLY_LIMIT = X * 7
WARNING_THRESHOLD = (X * 7 / WEEKLY_LIMIT) * 100
```

**Example: 150K tokens per day**
```bash
WEEKLY_LIMIT = 150,000 * 7 = 1,050,000
WARNING_THRESHOLD = 1,050,000 / 1,050,000 * 100 = 100%
```

**Example: 143K tokens per day (with 90% threshold)**
```bash
WEEKLY_LIMIT = 1,000,000
WARNING_THRESHOLD = 90%
DAILY_LIMIT = (1,000,000 * 0.90) / 7 = 128,571 tokens/day
```

## Configuration Recommendations

### For Production Use

```bash
# Weekly limit based on your plan
ANTHROPIC_WEEKLY_LIMIT=1000000  # 1M tokens per week

# 90% threshold = 900K tokens used before swap
# This gives you ~128K tokens per day with buffer
QUOTA_WARNING_THRESHOLD=90

# Circuit breaker settings
CIRCUIT_BREAKER_ENABLED=true
CIRCUIT_BREAKER_COOLDOWN_MS=60000  # 1 minute cooldown
CIRCUIT_BREAKER_DEGRADED_THRESHOLD=3
CIRCUIT_BREAKER_UNAVAILABLE_THRESHOLD=5
```

### For Development/Testing

```bash
# Lower limit for testing
ANTHROPIC_WEEKLY_LIMIT=100000

# 95% threshold = maximum utilization
QUOTA_WARNING_THRESHOLD=95

# Faster cooldown for testing
CIRCUIT_BREAKER_COOLDOWN_MS=30000  # 30 seconds
```

### For Cost Optimization

```bash
# Maximum utilization
ANTHROPIC_WEEKLY_LIMIT=1000000
QUOTA_WARNING_THRESHOLD=95

# Higher tolerance for failures
CIRCUIT_BREAKER_DEGRADED_THRESHOLD=5
CIRCUIT_BREAKER_UNAVAILABLE_THRESHOLD=10
```

## Monitoring Your Usage

### Check Current Status

```bash
# Check provider health and quota
curl http://127.0.0.1:4181/providers

# Check overall system health
curl http://127.0.0.1:4181/health

# Check usage statistics
curl http://127.0.0.1:4181/usage
```

### Understanding the Responses

**Provider Status Response:**
```json
{
  "provider": "anthropic",
  "state": "healthy",  // or "quota_exceeded", "degraded", "unavailable"
  "available": true,
  "quota": {
    "limit": 1000000,
    "used": 450000,
    "remaining": 550000,
    "percentageUsed": 45.0,
    "warningThreshold": 90
  }
}
```

**States:**
- `healthy` - Provider is working and under quota
- `degraded` - Provider has some failures but still available
- `unavailable` - Provider has too many failures
- `quota_exceeded` - Provider has reached the warning threshold
- `cooling_down` - Provider is in cooldown period

## Swap Verification

### Test Automatic Swap

```bash
# Set a low limit to test swapping
ANTHROPIC_WEEKLY_LIMIT=1000
QUOTA_WARNING_THRESHOLD=50

# Make requests - after 500 tokens, it should swap to Z.AI
curl -X POST http://127.0.0.1:4181/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-key" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 100
  }'

# Check logs - you should see:
# [INFO] → ANTHROPIC POST /v1/messages
# [WARN] ← ANTHROPIC quota_exceeded — trying subscription
# [INFO] → Z.AI POST /v1/messages
```

### Manual Provider Reset

```bash
# Reset all providers to healthy state
curl -X POST http://127.0.0.1:4181/providers/reset
```

## Troubleshooting

### Swap Not Happening

**Problem**: Provider exceeds quota but swap doesn't occur.

**Solutions**:
1. Check if circuit breaker is enabled: `CIRCUIT_BREAKER_ENABLED=true`
2. Verify quota limit is set: `ANTHROPIC_WEEKLY_LIMIT=1000000` (not 0)
3. Check provider state: `curl http://127.0.0.1:4181/providers`
4. Review logs for swap messages

### Provider Never Recovers

**Problem**: Provider stays in unavailable state after quota reset.

**Solutions**:
1. Week resets on Monday 00:00:00 UTC - check if it's Monday
2. Manually reset: `curl -X POST http://127.0.0.1:4181/providers/reset`
3. Check health check interval: `CIRCUIT_BREAKER_HEALTH_CHECK_INTERVAL=30000`

### Too Frequent Swapping

**Problem**: Provider swaps too often, causing instability.

**Solutions**:
1. Increase warning threshold: `QUOTA_WARNING_THRESHOLD=95`
2. Increase degraded threshold: `CIRCUIT_BREAKER_DEGRADED_THRESHOLD=5`
3. Increase unavailable threshold: `CIRCUIT_BREAKER_UNAVAILABLE_THRESHOLD=10`
4. Increase cooldown: `CIRCUIT_BREAKER_COOLDOWN_MS=120000`

## Best Practices

### 1. Start with Conservative Settings
```bash
QUOTA_WARNING_THRESHOLD=75  # Start conservative
```

### 2. Monitor Usage for a Week
```bash
# Check usage daily
curl http://127.0.0.1:4181/usage?days=7
```

### 3. Adjust Based on Patterns
If you consistently use 600K tokens per week:
```bash
QUOTA_WARNING_THRESHOLD=90  # Safe to use 90%
```

### 4. Set Alerts
Monitor these metrics:
- Quota percentage approaching threshold
- Provider state changes
- Swap frequency

### 5. Test Fallback Chain
Regularly test that all providers work:
```bash
# Verify all providers are configured
curl http://127.0.0.1:4181/providers

# Test each provider independently
```

## Summary

**Current 80% threshold is conservative**. Consider:

- **Production**: 90% threshold (recommended)
- **Development**: 95-100% threshold
- **Critical**: 75% threshold (maximum safety)

**Key Points**:
- System tracks WEEKLY usage, not daily
- Swap happens automatically at threshold %
- All providers are monitored for health
- Automatic recovery after cooldown or week reset
- Manual reset available via API

**Recommended Configuration**:
```bash
ANTHROPIC_WEEKLY_LIMIT=1000000
QUOTA_WARNING_THRESHOLD=90
CIRCUIT_BREAKER_ENABLED=true
```

This gives you ~128K tokens per day with automatic swap to Z.AI when needed.
