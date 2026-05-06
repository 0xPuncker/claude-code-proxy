/**
 * Provider health states
 */
export enum ProviderState {
  HEALTHY = "healthy",
  DEGRADED = "degraded",
  UNAVAILABLE = "unavailable",
  COOLING_DOWN = "cooling_down",
  QUOTA_EXCEEDED = "quota_exceeded",
}

/**
 * Provider health metrics
 */
interface ProviderMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  rateLimitHits: number;
  contextWindowErrors: number;
  lastSuccessTime: number;
  lastFailureTime: number;
  consecutiveErrors: number;
  averageLatency: number;
}

/**
 * Weekly quota tracking
 */
interface WeeklyQuota {
  limit: number; // weekly token limit
  warningThreshold: number; // percentage (0-100) to trigger warning
  usedTokens: number; // tokens used this week
  weekStart: number; // timestamp of week start
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  name: "anthropic" | "zai" | "openrouter";
  baseUrl: string;
  apiKey: string;
  cooldownMs: number;
  degradedThreshold: number; // consecutive errors to mark as degraded
  unavailableThreshold: number; // consecutive errors to mark as unavailable
  healthCheckInterval: number; // ms between health checks when unhealthy
  weeklyQuota?: WeeklyQuota; // optional weekly quota tracking
  priority: number; // lower = higher priority (Anthropic = 1, Z.AI = 2, OpenRouter = 3)
}

/**
 * Provider health status
 */
export interface ProviderHealthStatus {
  provider: "anthropic" | "zai" | "openrouter";
  state: ProviderState;
  available: boolean;
  metrics: ProviderMetrics;
  readyAt?: number; // timestamp when provider will be available again
  quota?: {
    limit: number;
    used: number;
    remaining: number;
    percentageUsed: number;
    weekStart: string;
  };
}

/**
 * Tracks health and availability of API providers
 * Implements circuit breaker pattern with automatic recovery
 */
export class ProviderHealth {
  private providers: Map<"anthropic" | "zai" | "openrouter", ProviderConfig>;
  private metrics: Map<"anthropic" | "zai" | "openrouter", ProviderMetrics>;
  private state: Map<"anthropic" | "zai" | "openrouter", ProviderState>;
  private cooldownUntil: Map<"anthropic" | "zai" | "openrouter", number>;
  private healthCheckTimers: Map<"anthropic" | "zai" | "openrouter", NodeJS.Timeout>;
  private healthCheckCallback?: (
    provider: "anthropic" | "zai" | "openrouter"
  ) => Promise<boolean>;
  private weeklyQuota: Map<"anthropic" | "zai" | "openrouter", WeeklyQuota>;
  private currentWeekStart: number;

  constructor(
    anthropicConfig: { baseUrl: string; apiKey: string },
    zaiConfig: { baseUrl: string; apiKey: string },
    openrouterConfig: { baseUrl: string; apiKey: string },
    options?: {
      cooldownMs?: number;
      degradedThreshold?: number;
      unavailableThreshold?: number;
      healthCheckInterval?: number;
      anthropicWeeklyLimit?: number; // weekly token limit for Anthropic
      zaiWeeklyLimit?: number; // weekly token limit for Z.AI
      quotaWarningThreshold?: number; // percentage (default: 80)
    }
  ) {
    const cooldownMs = options?.cooldownMs || 60000; // 1 minute default
    const degradedThreshold = options?.degradedThreshold || 3;
    const unavailableThreshold = options?.unavailableThreshold || 5;
    const healthCheckInterval = options?.healthCheckInterval || 30000; // 30 seconds
    const anthropicWeeklyLimit = options?.anthropicWeeklyLimit || 0; // 0 = no limit
    const zaiWeeklyLimit = options?.zaiWeeklyLimit || 0; // 0 = no limit
    const quotaWarningThreshold = options?.quotaWarningThreshold || 80;

    // Calculate current week start (Monday 00:00:00 UTC)
    this.currentWeekStart = this.getWeekStart();

    // Create Anthropic quota if limit is set
    const anthropicQuota =
      anthropicWeeklyLimit > 0
        ? {
            limit: anthropicWeeklyLimit,
            warningThreshold: quotaWarningThreshold,
            usedTokens: 0,
            weekStart: this.currentWeekStart,
          }
        : undefined;

    // Create Z.AI quota if limit is set
    const zaiQuota =
      zaiWeeklyLimit > 0
        ? {
            limit: zaiWeeklyLimit,
            warningThreshold: quotaWarningThreshold,
            usedTokens: 0,
            weekStart: this.currentWeekStart,
          }
        : undefined;

    // Initialize weekly quotas for all providers
    this.weeklyQuota = new Map([
      [
        "anthropic",
        anthropicQuota || {
          limit: 0,
          warningThreshold: 100,
          usedTokens: 0,
          weekStart: this.currentWeekStart,
        },
      ],
      [
        "zai",
        zaiQuota || {
          limit: 0,
          warningThreshold: 100,
          usedTokens: 0,
          weekStart: this.currentWeekStart,
        },
      ],
      [
        "openrouter",
        {
          limit: 0,
          warningThreshold: 100,
          usedTokens: 0,
          weekStart: this.currentWeekStart,
        },
      ],
    ]);

    // Initialize provider configurations with priority order
    this.providers = new Map([
      [
        "anthropic",
        {
          name: "anthropic",
          baseUrl: anthropicConfig.baseUrl,
          apiKey: anthropicConfig.apiKey,
          cooldownMs,
          degradedThreshold,
          unavailableThreshold,
          healthCheckInterval,
          weeklyQuota: this.weeklyQuota.get("anthropic"),
          priority: 1, // Anthropic API is primary (highest priority)
        },
      ],
      [
        "zai",
        {
          name: "zai",
          baseUrl: zaiConfig.baseUrl,
          apiKey: zaiConfig.apiKey,
          cooldownMs,
          degradedThreshold,
          unavailableThreshold,
          healthCheckInterval,
          weeklyQuota: this.weeklyQuota.get("zai"),
          priority: 2, // Z.AI is secondary
        },
      ],
      [
        "openrouter",
        {
          name: "openrouter",
          baseUrl: openrouterConfig.baseUrl,
          apiKey: openrouterConfig.apiKey,
          cooldownMs,
          degradedThreshold,
          unavailableThreshold,
          healthCheckInterval,
          weeklyQuota: this.weeklyQuota.get("openrouter"),
          priority: 3, // OpenRouter is fallback (lowest priority)
        },
      ],
    ]);

    // Initialize metrics for all providers
    this.metrics = new Map([
      ["anthropic", this.createEmptyMetrics()],
      ["zai", this.createEmptyMetrics()],
      ["openrouter", this.createEmptyMetrics()],
    ]);

    // Initialize states for all providers
    this.state = new Map([
      ["anthropic", ProviderState.HEALTHY],
      ["zai", ProviderState.HEALTHY],
      ["openrouter", ProviderState.HEALTHY],
    ]);

    // Initialize cooldown timers for all providers
    this.cooldownUntil = new Map([
      ["anthropic", 0],
      ["zai", 0],
      ["openrouter", 0],
    ]);

    this.healthCheckTimers = new Map();
  }

  /**
   * Get the start of the current week (Monday 00:00:00 UTC)
   */
  private getWeekStart(): number {
    const now = new Date();
    const day = now.getUTCDay();
    const diff = now.getUTCDate() - day + (day === 0 ? -6 : 1); // Adjust so Monday is 0
    const monday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), diff)
    );
    return monday.getTime();
  }

  /**
   * Check if the week has rolled over and reset quotas if needed
   */
  private checkWeekRollover(): void {
    const newWeekStart = this.getWeekStart();
    if (newWeekStart > this.currentWeekStart) {
      this.currentWeekStart = newWeekStart;
      (["zai", "anthropic"] as const).forEach((provider) => {
        const quota = this.weeklyQuota.get(provider);
        if (quota) {
          quota.weekStart = newWeekStart;
          quota.usedTokens = 0;
        }
      });
    }
  }

  private createEmptyMetrics(): ProviderMetrics {
    return {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      rateLimitHits: 0,
      contextWindowErrors: 0,
      lastSuccessTime: 0,
      lastFailureTime: 0,
      consecutiveErrors: 0,
      averageLatency: 0,
    };
  }

  /**
   * Set the health check callback function
   */
  setHealthCheckCallback(
    callback: (provider: "anthropic" | "zai" | "openrouter") => Promise<boolean>
  ): void {
    this.healthCheckCallback = callback;
  }

  /**
   * Get the current state of a provider
   */
  getState(provider: "anthropic" | "zai" | "openrouter"): ProviderState {
    // Check if cooldown has expired
    const cooldownEnd = this.cooldownUntil.get(provider) || 0;
    if (cooldownEnd > Date.now()) {
      return ProviderState.COOLING_DOWN;
    }

    // Check quota status
    this.checkWeekRollover();
    const quota = this.weeklyQuota.get(provider);
    if (quota && quota.limit > 0) {
      const usagePercent = (quota.usedTokens / quota.limit) * 100;
      if (usagePercent >= quota.warningThreshold) {
        return ProviderState.QUOTA_EXCEEDED;
      }
    }

    // Return stored state or reset from cooldown
    const storedState = this.state.get(provider);
    if (
      storedState === ProviderState.COOLING_DOWN &&
      cooldownEnd <= Date.now()
    ) {
      this.state.set(provider, ProviderState.HEALTHY);
      this.clearHealthCheckTimer(provider);
      return ProviderState.HEALTHY;
    }

    return storedState || ProviderState.HEALTHY;
  }

  /**
   * Check if a provider has a valid API key configured
   */
  hasValidApiKey(provider: "anthropic" | "zai" | "openrouter"): boolean {
    const config = this.providers.get(provider);
    return !!config && !!config.apiKey && config.apiKey.length > 0;
  }

  /**
   * Check if a provider is available for requests
   * Now also checks if the provider has a valid API key
   */
  isAvailable(provider: "anthropic" | "zai" | "openrouter"): boolean {
    const state = this.getState(provider);
    const hasKey = this.hasValidApiKey(provider);
    return (state === ProviderState.HEALTHY || state === ProviderState.DEGRADED) && hasKey;
  }

  /**
   * Get the best available provider based on priority and health
   * Priority: Anthropic (1) > Z.AI (2) > OpenRouter (3)
   * Only returns providers that have valid API keys and are healthy/degraded
   */
  getBestProvider(): "anthropic" | "zai" | "openrouter" | null {
    this.checkWeekRollover();

    const providers = ["anthropic", "zai", "openrouter"] as const;
    const available = providers
      .filter((p) => this.isAvailable(p)) // Now checks both health AND API key
      .sort((a, b) => {
        const configA = this.providers.get(a)!;
        const configB = this.providers.get(b)!;
        return configA.priority - configB.priority; // Lower priority number = preferred
      });

    return available[0] || null;
  }

  /**
   * Get the best provider for a specific model family
   * - Claude models (claude-*) → Anthropic (1) → Z.AI (2) → OpenRouter (3)
   * - GLM models (glm-*) → Z.AI (1) → Anthropic (2) → OpenRouter (3)
   * - Other models → Use default priority order
   */
  getBestProviderForModel(model: string | undefined): "anthropic" | "zai" | "openrouter" | null {
    this.checkWeekRollover();

    // Determine provider priority based on model family
    let providerOrder: ("anthropic" | "zai" | "openrouter")[] = ["anthropic", "zai", "openrouter"];

    if (model) {
      const modelLower = model.toLowerCase();
      if (modelLower.startsWith("claude-")) {
        // Claude models: Anthropic first, then Z.AI (with GLM conversion), then OpenRouter
        providerOrder = ["anthropic", "zai", "openrouter"];
      } else if (modelLower.startsWith("glm-")) {
        // GLM models: Z.AI first (native GLM support), then Anthropic (with Claude conversion), then OpenRouter
        providerOrder = ["zai", "anthropic", "openrouter"];
      }
    }

    // Find first available provider in priority order
    for (const provider of providerOrder) {
      if (this.isAvailable(provider)) {
        return provider;
      }
    }

    return null; // No provider available
  }

  /**
   * Get the best provider AND model with intelligent fallback
   * Handles model conversion when switching between providers
   *
   * @returns Object with provider, model to use, and whether conversion occurred
   */
  getBestProviderAndModel(
    requestedModel: string | undefined
  ): {
    provider: "anthropic" | "zai" | "openrouter" | null;
    model: string;
    wasConverted: boolean;
    conversionReason?: string;
  } {
    this.checkWeekRollover();

    if (!requestedModel) {
      return {
        provider: this.getBestProviderForModel(undefined),
        model: "claude-sonnet-4-6",
        wasConverted: false,
      };
    }

    const modelLower = requestedModel.toLowerCase();

    // Claude models: Try Anthropic → Z.AI (with GLM conversion) → OpenRouter
    if (modelLower.startsWith("claude-")) {
      // Try Anthropic first with Claude model
      if (this.isAvailable("anthropic")) {
        return {
          provider: "anthropic",
          model: requestedModel,
          wasConverted: false,
        };
      }

      // Anthropic unavailable, try Z.AI with GLM model conversion
      if (this.isAvailable("zai")) {
        const glmModel = this.mapClaudeToGLM(requestedModel);
        return {
          provider: "zai",
          model: glmModel,
          wasConverted: true,
          conversionReason: `Anthropic unavailable, converted ${requestedModel} → ${glmModel}`,
        };
      }

      // Try OpenRouter with mapped model
      if (this.isAvailable("openrouter")) {
        const orModel = this.mapClaudeToOpenRouter(requestedModel);
        return {
          provider: "openrouter",
          model: orModel,
          wasConverted: true,
          conversionReason: `Anthropic and Z.AI unavailable, converted ${requestedModel} → ${orModel}`,
        };
      }
    }

    // GLM models: Try Z.AI → Anthropic (with Claude conversion) → OpenRouter
    else if (modelLower.startsWith("glm-")) {
      // Try Z.AI first with GLM model
      if (this.isAvailable("zai")) {
        return {
          provider: "zai",
          model: requestedModel,
          wasConverted: false,
        };
      }

      // Z.AI unavailable, try Anthropic with Claude model conversion
      if (this.isAvailable("anthropic")) {
        const claudeModel = this.mapGLMToClaude(requestedModel);
        return {
          provider: "anthropic",
          model: claudeModel,
          wasConverted: true,
          conversionReason: `Z.AI unavailable, converted ${requestedModel} → ${claudeModel}`,
        };
      }

      // Try OpenRouter with mapped model
      if (this.isAvailable("openrouter")) {
        const orModel = this.mapGLMToOpenRouter(requestedModel);
        return {
          provider: "openrouter",
          model: orModel,
          wasConverted: true,
          conversionReason: `Z.AI and Anthropic unavailable, converted ${requestedModel} → ${orModel}`,
        };
      }
    }

    // Other models: Use default priority without conversion
    const provider = this.getBestProviderForModel(requestedModel);
    return {
      provider,
      model: requestedModel,
      wasConverted: false,
    };
  }

  /**
   * Map Claude model to equivalent GLM model
   */
  private mapClaudeToGLM(claudeModel: string): string {
    const claudeLower = claudeModel.toLowerCase();
    if (claudeLower.includes("opus")) return "glm-4";
    if (claudeLower.includes("sonnet")) return "glm-4";
    if (claudeLower.includes("haiku")) return "glm-3-air";
    return "glm-4"; // Default to GLM 4
  }

  /**
   * Map GLM model to equivalent Claude model
   */
  private mapGLMToClaude(glmModel: string): string {
    const glmLower = glmModel.toLowerCase();
    if (glmLower === "glm-4" || glmLower === "glm-4-plus") return "claude-sonnet-4-6";
    if (glmLower.includes("-air") || glmLower.includes("-turbo")) return "claude-haiku-4-5";
    return "claude-sonnet-4-6"; // Default to Sonnet
  }

  /**
   * Map Claude model to OpenRouter format
   */
  private mapClaudeToOpenRouter(claudeModel: string): string {
    const claudeLower = claudeModel.toLowerCase();
    if (claudeLower.includes("sonnet")) return "anthropic/claude-sonnet-4-20250514";
    if (claudeLower.includes("opus")) return "anthropic/claude-opus-4-20250514";
    if (claudeLower.includes("haiku")) return "anthropic/claude-haiku-4-20250514";
    return "anthropic/claude-sonnet-4-20250514";
  }

  /**
   * Map GLM model to OpenRouter format
   */
  private mapGLMToOpenRouter(glmModel: string): string {
    const glmLower = glmModel.toLowerCase();
    if (glmLower === "glm-4" || glmLower === "glm-4-plus") return "glm/glm-4";
    if (glmLower.includes("-air")) return "glm/glm-3-air";
    if (glmLower.includes("-turbo")) return "glm/glm-3-turbo";
    return "glm/glm-4";
  }

  /**
   * Record token usage for a provider
   */
  recordTokenUsage(
    provider: "anthropic" | "zai" | "openrouter",
    inputTokens: number,
    outputTokens: number
  ): void {
    this.checkWeekRollover();
    const quota = this.weeklyQuota.get(provider);
    if (quota && quota.limit > 0) {
      quota.usedTokens += inputTokens + outputTokens;

      // Check if we've hit the warning threshold
      const usagePercent = (quota.usedTokens / quota.limit) * 100;
      if (usagePercent >= quota.warningThreshold) {
        this.state.set(provider, ProviderState.QUOTA_EXCEEDED);
      }
    }
  }

  /**
   * Get quota information for a provider
   */
  getQuotaInfo(provider: "anthropic" | "zai" | "openrouter") {
    this.checkWeekRollover();
    const quota = this.weeklyQuota.get(provider);
    if (!quota || quota.limit === 0) return undefined;

    const percentageUsed = (quota.usedTokens / quota.limit) * 100;
    return {
      limit: quota.limit,
      used: quota.usedTokens,
      remaining: Math.max(0, quota.limit - quota.usedTokens),
      percentageUsed: Math.round(percentageUsed * 100) / 100,
      weekStart: new Date(quota.weekStart).toISOString(),
      warningThreshold: quota.warningThreshold,
    };
  }

  /**
   * Get detailed health status for all providers
   */
  getAllStatus(): ProviderHealthStatus[] {
    this.checkWeekRollover();
    return (["anthropic", "zai", "openrouter"] as const).map((provider) => {
      const quota = this.getQuotaInfo(provider);
      return {
        provider,
        state: this.getState(provider),
        available: this.isAvailable(provider),
        metrics: this.metrics.get(provider)!,
        readyAt: this.cooldownUntil.get(provider),
        quota: quota
          ? {
              limit: quota.limit,
              used: quota.used,
              remaining: quota.remaining,
              percentageUsed: quota.percentageUsed,
              weekStart: quota.weekStart,
            }
          : undefined,
      };
    });
  }

  /**
   * Record a successful request
   */
  recordSuccess(provider: "anthropic" | "zai" | "openrouter", latencyMs: number): void {
    const metrics = this.metrics.get(provider)!;
    metrics.totalRequests++;
    metrics.successfulRequests++;
    metrics.lastSuccessTime = Date.now();
    metrics.consecutiveErrors = 0;

    // Update average latency (exponential moving average)
    if (metrics.averageLatency === 0) {
      metrics.averageLatency = latencyMs;
    } else {
      metrics.averageLatency = Math.round(
        metrics.averageLatency * 0.9 + latencyMs * 0.1
      );
    }

    // Reset state on successful request
    if (this.state.get(provider) !== ProviderState.HEALTHY) {
      this.state.set(provider, ProviderState.HEALTHY);
      this.clearHealthCheckTimer(provider);
    }
  }

  /**
   * Record a failed request with error type
   * Context window and rate limit errors trigger immediate cooldown
   */
  recordFailure(
    provider: "anthropic" | "zai" | "openrouter",
    errorType: "rate_limit" | "context_window" | "other"
  ): void {
    const metrics = this.metrics.get(provider)!;
    const config = this.providers.get(provider)!;

    metrics.totalRequests++;
    metrics.failedRequests++;
    metrics.lastFailureTime = Date.now();
    metrics.consecutiveErrors++;

    // Track specific error types
    if (errorType === "rate_limit") {
      metrics.rateLimitHits++;
    } else if (errorType === "context_window") {
      metrics.contextWindowErrors++;
    }

    // IMMEDIATE COOLDOWN for context window or rate limit errors
    // This prevents cascading failures when many concurrent requests are sent
    if (errorType === "context_window" || errorType === "rate_limit") {
      this.enterCooldown(provider);
      return;
    }

    // For other errors, use threshold-based approach
    if (metrics.consecutiveErrors >= config.unavailableThreshold) {
      this.enterCooldown(provider);
    } else if (metrics.consecutiveErrors >= config.degradedThreshold) {
      this.state.set(provider, ProviderState.DEGRADED);
    }

    // Schedule health check if provider is unhealthy
    if (!this.isAvailable(provider) && !this.healthCheckTimers.has(provider)) {
      this.scheduleHealthCheck(provider);
    }
  }

  /**
   * Put a provider into cooldown
   */
  private enterCooldown(provider: "anthropic" | "zai" | "openrouter"): void {
    const config = this.providers.get(provider)!;
    const cooldownEnd = Date.now() + config.cooldownMs;

    this.state.set(provider, ProviderState.COOLING_DOWN);
    this.cooldownUntil.set(provider, cooldownEnd);

    // Schedule recovery check
    this.scheduleHealthCheck(provider, config.cooldownMs);
  }

  /**
   * Schedule a health check for a provider
   */
  private scheduleHealthCheck(
    provider: "anthropic" | "zai" | "openrouter",
    delayMs?: number
  ): void {
    this.clearHealthCheckTimer(provider);

    const config = this.providers.get(provider)!;
    const delay = delayMs || config.healthCheckInterval;

    const timer = setTimeout(async () => {
      if (this.healthCheckCallback) {
        try {
          const isHealthy = await this.healthCheckCallback(provider);
          if (isHealthy) {
            this.state.set(provider, ProviderState.HEALTHY);
            this.metrics.get(provider)!.consecutiveErrors = 0;
            this.clearHealthCheckTimer(provider);
          } else {
            // Retry again later
            this.scheduleHealthCheck(provider);
          }
        } catch {
          // Health check failed, retry later
          this.scheduleHealthCheck(provider);
        }
      }
    }, delay);

    this.healthCheckTimers.set(provider, timer);
  }

  /**
   * Clear a pending health check timer
   */
  private clearHealthCheckTimer(provider: "anthropic" | "zai" | "openrouter"): void {
    const timer = this.healthCheckTimers.get(provider);
    if (timer) {
      clearTimeout(timer);
      this.healthCheckTimers.delete(provider);
    }
  }

  /**
   * Reset all metrics for a provider
   */
  resetMetrics(provider: "anthropic" | "zai" | "openrouter"): void {
    this.metrics.set(provider, this.createEmptyMetrics());
    this.state.set(provider, ProviderState.HEALTHY);
    this.cooldownUntil.set(provider, 0);
    this.clearHealthCheckTimer(provider);
  }

  /**
   * Reset all providers
   */
  resetAll(): void {
    (["anthropic", "zai", "openrouter"] as const).forEach((p) => this.resetMetrics(p));
  }

  /**
   * Clean up timers
   */
  destroy(): void {
    this.healthCheckTimers.forEach((timer) => clearTimeout(timer));
    this.healthCheckTimers.clear();
  }

  /**
   * Get provider config for making requests
   */
  getProviderConfig(provider: "anthropic" | "zai" | "openrouter"): ProviderConfig {
    return this.providers.get(provider)!;
  }
}
