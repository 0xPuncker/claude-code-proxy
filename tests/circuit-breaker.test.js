/**
 * Circuit Breaker Tests for Claude Code Proxy
 * Tests auto-swap functionality when providers fail
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { ProviderHealth, ProviderState } from "../dist/provider-health.js";

describe("Circuit Breaker - Provider State Management", () => {
  let providerHealth;

  before(() => {
    providerHealth = new ProviderHealth(
      { baseUrl: "https://api.anthropic.com", apiKey: "sk-test-1" },
      { baseUrl: "https://api.z.ai", apiKey: "zk-test-2" },
      { baseUrl: "https://openrouter.ai", apiKey: "or-test-3" },
      {
        cooldownMs: 1000,
        degradedThreshold: 3,
        unavailableThreshold: 5,
        healthCheckInterval: 500,
      }
    );
  });

  after(() => {
    providerHealth.destroy();
  });

  it("should initialize all providers as HEALTHY", () => {
    assert.strictEqual(providerHealth.getState("anthropic"), ProviderState.HEALTHY);
    assert.strictEqual(providerHealth.getState("zai"), ProviderState.HEALTHY);
    assert.strictEqual(providerHealth.getState("openrouter"), ProviderState.HEALTHY);
  });

  it("should mark provider as DEGRADED after threshold consecutive errors", () => {
    // Record 3 errors (degraded threshold)
    for (let i = 0; i < 3; i++) {
      providerHealth.recordFailure("anthropic", "other");
    }

    assert.strictEqual(providerHealth.getState("anthropic"), ProviderState.DEGRADED);
  });

  it("should mark provider as UNAVAILABLE after consecutive errors exceed unavailable threshold", () => {
    providerHealth.resetMetrics("anthropic");

    // Record 5 errors (unavailable threshold)
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("anthropic", "other");
    }

    // Should be in COOLING_DOWN after hitting unavailable threshold
    assert.strictEqual(providerHealth.getState("anthropic"), ProviderState.COOLING_DOWN);
  });

  it("should reset to HEALTHY after successful request", () => {
    // First, make it degraded
    for (let i = 0; i < 3; i++) {
      providerHealth.recordFailure("zai", "other");
    }
    assert.strictEqual(providerHealth.getState("zai"), ProviderState.DEGRADED);

    // Record success - should reset to healthy
    providerHealth.recordSuccess("zai", 100);
    assert.strictEqual(providerHealth.getState("zai"), ProviderState.HEALTHY);
  });
});

describe("Circuit Breaker - Immediate Cooldown", () => {
  let providerHealth;

  before(() => {
    providerHealth = new ProviderHealth(
      { baseUrl: "https://api.anthropic.com", apiKey: "sk-test-1" },
      { baseUrl: "https://api.z.ai", apiKey: "zk-test-2" },
      { baseUrl: "https://openrouter.ai", apiKey: "or-test-3" },
      {
        cooldownMs: 5000,
        degradedThreshold: 3,
        unavailableThreshold: 5,
      }
    );
  });

  after(() => {
    providerHealth.destroy();
  });

  it("should enter immediate cooldown on rate limit errors", () => {
    providerHealth.recordFailure("anthropic", "rate_limit");
    assert.strictEqual(providerHealth.getState("anthropic"), ProviderState.COOLING_DOWN);
  });

  it("should enter immediate cooldown on context window errors", () => {
    providerHealth.recordFailure("zai", "context_window");
    assert.strictEqual(providerHealth.getState("zai"), ProviderState.COOLING_DOWN);
  });

  it("should track rate limit hits separately", () => {
    providerHealth.resetMetrics("anthropic");
    providerHealth.recordFailure("anthropic", "rate_limit");
    providerHealth.recordFailure("anthropic", "other");
    providerHealth.recordFailure("anthropic", "rate_limit");

    const status = providerHealth.getAllStatus();
    const anthropicStatus = status.find((s) => s.provider === "anthropic");
    assert.strictEqual(anthropicStatus.metrics.rateLimitHits, 2);
  });

  it("should track context window errors separately", () => {
    providerHealth.resetMetrics("zai");
    providerHealth.recordFailure("zai", "context_window");
    providerHealth.recordFailure("zai", "other");
    providerHealth.recordFailure("zai", "context_window");

    const status = providerHealth.getAllStatus();
    const zaiStatus = status.find((s) => s.provider === "zai");
    assert.strictEqual(zaiStatus.metrics.contextWindowErrors, 2);
  });
});

describe("Circuit Breaker - Auto-Swap Mechanism", () => {
  let providerHealth;

  before(() => {
    providerHealth = new ProviderHealth(
      { baseUrl: "https://api.anthropic.com", apiKey: "sk-test-1" },
      { baseUrl: "https://api.z.ai", apiKey: "zk-test-2" },
      { baseUrl: "https://openrouter.ai", apiKey: "or-test-3" },
      {
        cooldownMs: 10000,
        degradedThreshold: 3,
        unavailableThreshold: 5,
      }
    );
  });

  after(() => {
    providerHealth.destroy();
  });

  it("should auto-swap to Z.AI when Anthropic fails for Claude models", () => {
    // Make Anthropic unavailable
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("anthropic", "other");
    }

    const bestProvider = providerHealth.getBestProviderForModel("claude-sonnet-4-6");
    assert.strictEqual(bestProvider, "zai");
  });

  it("should auto-swap to OpenRouter when both Anthropic and Z.AI fail", () => {
    // Make Anthropic unavailable
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("anthropic", "other");
    }

    // Make Z.AI unavailable
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("zai", "other");
    }

    const bestProvider = providerHealth.getBestProviderForModel("claude-sonnet-4-6");
    assert.strictEqual(bestProvider, "openrouter");
  });

  it("should return null when all providers are unavailable", () => {
    // Make all providers unavailable
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("anthropic", "other");
      providerHealth.recordFailure("zai", "other");
      providerHealth.recordFailure("openrouter", "other");
    }

    const bestProvider = providerHealth.getBestProviderForModel("claude-sonnet-4-6");
    assert.strictEqual(bestProvider, null);
  });

  it("should prefer Anthropic for GLM models when Z.AI is unavailable", () => {
    providerHealth.resetAll();

    // Make Z.AI unavailable
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("zai", "other");
    }

    const bestProvider = providerHealth.getBestProviderForModel("glm-4");
    assert.strictEqual(bestProvider, "anthropic");
  });

  it("should prefer Z.AI for GLM models when available", () => {
    providerHealth.resetAll();

    const bestProvider = providerHealth.getBestProviderForModel("glm-4");
    assert.strictEqual(bestProvider, "zai");
  });
});

describe("Circuit Breaker - API Key Validation", () => {
  it("should not select providers without API keys", () => {
    const providerHealth = new ProviderHealth(
      { baseUrl: "https://api.anthropic.com", apiKey: "" }, // No API key
      { baseUrl: "https://api.z.ai", apiKey: "zk-test-2" },
      { baseUrl: "https://openrouter.ai", apiKey: "or-test-3" }
    );

    const bestProvider = providerHealth.getBestProviderForModel("claude-sonnet-4-6");
    assert.strictEqual(bestProvider, "zai"); // Should skip Anthropic

    providerHealth.destroy();
  });

  it("should not select providers with undefined API keys", () => {
    const providerHealth = new ProviderHealth(
      { baseUrl: "https://api.anthropic.com", apiKey: "sk-test-1" },
      { baseUrl: "https://api.z.ai", apiKey: undefined }, // No API key
      { baseUrl: "https://openrouter.ai", apiKey: "or-test-3" }
    );

    const bestProvider = providerHealth.getBestProviderForModel("glm-4");
    assert.strictEqual(bestProvider, "anthropic"); // Should skip Z.AI

    providerHealth.destroy();
  });

  it("should return null when no providers have API keys", () => {
    const providerHealth = new ProviderHealth(
      { baseUrl: "https://api.anthropic.com", apiKey: "" },
      { baseUrl: "https://api.z.ai", apiKey: "" },
      { baseUrl: "https://openrouter.ai", apiKey: "" }
    );

    const bestProvider = providerHealth.getBestProviderForModel("claude-sonnet-4-6");
    assert.strictEqual(bestProvider, null);

    providerHealth.destroy();
  });
});

describe("Circuit Breaker - Provider Priority", () => {
  let providerHealth;

  before(() => {
    providerHealth = new ProviderHealth(
      { baseUrl: "https://api.anthropic.com", apiKey: "sk-test-1" },
      { baseUrl: "https://api.z.ai", apiKey: "zk-test-2" },
      { baseUrl: "https://openrouter.ai", apiKey: "or-test-3" }
    );
  });

  after(() => {
    providerHealth.destroy();
  });

  it("should prioritize Anthropic (1) over Z.AI (2) and OpenRouter (3) for Claude models", () => {
    const bestProvider = providerHealth.getBestProviderForModel("claude-sonnet-4-6");
    assert.strictEqual(bestProvider, "anthropic");
  });

  it("should prioritize Z.AI (1) over Anthropic (2) and OpenRouter (3) for GLM models", () => {
    const bestProvider = providerHealth.getBestProviderForModel("glm-4");
    assert.strictEqual(bestProvider, "zai");
  });

  it("should use default priority for unknown models", () => {
    const bestProvider = providerHealth.getBestProviderForModel("unknown-model");
    assert.strictEqual(bestProvider, "anthropic");
  });

  it("should use default priority when no model specified", () => {
    const bestProvider = providerHealth.getBestProviderForModel(undefined);
    assert.strictEqual(bestProvider, "anthropic");
  });
});

describe("Circuit Breaker - Metrics Tracking", () => {
  let providerHealth;

  before(() => {
    providerHealth = new ProviderHealth(
      { baseUrl: "https://api.anthropic.com", apiKey: "sk-test-1" },
      { baseUrl: "https://api.z.ai", apiKey: "zk-test-2" },
      { baseUrl: "https://openrouter.ai", apiKey: "or-test-3" }
    );
  });

  after(() => {
    providerHealth.destroy();
  });

  it("should track total requests", () => {
    providerHealth.recordSuccess("anthropic", 100);
    providerHealth.recordFailure("anthropic", "other");
    providerHealth.recordSuccess("anthropic", 150);

    const status = providerHealth.getAllStatus();
    const anthropicStatus = status.find((s) => s.provider === "anthropic");
    assert.strictEqual(anthropicStatus.metrics.totalRequests, 3);
  });

  it("should track successful and failed requests separately", () => {
    providerHealth.resetMetrics("anthropic");

    providerHealth.recordSuccess("anthropic", 100);
    providerHealth.recordSuccess("anthropic", 150);
    providerHealth.recordFailure("anthropic", "other");
    providerHealth.recordFailure("anthropic", "rate_limit");

    const status = providerHealth.getAllStatus();
    const anthropicStatus = status.find((s) => s.provider === "anthropic");
    assert.strictEqual(anthropicStatus.metrics.successfulRequests, 2);
    assert.strictEqual(anthropicStatus.metrics.failedRequests, 2);
  });

  it("should track consecutive errors", () => {
    providerHealth.resetMetrics("zai");

    providerHealth.recordFailure("zai", "other");
    providerHealth.recordFailure("zai", "other");
    providerHealth.recordFailure("zai", "other");

    const status = providerHealth.getAllStatus();
    const zaiStatus = status.find((s) => s.provider === "zai");
    assert.strictEqual(zaiStatus.metrics.consecutiveErrors, 3);
  });

  it("should reset consecutive errors on success", () => {
    providerHealth.resetMetrics("zai");

    providerHealth.recordFailure("zai", "other");
    providerHealth.recordFailure("zai", "other");
    providerHealth.recordSuccess("zai", 100);

    const status = providerHealth.getAllStatus();
    const zaiStatus = status.find((s) => s.provider === "zai");
    assert.strictEqual(zaiStatus.metrics.consecutiveErrors, 0);
  });

  it("should track average latency with exponential moving average", () => {
    providerHealth.resetMetrics("anthropic");

    providerHealth.recordSuccess("anthropic", 100);
    let status = providerHealth.getAllStatus();
    let anthropicStatus = status.find((s) => s.provider === "anthropic");
    assert.strictEqual(anthropicStatus.metrics.averageLatency, 100);

    providerHealth.recordSuccess("anthropic", 200);
    status = providerHealth.getAllStatus();
    anthropicStatus = status.find((s) => s.provider === "anthropic");
    // EMA: 100 * 0.9 + 200 * 0.1 = 90 + 20 = 110
    assert.strictEqual(anthropicStatus.metrics.averageLatency, 110);
  });
});

describe("Circuit Breaker - Fallback Chain Tests", () => {
  let providerHealth;

  beforeEach(() => {
    providerHealth = new ProviderHealth(
      { baseUrl: "https://api.anthropic.com", apiKey: "sk-test-1" },
      { baseUrl: "https://api.z.ai", apiKey: "zk-test-2" },
      { baseUrl: "https://openrouter.ai", apiKey: "or-test-3" },
      {
        cooldownMs: 10000,
        degradedThreshold: 3,
        unavailableThreshold: 5,
      }
    );
  });

  afterEach(() => {
    providerHealth.destroy();
  });

  it("should fallback Anthropic → Z.AI → OpenRouter for Claude models", () => {
    // Start with Anthropic
    let provider = providerHealth.getBestProviderForModel("claude-sonnet-4-6");
    assert.strictEqual(provider, "anthropic");

    // Make Anthropic fail - should switch to Z.AI
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("anthropic", "other");
    }
    provider = providerHealth.getBestProviderForModel("claude-sonnet-4-6");
    assert.strictEqual(provider, "zai");

    // Make Z.AI fail - should switch to OpenRouter
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("zai", "other");
    }
    provider = providerHealth.getBestProviderForModel("claude-sonnet-4-6");
    assert.strictEqual(provider, "openrouter");
  });

  it("should fallback Z.AI → Anthropic → OpenRouter for GLM models", () => {
    // Start with Z.AI
    let provider = providerHealth.getBestProviderForModel("glm-4");
    assert.strictEqual(provider, "zai");

    // Make Z.AI fail - should switch to Anthropic
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("zai", "other");
    }
    provider = providerHealth.getBestProviderForModel("glm-4");
    assert.strictEqual(provider, "anthropic");

    // Make Anthropic fail - should switch to OpenRouter
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("anthropic", "other");
    }
    provider = providerHealth.getBestProviderForModel("glm-4");
    assert.strictEqual(provider, "openrouter");
  });

  it("should recover DEGRADED provider and prefer it again", () => {
    // Make Anthropic DEGRADED (3 errors = degraded threshold)
    for (let i = 0; i < 3; i++) {
      providerHealth.recordFailure("anthropic", "other");
    }

    // Anthropic should still be available in DEGRADED state
    assert.strictEqual(providerHealth.isAvailable("anthropic"), true);
    assert.strictEqual(providerHealth.getState("anthropic"), ProviderState.DEGRADED);

    // Record success - should reset to HEALTHY
    providerHealth.recordSuccess("anthropic", 100);
    assert.strictEqual(providerHealth.getState("anthropic"), ProviderState.HEALTHY);

    // Should now prefer Anthropic again for Claude models
    const provider = providerHealth.getBestProviderForModel("claude-sonnet-4-6");
    assert.strictEqual(provider, "anthropic");
  });
});

describe("Circuit Breaker - Weekly Quota Tracking", () => {
  it("should track token usage for Anthropic", () => {
    const providerHealth = new ProviderHealth(
      { baseUrl: "https://api.anthropic.com", apiKey: "sk-test-1" },
      { baseUrl: "https://api.z.ai", apiKey: "zk-test-2" },
      { baseUrl: "https://openrouter.ai", apiKey: "or-test-3" },
      {
        anthropicWeeklyLimit: 100000,
        quotaWarningThreshold: 80,
      }
    );

    providerHealth.recordTokenUsage("anthropic", 10000, 5000);
    providerHealth.recordTokenUsage("anthropic", 20000, 10000);

    const quota = providerHealth.getQuotaInfo("anthropic");
    assert.strictEqual(quota.used, 45000); // 10000 + 5000 + 20000 + 10000
    assert.strictEqual(quota.remaining, 55000);
    assert.strictEqual(quota.percentageUsed, 45);

    providerHealth.destroy();
  });

  it("should mark provider as QUOTA_EXCEEDED when threshold reached", () => {
    const providerHealth = new ProviderHealth(
      { baseUrl: "https://api.anthropic.com", apiKey: "sk-test-1" },
      { baseUrl: "https://api.z.ai", apiKey: "zk-test-2" },
      { baseUrl: "https://openrouter.ai", apiKey: "or-test-3" },
      {
        anthropicWeeklyLimit: 100000,
        quotaWarningThreshold: 80,
      }
    );

    // Use 85000 tokens (85%)
    providerHealth.recordTokenUsage("anthropic", 50000, 35000);

    assert.strictEqual(providerHealth.getState("anthropic"), ProviderState.QUOTA_EXCEEDED);

    providerHealth.destroy();
  });

  it("should not select provider with exceeded quota", () => {
    const providerHealth = new ProviderHealth(
      { baseUrl: "https://api.anthropic.com", apiKey: "sk-test-1" },
      { baseUrl: "https://api.z.ai", apiKey: "zk-test-2" },
      { baseUrl: "https://openrouter.ai", apiKey: "or-test-3" },
      {
        anthropicWeeklyLimit: 100000,
        quotaWarningThreshold: 80,
      }
    );

    // Exceed Anthropic quota
    providerHealth.recordTokenUsage("anthropic", 50000, 35000);

    const bestProvider = providerHealth.getBestProviderForModel("claude-sonnet-4-6");
    assert.strictEqual(bestProvider, "zai"); // Should skip Anthropic

    providerHealth.destroy();
  });
});

describe("Circuit Breaker - Provider Availability", () => {
  let providerHealth;

  before(() => {
    providerHealth = new ProviderHealth(
      { baseUrl: "https://api.anthropic.com", apiKey: "sk-test-1" },
      { baseUrl: "https://api.z.ai", apiKey: "zk-test-2" },
      { baseUrl: "https://openrouter.ai", apiKey: "or-test-3" }
    );
  });

  after(() => {
    providerHealth.destroy();
  });

  it("should return true for HEALTHY providers with API keys", () => {
    assert.strictEqual(providerHealth.isAvailable("anthropic"), true);
    assert.strictEqual(providerHealth.isAvailable("zai"), true);
    assert.strictEqual(providerHealth.isAvailable("openrouter"), true);
  });

  it("should return false for COOLING_DOWN providers", () => {
    providerHealth.recordFailure("anthropic", "rate_limit");
    assert.strictEqual(providerHealth.isAvailable("anthropic"), false);
  });

  it("should return true for DEGRADED providers", () => {
    providerHealth.resetMetrics("anthropic");

    for (let i = 0; i < 3; i++) {
      providerHealth.recordFailure("anthropic", "other");
    }

    assert.strictEqual(providerHealth.getState("anthropic"), ProviderState.DEGRADED);
    assert.strictEqual(providerHealth.isAvailable("anthropic"), true);
  });

  it("should return false for providers without API keys", () => {
    const noKeyProvider = new ProviderHealth(
      { baseUrl: "https://api.anthropic.com", apiKey: "" },
      { baseUrl: "https://api.z.ai", apiKey: "zk-test-2" },
      { baseUrl: "https://openrouter.ai", apiKey: "or-test-3" }
    );

    assert.strictEqual(noKeyProvider.isAvailable("anthropic"), false);
    noKeyProvider.destroy();
  });
});
