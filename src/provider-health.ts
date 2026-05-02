/**
 * Provider health states
 */
export enum ProviderState {
  HEALTHY = "healthy",
  DEGRADED = "degraded",
  UNAVAILABLE = "unavailable",
  COOLING_DOWN = "cooling_down",
  QUOTA_EXCEEDED = "quota_exceeded"
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
  name: 'zai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  cooldownMs: number;
  degradedThreshold: number; // consecutive errors to mark as degraded
  unavailableThreshold: number; // consecutive errors to mark as unavailable
  healthCheckInterval: number; // ms between health checks when unhealthy
  weeklyQuota?: WeeklyQuota; // optional weekly quota tracking
  priority: number; // lower = higher priority (Anthropic = 1, Z.AI = 2)
}

/**
 * Provider health status
 */
export interface ProviderHealthStatus {
  provider: 'zai' | 'anthropic';
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
  private providers: Map<'zai' | 'anthropic', ProviderConfig>;
  private metrics: Map<'zai' | 'anthropic', ProviderMetrics>;
  private state: Map<'zai' | 'anthropic', ProviderState>;
  private cooldownUntil: Map<'zai' | 'anthropic', number>;
  private healthCheckTimers: Map<'zai' | 'anthropic', NodeJS.Timeout>;
  private healthCheckCallback?: (provider: 'zai' | 'anthropic') => Promise<boolean>;
  private weeklyQuota: Map<'zai' | 'anthropic', WeeklyQuota>;
  private currentWeekStart: number;

  constructor(
    zaiConfig: { baseUrl: string; apiKey: string },
    anthropicConfig: { baseUrl: string; apiKey: string },
    options?: {
      cooldownMs?: number;
      degradedThreshold?: number;
      unavailableThreshold?: number;
      healthCheckInterval?: number;
      anthropicWeeklyLimit?: number; // weekly token limit for Anthropic
      quotaWarningThreshold?: number; // percentage (default: 80)
    }
  ) {
    const cooldownMs = options?.cooldownMs || 60000; // 1 minute default
    const degradedThreshold = options?.degradedThreshold || 3;
    const unavailableThreshold = options?.unavailableThreshold || 5;
    const healthCheckInterval = options?.healthCheckInterval || 30000; // 30 seconds
    const anthropicWeeklyLimit = options?.anthropicWeeklyLimit || 0; // 0 = no limit
    const quotaWarningThreshold = options?.quotaWarningThreshold || 80;

    // Calculate current week start (Monday 00:00:00 UTC)
    this.currentWeekStart = this.getWeekStart();

    // Create Anthropic quota if limit is set
    const anthropicQuota = anthropicWeeklyLimit > 0 ? {
      limit: anthropicWeeklyLimit,
      warningThreshold: quotaWarningThreshold,
      usedTokens: 0,
      weekStart: this.currentWeekStart
    } : undefined;

    this.weeklyQuota = new Map([
      ['zai', { limit: 0, warningThreshold: 100, usedTokens: 0, weekStart: this.currentWeekStart }],
      ['anthropic', anthropicQuota || { limit: 0, warningThreshold: 100, usedTokens: 0, weekStart: this.currentWeekStart }]
    ]);

    this.providers = new Map([
      ['zai', {
        name: 'zai',
        baseUrl: zaiConfig.baseUrl,
        apiKey: zaiConfig.apiKey,
        cooldownMs,
        degradedThreshold,
        unavailableThreshold,
        healthCheckInterval,
        weeklyQuota: this.weeklyQuota.get('zai'),
        priority: 2 // Z.AI is secondary (lower priority)
      }],
      ['anthropic', {
        name: 'anthropic',
        baseUrl: anthropicConfig.baseUrl,
        apiKey: anthropicConfig.apiKey,
        cooldownMs,
        degradedThreshold,
        unavailableThreshold,
        healthCheckInterval,
        weeklyQuota: this.weeklyQuota.get('anthropic'),
        priority: 1 // Anthropic is primary (higher priority)
      }]
    ]);

    this.metrics = new Map([
      ['zai', this.createEmptyMetrics()],
      ['anthropic', this.createEmptyMetrics()]
    ]);

    this.state = new Map([
      ['zai', ProviderState.HEALTHY],
      ['anthropic', ProviderState.HEALTHY]
    ]);

    this.cooldownUntil = new Map([
      ['zai', 0],
      ['anthropic', 0]
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
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), diff));
    return monday.getTime();
  }

  /**
   * Check if the week has rolled over and reset quotas if needed
   */
  private checkWeekRollover(): void {
    const newWeekStart = this.getWeekStart();
    if (newWeekStart > this.currentWeekStart) {
      this.currentWeekStart = newWeekStart;
      (['zai', 'anthropic'] as const).forEach(provider => {
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
      averageLatency: 0
    };
  }

  /**
   * Set the health check callback function
   */
  setHealthCheckCallback(callback: (provider: 'zai' | 'anthropic') => Promise<boolean>): void {
    this.healthCheckCallback = callback;
  }

  /**
   * Get the current state of a provider
   */
  getState(provider: 'zai' | 'anthropic'): ProviderState {
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
    if (storedState === ProviderState.COOLING_DOWN && cooldownEnd <= Date.now()) {
      this.state.set(provider, ProviderState.HEALTHY);
      this.clearHealthCheckTimer(provider);
      return ProviderState.HEALTHY;
    }

    return storedState || ProviderState.HEALTHY;
  }

  /**
   * Check if a provider is available for requests
   */
  isAvailable(provider: 'zai' | 'anthropic'): boolean {
    const state = this.getState(provider);
    return state === ProviderState.HEALTHY || state === ProviderState.DEGRADED;
  }

  /**
   * Get the best available provider based on priority and health
   * Anthropic (priority 1) is preferred over Z.AI (priority 2)
   */
  getBestProvider(): 'zai' | 'anthropic' | null {
    this.checkWeekRollover();

    const providers = ['anthropic', 'zai'] as const;
    const available = providers
      .filter(p => this.isAvailable(p))
      .sort((a, b) => {
        const configA = this.providers.get(a)!;
        const configB = this.providers.get(b)!;
        return configA.priority - configB.priority; // Lower priority number = preferred
      });

    return available[0] || null;
  }

  /**
   * Record token usage for a provider
   */
  recordTokenUsage(provider: 'zai' | 'anthropic', inputTokens: number, outputTokens: number): void {
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
  getQuotaInfo(provider: 'zai' | 'anthropic') {
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
      warningThreshold: quota.warningThreshold
    };
  }

  /**
   * Get detailed health status for all providers
   */
  getAllStatus(): ProviderHealthStatus[] {
    this.checkWeekRollover();
    return (['zai', 'anthropic'] as const).map(provider => {
      const quota = this.getQuotaInfo(provider);
      return {
        provider,
        state: this.getState(provider),
        available: this.isAvailable(provider),
        metrics: this.metrics.get(provider)!,
        readyAt: this.cooldownUntil.get(provider),
        quota: quota ? {
          limit: quota.limit,
          used: quota.used,
          remaining: quota.remaining,
          percentageUsed: quota.percentageUsed,
          weekStart: quota.weekStart
        } : undefined
      };
    });
  }

  /**
   * Record a successful request
   */
  recordSuccess(provider: 'zai' | 'anthropic', latencyMs: number): void {
    const metrics = this.metrics.get(provider)!;
    metrics.totalRequests++;
    metrics.successfulRequests++;
    metrics.lastSuccessTime = Date.now();
    metrics.consecutiveErrors = 0;

    // Update average latency (exponential moving average)
    if (metrics.averageLatency === 0) {
      metrics.averageLatency = latencyMs;
    } else {
      metrics.averageLatency = Math.round(metrics.averageLatency * 0.9 + latencyMs * 0.1);
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
  recordFailure(provider: 'zai' | 'anthropic', errorType: 'rate_limit' | 'context_window' | 'other', statusCode?: number): void {
    const metrics = this.metrics.get(provider)!;
    const config = this.providers.get(provider)!;

    metrics.totalRequests++;
    metrics.failedRequests++;
    metrics.lastFailureTime = Date.now();
    metrics.consecutiveErrors++;

    // Track specific error types
    if (errorType === 'rate_limit') {
      metrics.rateLimitHits++;
    } else if (errorType === 'context_window') {
      metrics.contextWindowErrors++;
    }

    // IMMEDIATE COOLDOWN for context window or rate limit errors
    // This prevents cascading failures when many concurrent requests are sent
    if (errorType === 'context_window' || errorType === 'rate_limit') {
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
  private enterCooldown(provider: 'zai' | 'anthropic'): void {
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
  private scheduleHealthCheck(provider: 'zai' | 'anthropic', delayMs?: number): void {
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
  private clearHealthCheckTimer(provider: 'zai' | 'anthropic'): void {
    const timer = this.healthCheckTimers.get(provider);
    if (timer) {
      clearTimeout(timer);
      this.healthCheckTimers.delete(provider);
    }
  }

  /**
   * Reset all metrics for a provider
   */
  resetMetrics(provider: 'zai' | 'anthropic'): void {
    this.metrics.set(provider, this.createEmptyMetrics());
    this.state.set(provider, ProviderState.HEALTHY);
    this.cooldownUntil.set(provider, 0);
    this.clearHealthCheckTimer(provider);
  }

  /**
   * Reset all providers
   */
  resetAll(): void {
    (['zai', 'anthropic'] as const).forEach(p => this.resetMetrics(p));
  }

  /**
   * Clean up timers
   */
  destroy(): void {
    this.healthCheckTimers.forEach(timer => clearTimeout(timer));
    this.healthCheckTimers.clear();
  }

  /**
   * Get provider config for making requests
   */
  getProviderConfig(provider: 'zai' | 'anthropic'): ProviderConfig {
    return this.providers.get(provider)!;
  }
}
