# Circuit Breaker Tests - Documentation

## Overview

The circuit breaker implementation provides automatic failover and provider health management for the Claude Code Proxy. It ensures high availability by automatically switching to backup providers when the primary provider fails.

## Test Coverage

**Total Tests**: 35 tests across 9 test suites
**Status**: ✅ All tests passing

### Test Suites

#### 1. Provider State Management (4 tests)
Tests provider health state transitions:
- **HEALTHY** → Provider is fully operational
- **DEGRADED** → Provider has consecutive errors but still available
- **UNAVAILABLE/COOLING_DOWN** → Provider has exceeded error threshold and is in cooldown
- State reset on successful requests

**Key Test**:
```javascript
// Should transition: HEALTHY → DEGRADED (3 errors) → COOLING_DOWN (5 errors)
providerHealth.recordFailure("anthropic", "other"); // x3
assert.strictEqual(providerHealth.getState("anthropic"), ProviderState.DEGRADED);

providerHealth.recordFailure("anthropic", "other"); // x2 more (total 5)
assert.strictEqual(providerHealth.getState("anthropic"), ProviderState.COOLING_DOWN);
```

#### 2. Immediate Cooldown (4 tests)
Tests immediate provider cooldown for critical errors:
- **Rate limit errors** → Immediate cooldown to prevent cascading failures
- **Context window errors** → Immediate cooldown (request will never succeed)
- Separate tracking for rate limit vs context window vs other errors

**Key Test**:
```javascript
// Single rate limit error triggers immediate cooldown
providerHealth.recordFailure("anthropic", "rate_limit");
assert.strictEqual(providerHealth.getState("anthropic"), ProviderState.COOLING_DOWN);
```

#### 3. Auto-Swap Mechanism (5 tests)
Tests automatic provider selection when primary fails:
- Claude models: Anthropic → Z.AI → OpenRouter
- GLM models: Z.AI → Anthropic → OpenRouter
- Returns null when all providers unavailable

**Key Test**:
```javascript
// Anthropic fails → auto-swap to Z.AI
for (let i = 0; i < 5; i++) {
  providerHealth.recordFailure("anthropic", "other");
}
const bestProvider = providerHealth.getBestProviderForModel("claude-sonnet-4-6");
assert.strictEqual(bestProvider, "zai"); // Auto-swapped!
```

#### 4. API Key Validation (3 tests)
Tests that providers without API keys are skipped:
- Empty API keys → Provider skipped
- Undefined API keys → Provider skipped
- All providers missing keys → Returns null

**Key Test**:
```javascript
const providerHealth = new ProviderHealth(
  { baseUrl: "...", apiKey: "" }, // No key
  { baseUrl: "...", apiKey: "zk-test-2" },
  { baseUrl: "...", apiKey: "or-test-3" }
);

const bestProvider = providerHealth.getBestProviderForModel("claude-sonnet-4-6");
assert.strictEqual(bestProvider, "zai"); // Skipped Anthropic, used Z.AI
```

#### 5. Provider Priority (4 tests)
Tests model-aware provider selection:
- **Claude models**: Anthropic (priority 1) → Z.AI (priority 2) → OpenRouter (priority 3)
- **GLM models**: Z.AI (priority 1) → Anthropic (priority 2) → OpenRouter (priority 3)
- **Unknown models**: Use default priority (Anthropic first)

**Key Test**:
```javascript
// Claude models prefer Anthropic
assert.strictEqual(providerHealth.getBestProviderForModel("claude-sonnet-4-6"), "anthropic");

// GLM models prefer Z.AI (native support)
assert.strictEqual(providerHealth.getBestProviderForModel("glm-4"), "zai");
```

#### 6. Metrics Tracking (5 tests)
Tests provider metrics and statistics:
- Total requests, successful requests, failed requests
- Consecutive errors counter
- Average latency (exponential moving average)
- Rate limit hits, context window errors
- Metrics reset on provider recovery

**Key Test**:
```javascript
providerHealth.recordSuccess("anthropic", 100);
providerHealth.recordSuccess("anthropic", 200);

// EMA: 100 * 0.9 + 200 * 0.1 = 110ms
assert.strictEqual(metrics.averageLatency, 110);
```

#### 7. Fallback Chain Tests (3 tests)
Tests complete fallback scenarios:
- Anthropic fails → Z.AI → OpenRouter (for Claude models)
- Z.AI fails → Anthropic → OpenRouter (for GLM models)
- DEGRADED provider recovers and becomes preferred again

**Key Test**:
```javascript
// Full fallback chain for Claude model
provider = providerHealth.getBestProviderForModel("claude-sonnet-4-6");
assert.strictEqual(provider, "anthropic"); // Start

// Make Anthropic fail → switch to Z.AI
// Make Z.AI fail → switch to OpenRouter
assert.strictEqual(provider, "openrouter"); // End of chain
```

#### 8. Weekly Quota Tracking (3 tests)
Tests Anthropic weekly quota management:
- Token usage tracking (input + output tokens)
- QUOTA_EXCEEDED state when threshold reached (default 80%)
- Provider skipped when quota exceeded

**Key Test**:
```javascript
const providerHealth = new ProviderHealth(
  { ... },
  { ... },
  { ... },
  { anthropicWeeklyLimit: 100000, quotaWarningThreshold: 80 }
);

// Use 85% of quota
providerHealth.recordTokenUsage("anthropic", 50000, 35000);

assert.strictEqual(providerHealth.getState("anthropic"), ProviderState.QUOTA_EXCEEDED);
assert.strictEqual(providerHealth.getBestProviderForModel("claude-sonnet-4-6"), "zai"); // Skipped
```

#### 9. Provider Availability (4 tests)
Tests provider availability checks:
- HEALTHY providers with API keys → Available
- DEGRADED providers → Available (with warnings)
- COOLING_DOWN providers → Not available
- Providers without API keys → Not available

**Key Test**:
```javascript
assert.strictEqual(providerHealth.isAvailable("anthropic"), true); // Healthy

providerHealth.recordFailure("anthropic", "rate_limit");
assert.strictEqual(providerHealth.isAvailable("anthropic"), false); // Cooling down
```

## Circuit Breaker Configuration

```javascript
const providerHealth = new ProviderHealth(
  { baseUrl: "https://api.anthropic.com", apiKey: "sk-xxx" },
  { baseUrl: "https://api.z.ai", apiKey: "zk-xxx" },
  { baseUrl: "https://openrouter.ai", apiKey: "or-xxx" },
  {
    cooldownMs: 60000,              // Cooldown period (default: 60s)
    degradedThreshold: 3,           // Errors before DEGRADED state
    unavailableThreshold: 5,        // Errors before COOLING_DOWN
    healthCheckInterval: 30000,     // Health check frequency
    anthropicWeeklyLimit: 1000000,  // Weekly token limit (0 = no limit)
    quotaWarningThreshold: 80       // Quota warning % (default: 80%)
  }
);
```

## Error Handling

### Error Types

1. **rate_limit** → Immediate cooldown
   - Prevents cascading failures when provider rate limits
   - Triggers health check after cooldown

2. **context_window** → Immediate cooldown
   - Request will never succeed (exceeds provider's limits)
   - Indicates client-side configuration issue

3. **other** → Threshold-based
   - Requires consecutive errors before cooldown
   - Network errors, validation errors, etc.

### State Transitions

```
HEALTHY
  │ (3 consecutive "other" errors)
  ↓
DEGRADED (still available)
  │ (2 more consecutive "other" errors OR rate_limit OR context_window)
  ↓
COOLING_DOWN (not available)
  │ (after cooldown period expires)
  ↓
HEALTHY
```

## Auto-Swap Logic

### Claude Models (claude-*)
```javascript
getBestProviderForModel("claude-sonnet-4-6")
// Priority: Anthropic (1) → Z.AI (2) → OpenRouter (3)
```

### GLM Models (glm-*)
```javascript
getBestProviderForModel("glm-4")
// Priority: Z.AI (1) → Anthropic (2) → OpenRouter (3)
```

### Unknown Models
```javascript
getBestProviderForModel("unknown-model")
// Priority: Anthropic (1) → Z.AI (2) → OpenRouter (3)
```

## Usage in Production

The circuit breaker is automatically enabled in the proxy:

```javascript
// In src/index.ts
const cbEnabled = this.config.circuitBreaker?.enabled !== false;

// Get best provider for model
let selectedProvider = cbEnabled
  ? this.providerHealth.getBestProviderForModel(model)
  : 'anthropic';

// Record success/failure
if (response.status < 400) {
  this.providerHealth.recordSuccess(provider, latency);
} else {
  const errorType = isRateLimitError(response) ? "rate_limit" :
                   isContextWindowError(response) ? "context_window" : "other";
  this.providerHealth.recordFailure(provider, errorType);
}
```

## Running Tests

```bash
# Run all tests
npm test

# Run only circuit-breaker tests
node --test tests/circuit-breaker.test.js

# Run with verbose output
node --test --verbose tests/circuit-breaker.test.js
```

## Test Results

```
✔ All 35 tests passing

Test Suites:
- Provider State Management: 4/4 ✅
- Immediate Cooldown: 4/4 ✅
- Auto-Swap Mechanism: 5/5 ✅
- API Key Validation: 3/3 ✅
- Provider Priority: 4/4 ✅
- Metrics Tracking: 5/5 ✅
- Fallback Chain: 3/3 ✅
- Weekly Quota: 3/3 ✅
- Provider Availability: 4/4 ✅
```

## Benefits

1. **High Availability**: Automatic failover to backup providers
2. **Model Awareness**: Optimal provider selection per model family
3. **Cascading Prevention**: Immediate cooldown on rate limits
4. **Auto-Recovery**: Providers recover automatically after cooldown
5. **Quota Management**: Weekly Anthropic quota tracking with auto-swap
6. **Comprehensive Metrics**: Track success rates, latency, errors
7. **API Key Safety**: Skips providers without valid credentials

## Next Steps

- Add health check callback implementation
- Add real-time provider status API endpoint
- Add metrics dashboard/visualization
- Add alerting for quota thresholds
- Add provider-specific retry policies
