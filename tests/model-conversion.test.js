/**
 * Model Conversion Tests for Claude Code Proxy
 * Tests intelligent model conversion when switching providers
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { ProviderHealth, ProviderState } from "../dist/provider-health.js";

describe("Model Conversion - Claude Models", () => {
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

  it("should use Anthropic with Claude model when available", () => {
    const result = providerHealth.getBestProviderAndModel("claude-sonnet-4-6");

    assert.strictEqual(result.provider, "anthropic");
    assert.strictEqual(result.model, "claude-sonnet-4-6");
    assert.strictEqual(result.wasConverted, false);
  });

  it("should convert Claude to GLM when Anthropic is unavailable", () => {
    // Make Anthropic unavailable
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("anthropic", "other");
    }

    const result = providerHealth.getBestProviderAndModel("claude-sonnet-4-6");

    assert.strictEqual(result.provider, "zai");
    assert.strictEqual(result.model, "glm-5.2");
    assert.strictEqual(result.wasConverted, true);
    assert.ok(result.conversionReason?.includes("converted"));
    assert.ok(result.conversionReason?.includes("claude-sonnet-4-6"));
    assert.ok(result.conversionReason?.includes("glm-5.2"));
  });

  it("should convert Claude Opus to GLM 5.2", () => {
    providerHealth.resetAll();
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("anthropic", "other");
    }

    const result = providerHealth.getBestProviderAndModel("claude-opus-4-5");

    assert.strictEqual(result.provider, "zai");
    assert.strictEqual(result.model, "glm-5.2");
    assert.strictEqual(result.wasConverted, true);
  });

  it("should convert Claude Haiku to GLM 4.5-Air", () => {
    providerHealth.resetAll();
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("anthropic", "other");
    }

    const result = providerHealth.getBestProviderAndModel("claude-haiku-4-5");

    assert.strictEqual(result.provider, "zai");
    assert.strictEqual(result.model, "glm-4.5-air");
    assert.strictEqual(result.wasConverted, true);
  });

  it("should convert Claude to OpenRouter when both Anthropic and Z.AI fail", () => {
    providerHealth.resetAll();

    // Make Anthropic and Z.AI unavailable
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("anthropic", "other");
      providerHealth.recordFailure("zai", "other");
    }

    const result = providerHealth.getBestProviderAndModel("claude-sonnet-4-6");

    assert.strictEqual(result.provider, "openrouter");
    assert.strictEqual(result.model, "~anthropic/claude-sonnet-latest");
    assert.strictEqual(result.wasConverted, true);
    assert.ok(result.conversionReason?.includes("unavailable"));
    assert.ok(result.conversionReason?.includes("converted"));
  });

  it("should map Claude Opus to OpenRouter format", () => {
    providerHealth.resetAll();
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("anthropic", "other");
      providerHealth.recordFailure("zai", "other");
    }

    const result = providerHealth.getBestProviderAndModel("claude-opus-4-5");

    assert.strictEqual(result.provider, "openrouter");
    assert.strictEqual(result.model, "~anthropic/claude-opus-latest");
  });

  it("should map Claude Haiku to OpenRouter format", () => {
    providerHealth.resetAll();
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("anthropic", "other");
      providerHealth.recordFailure("zai", "other");
    }

    const result = providerHealth.getBestProviderAndModel("claude-haiku-4-5");

    assert.strictEqual(result.provider, "openrouter");
    assert.strictEqual(result.model, "~anthropic/claude-haiku-latest");
  });
});

describe("Model Conversion - GLM Models", () => {
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

  it("should use Z.AI with GLM model when available", () => {
    const result = providerHealth.getBestProviderAndModel("glm-4");

    assert.strictEqual(result.provider, "zai");
    assert.strictEqual(result.model, "glm-4");
    assert.strictEqual(result.wasConverted, false);
  });

  it("should convert GLM to Claude when Z.AI is unavailable", () => {
    // Make Z.AI unavailable
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("zai", "other");
    }

    const result = providerHealth.getBestProviderAndModel("glm-4");

    assert.strictEqual(result.provider, "anthropic");
    assert.strictEqual(result.model, "claude-opus-4-8");
    assert.strictEqual(result.wasConverted, true);
    assert.ok(result.conversionReason?.includes("glm-4"));
    assert.ok(result.conversionReason?.includes("claude-opus-4-8"));
  });

  it("should convert GLM 3-Air to Claude Haiku", () => {
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("zai", "other");
    }

    const result = providerHealth.getBestProviderAndModel("glm-3-air");

    assert.strictEqual(result.provider, "anthropic");
    assert.strictEqual(result.model, "claude-haiku-4-6");
    assert.strictEqual(result.wasConverted, true);
  });

  it("should convert GLM to OpenRouter when both Z.AI and Anthropic fail", () => {
    // Make Z.AI and Anthropic unavailable
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("zai", "other");
      providerHealth.recordFailure("anthropic", "other");
    }

    const result = providerHealth.getBestProviderAndModel("glm-4");

    assert.strictEqual(result.provider, "openrouter");
    assert.strictEqual(result.model, "glm/glm-4");
    assert.strictEqual(result.wasConverted, true);
  });

  it("should map GLM 3-Air to OpenRouter format", () => {
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("zai", "other");
      providerHealth.recordFailure("anthropic", "other");
    }

    const result = providerHealth.getBestProviderAndModel("glm-3-air");

    assert.strictEqual(result.provider, "openrouter");
    assert.strictEqual(result.model, "glm/glm-3-air");
  });
});

describe("Model Conversion - Complete Fallback Chain", () => {
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

  it("should complete full fallback chain for Claude Sonnet", () => {
    // Start: Anthropic + Claude Sonnet
    let result = providerHealth.getBestProviderAndModel("claude-sonnet-4-6");
    assert.strictEqual(result.provider, "anthropic");
    assert.strictEqual(result.model, "claude-sonnet-4-6");
    assert.strictEqual(result.wasConverted, false);

    // Anthropic fails → Z.AI + GLM 5.2
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("anthropic", "other");
    }
    result = providerHealth.getBestProviderAndModel("claude-sonnet-4-6");
    assert.strictEqual(result.provider, "zai");
    assert.strictEqual(result.model, "glm-5.2");
    assert.strictEqual(result.wasConverted, true);

    // Z.AI fails → OpenRouter + OpenRouter Claude
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("zai", "other");
    }
    result = providerHealth.getBestProviderAndModel("claude-sonnet-4-6");
    assert.strictEqual(result.provider, "openrouter");
    assert.strictEqual(result.model, "~anthropic/claude-sonnet-latest");
    assert.strictEqual(result.wasConverted, true);
  });

  it("should complete full fallback chain for GLM 4", () => {
    // Start: Z.AI + GLM 4
    let result = providerHealth.getBestProviderAndModel("glm-4");
    assert.strictEqual(result.provider, "zai");
    assert.strictEqual(result.model, "glm-4");
    assert.strictEqual(result.wasConverted, false);

    // Z.AI fails → Anthropic + Claude Opus
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("zai", "other");
    }
    result = providerHealth.getBestProviderAndModel("glm-4");
    assert.strictEqual(result.provider, "anthropic");
    assert.strictEqual(result.model, "claude-opus-4-8");
    assert.strictEqual(result.wasConverted, true);

    // Anthropic fails → OpenRouter + GLM 4
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("anthropic", "other");
    }
    result = providerHealth.getBestProviderAndModel("glm-4");
    assert.strictEqual(result.provider, "openrouter");
    assert.strictEqual(result.model, "glm/glm-4");
    assert.strictEqual(result.wasConverted, true);
  });
});

describe("Model Conversion - Provider Recovery", () => {
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

  it("should revert to Anthropic when it recovers", () => {
    // Make Anthropic unavailable
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("anthropic", "other");
    }

    let result = providerHealth.getBestProviderAndModel("claude-sonnet-4-6");
    assert.strictEqual(result.provider, "zai");
    assert.strictEqual(result.model, "glm-5.2");
    assert.strictEqual(result.wasConverted, true);

    // Anthropic recovers (reset metrics to simulate recovery after cooldown)
    providerHealth.resetMetrics("anthropic");

    result = providerHealth.getBestProviderAndModel("claude-sonnet-4-6");
    assert.strictEqual(result.provider, "anthropic");
    assert.strictEqual(result.model, "claude-sonnet-4-6");
    assert.strictEqual(result.wasConverted, false);
  });

  it("should revert to Z.AI when it recovers", () => {
    // Make Z.AI unavailable
    for (let i = 0; i < 5; i++) {
      providerHealth.recordFailure("zai", "other");
    }

    let result = providerHealth.getBestProviderAndModel("glm-4");
    assert.strictEqual(result.provider, "anthropic");
    assert.strictEqual(result.model, "claude-opus-4-8");
    assert.strictEqual(result.wasConverted, true);

    // Z.AI recovers (reset metrics to simulate recovery after cooldown)
    providerHealth.resetMetrics("zai");

    result = providerHealth.getBestProviderAndModel("glm-4");
    assert.strictEqual(result.provider, "zai");
    assert.strictEqual(result.model, "glm-4");
    assert.strictEqual(result.wasConverted, false);
  });
});

describe("Model Conversion - API Key Validation", () => {
  it("should convert to Z.AI when Anthropic has no API key", () => {
    const providerHealth = new ProviderHealth(
      { baseUrl: "https://api.anthropic.com", apiKey: "" }, // No API key
      { baseUrl: "https://api.z.ai", apiKey: "zk-test-2" },
      { baseUrl: "https://openrouter.ai", apiKey: "or-test-3" }
    );

    const result = providerHealth.getBestProviderAndModel("claude-sonnet-4-6");

    assert.strictEqual(result.provider, "zai");
    assert.strictEqual(result.model, "glm-5.2");
    assert.strictEqual(result.wasConverted, true);
    assert.ok(result.conversionReason?.includes("Anthropic unavailable"));

    providerHealth.destroy();
  });

  it("should convert to Anthropic when Z.AI has no API key", () => {
    const providerHealth = new ProviderHealth(
      { baseUrl: "https://api.anthropic.com", apiKey: "sk-test-1" },
      { baseUrl: "https://api.z.ai", apiKey: "" }, // No API key
      { baseUrl: "https://openrouter.ai", apiKey: "or-test-3" }
    );

    const result = providerHealth.getBestProviderAndModel("glm-4");

    assert.strictEqual(result.provider, "anthropic");
    assert.strictEqual(result.model, "claude-opus-4-8");
    assert.strictEqual(result.wasConverted, true);
    assert.ok(result.conversionReason?.includes("Z.AI unavailable"));

    providerHealth.destroy();
  });

  it("should return null provider when no providers have API keys", () => {
    const providerHealth = new ProviderHealth(
      { baseUrl: "https://api.anthropic.com", apiKey: "" },
      { baseUrl: "https://api.z.ai", apiKey: "" },
      { baseUrl: "https://openrouter.ai", apiKey: "" }
    );

    const result = providerHealth.getBestProviderAndModel("claude-sonnet-4-6");

    assert.strictEqual(result.provider, null);
    assert.strictEqual(result.model, "claude-sonnet-4-6");
    assert.strictEqual(result.wasConverted, false);

    providerHealth.destroy();
  });
});

describe("Model Conversion - Quota Management", () => {
  it("should convert to Z.AI when Anthropic quota exceeded", () => {
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

    const result = providerHealth.getBestProviderAndModel("claude-sonnet-4-6");

    assert.strictEqual(result.provider, "zai");
    assert.strictEqual(result.model, "glm-5.2");
    assert.strictEqual(result.wasConverted, true);

    providerHealth.destroy();
  });

  it("should convert to Anthropic when Z.AI quota exceeded", () => {
    const providerHealth = new ProviderHealth(
      { baseUrl: "https://api.anthropic.com", apiKey: "sk-test-1" },
      { baseUrl: "https://api.z.ai", apiKey: "zk-test-2" },
      { baseUrl: "https://openrouter.ai", apiKey: "or-test-3" },
      {
        zaiWeeklyLimit: 50000,
        quotaWarningThreshold: 80,
        anthropicWeeklyLimit: 100000,
      }
    );

    // Exceed Z.AI quota
    providerHealth.recordTokenUsage("zai", 30000, 10000);

    const result = providerHealth.getBestProviderAndModel("glm-4");

    assert.strictEqual(result.provider, "anthropic");
    assert.strictEqual(result.model, "claude-opus-4-8");
    assert.strictEqual(result.wasConverted, true);

    providerHealth.destroy();
  });
});
