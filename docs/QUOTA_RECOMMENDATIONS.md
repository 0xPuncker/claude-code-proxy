# Recommended Quota Thresholds for Daily Usage

## Quick Answer: What Percentage Should I Use?

### For Most Users: 90% Threshold (Recommended)

```bash
ANTHROPIC_WEEKLY_LIMIT=1000000
QUOTA_WARNING_THRESHOLD=90
```

**This gives you:**
- ~128,000 tokens per day
- 10% safety buffer
- Automatic swap when needed
- Maximum cost efficiency

## Daily Usage Breakdown

### With 1M Weekly Limit at Different Thresholds

| Threshold | Weekly Budget | Daily Budget | Monthly Budget |
|-----------|---------------|--------------|----------------|
| 75% (Conservative) | 750K tokens | 107K/day | 3.2M tokens |
| 80% (Default) | 800K tokens | 114K/day | 3.4M tokens |
| 90% (Recommended) | 900K tokens | 128K/day | 3.9M tokens |
| 95% (Aggressive) | 950K tokens | 135K/day | 4.1M tokens |
| 100% (Maximum) | 1M tokens | 143K/day | 4.3M tokens |

### Calculate Your Ideal Threshold

**Step 1: Estimate your daily token usage**
- Track your usage for a few days
- Check with `curl http://127.0.0.1:4181/usage?days=7`

**Step 2: Calculate weekly requirement**
```bash
WEEKLY_NEEDED = DAILY_USAGE × 7
```

**Step 3: Add safety buffer (recommended 10-20%)**
```bash
WEEKLY_LIMIT = WEEKLY_NEEDED × 1.2
```

**Step 4: Set threshold**
```bash
THRESHOLD = (WEEKLY_NEEDED / WEEKLY_LIMIT) × 100
```

### Example Calculation

**Scenario**: You use ~100K tokens per day

```bash
WEEKLY_NEEDED = 100,000 × 7 = 700,000
WEEKLY_LIMIT = 700,000 × 1.2 = 840,000 (round up to 1,000,000)
THRESHOLD = (700,000 / 1,000,000) × 100 = 70%
```

**Configuration**:
```bash
ANTHROPIC_WEEKLY_LIMIT=1000000
QUOTA_WARNING_THRESHOLD=70
```

## When to Use Each Threshold

### 75% Threshold (Conservative)
- **Best for**: Critical production systems
- **Daily usage**: Up to 107K tokens (with 1M weekly limit)
- **Buffer**: 25% safety margin
- **When to use**:
  - Zero downtime tolerance
  - Unexpected traffic spikes
  - Multiple applications sharing quota

### 90% Threshold (Recommended)
- **Best for**: Most production use cases
- **Daily usage**: Up to 128K tokens (with 1M weekly limit)
- **Buffer**: 10% safety margin
- **When to use**:
  - Normal production workload
  - Predictable traffic patterns
  - Cost-conscious with safety

### 95% Threshold (Aggressive)
- **Best for**: Cost optimization
- **Daily usage**: Up to 135K tokens (with 1M weekly limit)
- **Buffer**: 5% safety margin
- **When to use**:
  - Development/staging environments
  - Non-critical applications
  - Tight budget constraints

### 100% Threshold (Maximum)
- **Best for**: Testing and development
- **Daily usage**: Up to 143K tokens (with 1M weekly limit)
- **Buffer**: 0% safety margin
- **When to use**:
  - Testing quota tracking
  - Development environments
  - When you want to use every token

## Swap Behavior Verification

### Automatic Swap Scenarios

The proxy **automatically swaps** providers in these cases:

1. **Quota Exceeded** (at your threshold %)
   ```
   Example: 90% threshold with 1M limit
   - At 900K tokens used → Swap to Z.AI
   - No more Anthropic requests until Monday reset
   ```

2. **Rate Limiting** (HTTP 429)
   ```
   Immediate swap to next provider
   Original provider enters 60-second cooldown
   ```

3. **Service Unavailable** (HTTP 502, 503)
   ```
   Immediate swap to next provider
   Circuit breaker monitors for recovery
   ```

4. **Network Errors**
   ```
   Immediate swap to next provider
   Failed provider scheduled for health check
   ```

### Testing Your Configuration

```bash
# 1. Set a low limit for testing
export ANTHROPIC_WEEKLY_LIMIT=1000
export QUOTA_WARNING_THRESHOLD=50

# 2. Start the proxy
npm start

# 3. Make requests until quota is exceeded
# After 500 tokens (50%), you should see:
# [INFO] → ANTHROPIC POST /v1/messages
# [WARN] ← ANTHROPIC quota_exceeded — trying subscription
# [INFO] → Z.AI POST /v1/messages

# 4. Verify swap happened
curl http://127.0.0.1:4181/providers
```

## Monitoring Your Quota

### Real-Time Monitoring

```bash
# Check current quota status
curl http://127.0.0.1:4181/providers | jq '.providers[] | select(.provider=="anthropic") | .quota'

# Response example:
{
  "limit": 1000000,
  "used": 450000,
  "remaining": 550000,
  "percentageUsed": 45.0,
  "warningThreshold": 90
}
```

### Daily Usage Check

```bash
# Check last 7 days usage
curl http://127.0.0.1:4181/usage?days=7 | jq '.daily_usage'

# Calculate daily average
curl http://127.0.0.1:4181/usage?days=7 | jq '[.daily_usage[].total_tokens] | add / length'
```

## Common Issues and Solutions

### Issue: Proxy swaps too early

**Problem**: Swap happens before you expect
```
Expected: 90% threshold (900K tokens)
Actual: Swap at 800K tokens
```

**Solution**:
1. Check actual threshold: `curl http://127.0.0.1:4181/providers | jq '.providers[] | .quota.warningThreshold'`
2. Verify env var is set: `echo $QUOTA_WARNING_THRESHOLD`
3. Restart proxy after changing config

### Issue: Proxy never swaps

**Problem**: Anthropic usage exceeds 100% but no swap

**Solutions**:
1. Check circuit breaker is enabled:
   ```bash
   curl http://127.0.0.1:4181/providers | jq '.enabled'
   ```
2. Verify quota limit is set (not 0):
   ```bash
   curl http://127.0.0.1:4181/providers | jq '.providers[] | select(.provider=="anthropic") | .quota.limit'
   ```
3. Check provider state:
   ```bash
   curl http://127.0.0.1:4181/providers | jq '.providers[] | select(.provider=="anthropic") | .state'
   ```

### Issue: Quota doesn't reset on Monday

**Problem**: Quota counter doesn't reset

**Solutions**:
1. Check system time is UTC
2. Manually reset:
   ```bash
   curl -X POST http://127.0.0.1:4181/providers/reset
   ```
3. Wait for Monday 00:00:00 UTC

## Production Recommendations

### Starting Configuration

```bash
# Conservative start - 75% threshold
ANTHROPIC_WEEKLY_LIMIT=1000000
QUOTA_WARNING_THRESHOLD=75
CIRCUIT_BREAKER_ENABLED=true
```

### After 1 Week of Monitoring

```bash
# Check your average daily usage
curl http://127.0.0.1:4181/usage?days=7

# If average is < 100K/day, increase to 90%
QUOTA_WARNING_THRESHOLD=90
```

### After 1 Month of Monitoring

```bash
# If consistent usage pattern, optimize
# If daily average is 120K with 1M limit:
QUOTA_WARNING_THRESHOLD=95  # Use 95% for better utilization
```

## Summary

**Recommended starting point:**
```bash
ANTHROPIC_WEEKLY_LIMIT=1000000
QUOTA_WARNING_THRESHOLD=90
```

**This provides:**
- ✅ Automatic swap at 90% (900K tokens)
- ✅ ~128K tokens per day
- ✅ 10% safety buffer
- ✅ Maximum cost efficiency
- ✅ Protection against rate limits

**Monitor and adjust based on your actual usage patterns.**

For detailed analysis, see [QUOTA_SWAP_ANALYSIS.md](QUOTA_SWAP_ANALYSIS.md)
