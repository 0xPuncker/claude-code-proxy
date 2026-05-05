#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ProxyConfig, RequestOptions, HttpResponse, LogLevel, RequestMetrics } from "./types.js";
import { UsageTracker } from "./database/tracker.js";
import { ProviderHealth } from "./provider-health.js";

/**
 * Default configuration for the proxy server
 */
const DEFAULT_CONFIG: ProxyConfig = {
  port: parseInt(process.env.PROXY_PORT || "4181", 10),
  // Primary: Anthropic API (Claude models)
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    apiKey: process.env.ANTHROPIC_API_KEY || "",
  },
  // Secondary: Z.AI API (GLM models)
  zai: {
    baseUrl: "https://api.z.ai/api/anthropic",
    apiKey: process.env.ZAI_API_KEY || "",
  },
  // Fallback: OpenRouter (free models)
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY || "",
  },
  claudeSubscription: {
    baseUrl: "https://api.claude.ai/api",
    credentialsPath: process.env.CLAUDE_CREDENTIALS_PATH ||
      path.join(os.homedir(), ".claude", ".credentials.json"),
    enabled: process.env.CLAUDE_SUBSCRIPTION_ENABLED !== "false",
  },
  modelFallbackMap: {
    // Anthropic Claude models (use directly)
    "claude-sonnet-4-6": "claude-sonnet-4-6",
    "claude-opus-4-6": "claude-opus-4-6",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
    "claude-sonnet-4-5": "claude-sonnet-4-5",
    // Legacy Claude models -> latest versions
    "claude-opus": "claude-opus-4-6",
    "claude-sonnet": "claude-sonnet-4-6",
    "claude-haiku": "claude-haiku-4-5-20251001",
    // Z.AI GLM models (use directly)
    "glm-5.1": "glm-5.1",
    "glm-5": "glm-5",
    "glm-5-turbo": "glm-5-turbo",
    "glm-5v-turbo": "glm-5v-turbo",
    "glm-4.7": "glm-4.7",
    "glm-4.7-flash": "glm-4.7-flash",
    "glm-4.6": "glm-4.6",
    "glm-4.6v": "glm-4.6v",
    "glm-4.5": "glm-4.5",
    "glm-4.5v": "glm-4.5v",
    "glm-4.5-air": "glm-4.5-air",
    "glm-4-32b": "glm-4-32b",
    // Legacy GLM models -> latest
    "glm-4": "glm-4.7",
    // Fallback to OpenRouter free models (when others fail)
    "openrouter-free": "google/gemma-3-27b-it:free",
  },
  fallbackOnCodes: [429, 503, 502],
  logLevel: "info",
  timeout: {
    requestMs: parseInt(process.env.API_TIMEOUT_MS || "300000", 10),      // 5 minutes default
    streamingMs: parseInt(process.env.API_STREAMING_TIMEOUT_MS || "600000", 10), // 10 minutes default
    maxRetries: parseInt(process.env.API_MAX_RETRIES || "3", 10),
    retryDelayMs: parseInt(process.env.API_RETRY_DELAY_MS || "1000", 10),
  },
  circuitBreaker: {
    enabled: process.env.CIRCUIT_BREAKER_ENABLED !== "false",
    cooldownMs: parseInt(process.env.CIRCUIT_BREAKER_COOLDOWN_MS || "60000", 10),
    degradedThreshold: parseInt(process.env.CIRCUIT_BREAKER_DEGRADED_THRESHOLD || "3", 10),
    unavailableThreshold: parseInt(process.env.CIRCUIT_BREAKER_UNAVAILABLE_THRESHOLD || "5", 10),
    healthCheckInterval: parseInt(process.env.CIRCUIT_BREAKER_HEALTH_CHECK_INTERVAL || "30000", 10),
    anthropicWeeklyLimit: parseInt(process.env.ANTHROPIC_WEEKLY_LIMIT || "0", 10),
    quotaWarningThreshold: parseInt(process.env.QUOTA_WARNING_THRESHOLD || "80", 10),
  },
  database: process.env.DATABASE_URL ? {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432", 10),
    database: process.env.DB_NAME || "claude_proxy",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "postgres",
    ssl: process.env.DB_SSL === "true",
    maxConnections: parseInt(process.env.DB_MAX_CONNECTIONS || "10", 10),
    idleTimeoutMs: parseInt(process.env.DB_IDLE_TIMEOUT_MS || "30000", 10),
    connectionTimeoutMs: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || "2000", 10),
  } : undefined,
};

/**
 * Logger class for structured logging
 */
class Logger {
  private level: LogLevel;

  constructor(level: string = "info") {
    this.level = this.parseLevel(level);
  }

  private parseLevel(level: string): LogLevel {
    switch (level.toLowerCase()) {
      case "debug": return LogLevel.DEBUG;
      case "info": return LogLevel.INFO;
      case "warn": return LogLevel.WARN;
      case "error": return LogLevel.ERROR;
      case "silent": return LogLevel.SILENT;
      default: return LogLevel.INFO;
    }
  }

  private log(level: LogLevel, levelStr: string, color: string, msg: string): void {
    if (level < this.level) return;

    const ts = new Date().toISOString().slice(11, 19);
    console.log(`${color}[${ts}] [${levelStr.toUpperCase()}] ${msg}\x1b[0m`);
  }

  debug(msg: string): void {
    this.log(LogLevel.DEBUG, "debug", "\x1b[90m", msg);
  }

  info(msg: string): void {
    this.log(LogLevel.INFO, "info", "\x1b[36m", msg);
  }

  warn(msg: string): void {
    this.log(LogLevel.WARN, "warn", "\x1b[33m", msg);
  }

  error(msg: string): void {
    this.log(LogLevel.ERROR, "error", "\x1b[31m", msg);
  }

  ok(msg: string): void {
    if (this.level <= LogLevel.INFO) {
      const ts = new Date().toISOString().slice(11, 19);
      console.log(`\x1b[32m[${ts}] [OK] ${msg}\x1b[0m`);
    }
  }
}

/**
 * Proxy server class
 */
export class ClaudeCodeProxy {
  private config: ProxyConfig;
  private logger: Logger;
  private server: http.Server;
  private usageTracker: UsageTracker;
  private providerHealth: ProviderHealth;
  private requestCounter = 0;

  constructor(config: Partial<ProxyConfig> = {}) {
    this.config = this.mergeConfig(config);
    this.logger = new Logger(this.config.logLevel);
    this.usageTracker = new UsageTracker(this.config.database);

    // Initialize provider health tracker
    const cb = this.config.circuitBreaker || DEFAULT_CONFIG.circuitBreaker!;
    this.providerHealth = new ProviderHealth(
      { baseUrl: this.config.anthropic.baseUrl, apiKey: this.config.anthropic.apiKey },
      { baseUrl: this.config.zai.baseUrl, apiKey: this.config.zai.apiKey },
      { baseUrl: this.config.openrouter.baseUrl, apiKey: this.config.openrouter.apiKey },
      {
        cooldownMs: cb.cooldownMs,
        degradedThreshold: cb.degradedThreshold,
        unavailableThreshold: cb.unavailableThreshold,
        healthCheckInterval: cb.healthCheckInterval,
        anthropicWeeklyLimit: cb.anthropicWeeklyLimit,
        quotaWarningThreshold: cb.quotaWarningThreshold
      }
    );

    // Set up health check callback
    this.providerHealth.setHealthCheckCallback(this.performProviderHealthCheck.bind(this));

    this.server = this.createServer();
  }

  private mergeConfig(config: Partial<ProxyConfig>): ProxyConfig {
    return {
      ...DEFAULT_CONFIG,
      ...config,
      anthropic: { ...DEFAULT_CONFIG.anthropic, ...config.anthropic },
      zai: { ...DEFAULT_CONFIG.zai, ...config.zai },
      openrouter: { ...DEFAULT_CONFIG.openrouter, ...config.openrouter },
      claudeSubscription: { ...DEFAULT_CONFIG.claudeSubscription, ...config.claudeSubscription },
      modelFallbackMap: { ...DEFAULT_CONFIG.modelFallbackMap, ...config.modelFallbackMap },
      timeout: { ...DEFAULT_CONFIG.timeout, ...config.timeout },
      circuitBreaker: { ...DEFAULT_CONFIG.circuitBreaker, ...config.circuitBreaker },
      database: config.database || DEFAULT_CONFIG.database,
    };
  }

  /**
   * Generate a unique request ID
   */
  private generateRequestId(): string {
    this.requestCounter++;
    return `REQ-${this.requestCounter.toString().padStart(5, '0')}`;
  }

  /**
   * Format provider and model info for logging
   */
  private formatRequestLog(provider: string, model: string | undefined, isStreaming: boolean, status: string = 'sending'): string {
    // Map internal provider names to user-friendly display names with icons
    const providerDisplayNames: Record<string, string> = {
      'zai': '⚡ Z.AI',
      'anthropic': '🟣 Anthropic',
      'openrouter': '🌐 OpenRouter',
      'subscription': '🎟️  Subscription',
    };

    // Format model name for display
    let modelDisplay = model || 'unknown';
    if (modelDisplay.startsWith('claude-')) {
      modelDisplay = modelDisplay.replace('claude-', '').replace('-', ' ').toUpperCase();
      modelDisplay = modelDisplay.replace(/(\d)\s+(\d)/g, '$1.$2');
    } else if (modelDisplay.startsWith('glm')) {
      modelDisplay = modelDisplay.toUpperCase().replace('-', ' ');
    }

    const providerName = providerDisplayNames[provider] || provider.toUpperCase();
    return `${providerName} ▸ ${modelDisplay} ▸ ${status}`;
  }

  private async readClaudeOAuthToken(retries = 3): Promise<string | undefined> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const raw = fs.readFileSync(this.config.claudeSubscription.credentialsPath, "utf-8");
        const creds = JSON.parse(raw);
        const token = creds?.claudeAiOauth?.accessToken as string | undefined;
        const expiresAt = creds?.claudeAiOauth?.expiresAt as number | undefined;
        if (expiresAt && Date.now() > expiresAt) {
          this.logger.warn("Claude subscription OAuth token has expired");
          return undefined;
        }
        return token;
      } catch (err) {
        // JSON parse failure = file mid-write race; wait 50ms and retry
        if (err instanceof SyntaxError && attempt < retries) {
          await new Promise(r => setTimeout(r, 50));
          continue;
        }
        return undefined;
      }
    }
  }

  private async trySubscriptionRequest(
    reqBody: string,
    reqHeaders: Record<string, string>,
    reqPath: string,
    reqMethod: string
  ): Promise<HttpResponse | undefined> {
    if (!this.config.claudeSubscription.enabled) return undefined;

    const oauthToken = await this.readClaudeOAuthToken();
    if (!oauthToken) {
      this.logger.warn("Claude subscription credentials not found or expired — skipping");
      return undefined;
    }

    const cleanedPath = this.cleanPath(reqPath);
    const cleanedBody = this.cleanBody(reqBody, "subscription");

    const tryRequest = async (token: string) => {
      const subHeaders = this.buildSubscriptionHeaders(reqHeaders, token);
      subHeaders["content-length"] = Buffer.byteLength(cleanedBody).toString();
      return this.httpRequest(
        `${this.config.claudeSubscription.baseUrl}${cleanedPath}`,
        { method: reqMethod, headers: subHeaders, body: cleanedBody }
      );
    };

    this.logger.info(`→ Claude subscription ${reqMethod} ${cleanedPath}`);
    try {
      let subRes = await tryRequest(oauthToken);

      if (subRes.status === 401) {
        this.logger.warn("← Claude subscription 401 — re-reading credentials and retrying");
        const freshToken = await this.readClaudeOAuthToken();
        if (freshToken && freshToken !== oauthToken) subRes = await tryRequest(freshToken);
      }

      if (!this.config.fallbackOnCodes.includes(subRes.status)) {
        if (subRes.status >= 400) {
          this.logger.error(`← Claude subscription ❌ ${subRes.status}: ${subRes.body.toString().slice(0, 300)}`);
        } else {
          this.logger.ok(`← Claude subscription ${subRes.status}`);
        }
        return subRes;
      }
      this.logger.warn(`← Claude subscription ⚠️  ${subRes.status} — trying next provider`);
      return undefined;
    } catch (err) {
      this.logger.error(`← Claude subscription ❌ ${err instanceof Error ? err.message : "Unknown"} — fallback`);
      return undefined;
    }
  }

  private buildSubscriptionHeaders(reqHeaders: Record<string, string>, token: string): Record<string, string> {
    const cleaned: Record<string, string> = {};
    const allowed = ["content-type", "accept", "anthropic-version", "anthropic-beta", "user-agent"];
    for (const key of allowed) {
      if (reqHeaders[key]) cleaned[key] = reqHeaders[key];
    }
    cleaned["authorization"] = `Bearer ${token}`;
    cleaned["host"] = new URL(this.config.claudeSubscription.baseUrl).host;
    if (!cleaned["anthropic-version"]) cleaned["anthropic-version"] = "2023-06-01";
    return cleaned;
  }

  private createServer(): http.Server {
    return http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", async () => {
        try {
          // Convert headers to Record<string, string> format
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(req.headers)) {
            if (value) {
              headers[key] = Array.isArray(value) ? value[0] : value;
            }
          }
          await this.handleRequest(Buffer.concat(chunks).toString(), headers, req.url || "", req.method || "GET", res);
        } catch (err) {
          this.handleError(err, res);
        }
      });
    });
  }

  private handleError(err: unknown, res: ServerResponse): void {
    const message = err instanceof Error ? err.message : "Unknown error";
    this.logger.error(`Proxy error: ${message}`);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message } }));
  }

  /**
   * Perform HTTP/HTTPS request with timeout and retry logic
   */
  private async httpRequest(url: string, options: RequestOptions, timeoutMs?: number): Promise<HttpResponse> {
    const timeout = timeoutMs || this.config.timeout?.requestMs || 300000; // 5 minutes default
    const maxRetries = this.config.timeout?.maxRetries || 3;
    const retryDelay = this.config.timeout?.retryDelayMs || 1000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.executeRequest(url, options, timeout);
        return result;
      } catch (err) {
        const isTimeout = err instanceof Error && (
          err.message.includes('timeout') ||
          err.message.includes('ETIMEDOUT') ||
          err.message.includes('ESOCKETTIMEDOUT')
        );

        if (isTimeout && attempt < maxRetries) {
          const delay = retryDelay * Math.pow(2, attempt); // Exponential backoff
          this.logger.warn(`Request timeout (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        if (isTimeout) {
          this.logger.error(`Request timed out after ${maxRetries + 1} attempts (${timeout}ms timeout)`);
        }
        throw err;
      }
    }

    throw new Error('Max retries exceeded');
  }

  /**
   * Execute a single HTTP request with timeout
   */
  private executeRequest(url: string, options: RequestOptions, timeoutMs: number): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const mod = parsedUrl.protocol === "https:" ? https : http;

      const timeout = setTimeout(() => {
        req.destroy();
        reject(new Error(`Request timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const req = mod.request(
        parsedUrl,
        { method: options.method || "GET", headers: options.headers || {} },
        (res) => {
          clearTimeout(timeout);
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            resolve({
              status: res.statusCode || 200,
              headers: res.headers as Record<string, string>,
              body: Buffer.concat(chunks),
            });
          });
        }
      );

      req.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      if (options.body) req.write(options.body);
      req.end();
    });
  }

  /**
   * Map model name using fallback configuration
   */
  private mapModel(
    model: string,
    provider: "anthropic" | "zai" | "openrouter" | "subscription" = "anthropic"
  ): string {
    if (provider !== "openrouter") {
      return this.config.modelFallbackMap[model] || model;
    }

    const openRouterModels: Record<string, string> = {
      "claude-sonnet-4-6": "anthropic/claude-sonnet-4.6",
      "claude-opus-4-6": "anthropic/claude-opus-4.6",
      "claude-haiku-4-5-20251001": "anthropic/claude-haiku-4.5",
      "claude-sonnet-4-5": "anthropic/claude-sonnet-4.5",
      "claude-opus": "anthropic/claude-opus-4.6",
      "claude-sonnet": "anthropic/claude-sonnet-4.6",
      "claude-haiku": "anthropic/claude-haiku-4.5",
      "openrouter-free":
        this.config.modelFallbackMap["openrouter-free"] ||
        "google/gemma-3-27b-it:free",
    };

    if (openRouterModels[model]) {
      return openRouterModels[model];
    }

    return this.config.modelFallbackMap[model] || model;
  }

  /**
   * Extract model from request body
   */
  private extractModel(bodyStr: string): string | undefined {
    try {
      const body = JSON.parse(bodyStr);
      return body.model as string;
    } catch {
      return undefined;
    }
  }

  /**
   * Check if response body contains a context window error
   * Handles various API error message formats
   */
  private isContextWindowError(body: Buffer): boolean {
    try {
      const bodyStr = body.toString();

      // Try to parse as JSON to check error.message field
      try {
        const json = JSON.parse(bodyStr);
        if (json.error?.message) {
          const msg = json.error.message.toLowerCase();
          if (msg.includes("context window") || msg.includes("context limit") ||
              msg.includes("reached its context") || msg.includes("exceeds context")) {
            return true;
          }
        }
      } catch {
        // Not JSON, continue with string checks
      }

      // Direct string match for the exact error message
      const lower = bodyStr.toLowerCase();

      // Exact phrase from the error
      if (lower.includes("reached its context window limit")) {
        return true;
      }
      if (lower.includes("context window limit")) {
        return true;
      }

      // Check for various context window error patterns
      const contextWindowPatterns = [
        "context window",
        "context_window",
        "context-window",
        "exceeds context",
        "exceeded context",
        "too long",
        "maximum context",
        "max tokens",
        "token limit",
        "input too long",
        "message too long",
        "prompt too long",
        "request too large",
        "content too long"
      ];

      return contextWindowPatterns.some(pattern => lower.includes(pattern));
    } catch {
      return false;
    }
  }

  /**
   * Clean URL path to remove query parameters
   */
  private cleanPath(path: string): string {
    try {
      return new URL(path, "http://localhost").pathname;
    } catch {
      return path.split("?")[0];
    }
  }

  /**
   * Normalize request path for providers with different base URL shapes
   */
  private normalizeProviderPath(
    provider: "anthropic" | "zai" | "openrouter",
    reqPath: string
  ): string {
    const cleanedPath = this.cleanPath(reqPath);

    if (provider === "openrouter" && cleanedPath.startsWith("/v1/")) {
      return cleanedPath.slice(3);
    }

    return cleanedPath;
  }

  /**
   * Get fallback providers in configured priority order, excluding the current provider
   */
  private getFallbackProviders(
    primaryProvider: "anthropic" | "zai" | "openrouter"
  ): Array<"anthropic" | "zai" | "openrouter"> {
    return (["anthropic", "zai", "openrouter"] as const)
      .filter(
        (provider) =>
          provider !== primaryProvider && this.providerHealth.hasValidApiKey(provider)
      )
      .sort(
        (a, b) =>
          this.providerHealth.getProviderConfig(a).priority -
          this.providerHealth.getProviderConfig(b).priority
      );
  }

  /**
   * Clean and normalize headers for Anthropic API
   */
  private cleanHeaders(headers: Record<string, string>): Record<string, string> {
    const cleaned: Record<string, string> = {};
    const allowedHeaders = ["content-type", "accept", "anthropic-version", "anthropic-beta", "user-agent"];

    for (const key of allowedHeaders) {
      if (headers[key]) cleaned[key] = headers[key];
    }

    cleaned["x-api-key"] = this.config.anthropic.apiKey;
    cleaned["host"] = new URL(this.config.anthropic.baseUrl).host;
    if (!cleaned["anthropic-version"]) cleaned["anthropic-version"] = "2023-06-01";

    return cleaned;
  }

  /**
   * Clean and validate request body for Anthropic API compatibility
   */
  private cleanBody(
    bodyStr: string,
    provider: "anthropic" | "zai" | "openrouter" | "subscription" = "anthropic"
  ): string {
    try {
      const body = JSON.parse(bodyStr);
      const allowedFields = [
        "model", "messages", "max_tokens", "stop_sequences", "stream",
        "system", "temperature", "top_p", "top_k", "metadata", "tools", "tool_choice",
        "thinking"
      ];

      const cleaned: Record<string, unknown> = {};
      for (const field of allowedFields) {
        if (body[field] !== undefined) cleaned[field] = body[field];
      }

      // Remap model if present
      if (cleaned.model && typeof cleaned.model === "string") {
        const original = cleaned.model;
        cleaned.model = this.mapModel(cleaned.model, provider);
        // Only log if model was actually remapped
        if (original !== cleaned.model) {
          this.logger.debug(`  model remap (${provider}): ${original} → ${cleaned.model}`);
        }
      }

      // Log stripped fields
      const stripped = Object.keys(body).filter(k => !allowedFields.includes(k));
      if (stripped.length > 0) {
        this.logger.debug(`  stripped fields: ${stripped.join(", ")}`);
      }

      return JSON.stringify(cleaned);
    } catch {
      return bodyStr;
    }
  }

  /**
   * Perform a health check on a provider by making a minimal request
   */
  private async performProviderHealthCheck(provider: 'anthropic' | 'zai' | 'openrouter'): Promise<boolean> {
    try {
      let config;
      let url;
      let headers: Record<string, string>;

      if (provider === 'anthropic') {
        config = this.config.anthropic;
        url = `${config.baseUrl}/v1/messages`;
        headers = {
          host: new URL(config.baseUrl).host,
          "x-api-key": config.apiKey,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        };
      } else if (provider === 'zai') {
        config = this.config.zai;
        url = `${config.baseUrl}/v1/messages`;
        headers = {
          host: new URL(config.baseUrl).host,
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        };
      } else {
        config = this.config.openrouter;
        url = `${config.baseUrl}/messages`;
        headers = {
          host: new URL(config.baseUrl).host,
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
          "HTTP-Referer": "https://claude.ai/code",
          "X-Title": "Claude Code",
        };
      }

      // Minimal test request
      const testBody = JSON.stringify({
        model:
          provider === "openrouter"
            ? "anthropic/claude-haiku-4.5"
            : "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }]
      });

      const res = await this.httpRequest(url, {
        method: "POST",
        headers,
        body: testBody
      });

      // Consider 200, 400 (bad request but reachable), 401 (auth error but reachable) as healthy
      const isHealthy = res.status < 500;
      this.logger.debug(`Health check for ${provider}: ${isHealthy ? 'HEALTHY' : 'UNHEALTHY'} (${res.status})`);
      return isHealthy;
    } catch (err) {
      this.logger.debug(`Health check for ${provider} failed: ${err instanceof Error ? err.message : 'Unknown'}`);
      return false;
    }
  }

  /**
   * Build request headers for a specific provider
   */
  private buildProviderHeaders(provider: 'anthropic' | 'zai' | 'openrouter', reqHeaders: Record<string, string>): Record<string, string> {
    if (provider === 'zai') {
      const headers: Record<string, string> = {
        host: new URL(this.config.zai.baseUrl).host,
        authorization: `Bearer ${this.config.zai.apiKey}`,
      };
      // Copy allowed headers
      for (const [key, value] of Object.entries(reqHeaders)) {
        if (!["authorization", "transfer-encoding", "connection", "host"].includes(key)) {
          headers[key] = value;
        }
      }
      return headers;
    } else if (provider === 'openrouter') {
      const headers: Record<string, string> = {
        host: new URL(this.config.openrouter.baseUrl).host,
        authorization: `Bearer ${this.config.openrouter.apiKey}`,
        "HTTP-Referer": "https://claude.ai/code",
        "X-Title": "Claude Code",
      };
      // Copy allowed headers
      for (const [key, value] of Object.entries(reqHeaders)) {
        if (!["authorization", "transfer-encoding", "connection", "host"].includes(key)) {
          headers[key] = value;
        }
      }
      return headers;
    } else {
      // Anthropic headers
      return this.cleanHeaders(reqHeaders);
    }
  }

  /**
   * Make a request to a specific provider
   */
  private async requestProvider(
    provider: 'anthropic' | 'zai' | 'openrouter',
    reqBody: string,
    reqHeaders: Record<string, string>,
    reqPath: string,
    reqMethod: string
  ): Promise<{ response: HttpResponse; errorType?: 'rate_limit' | 'context_window' | 'other' }> {
    let config;
    if (provider === 'anthropic') {
      config = this.config.anthropic;
    } else if (provider === 'zai') {
      config = this.config.zai;
    } else {
      config = this.config.openrouter;
    }

    const normalizedPath = this.normalizeProviderPath(provider, reqPath);
    const url = `${config.baseUrl}${normalizedPath}`;
    const headers = this.buildProviderHeaders(provider, reqHeaders);
    const body = this.cleanBody(reqBody, provider);
    headers["content-length"] = Buffer.byteLength(body).toString();

    const response = await this.httpRequest(url, {
      method: reqMethod,
      headers,
      body
    });

    // Detect error types
    let errorType: 'rate_limit' | 'context_window' | 'other' | undefined;
    if (response.status >= 400) {
      if (response.status === 429) {
        errorType = 'rate_limit';
      } else if (this.isContextWindowError(response.body)) {
        errorType = 'context_window';
        this.logger.debug(`  Context window error detected for ${provider}`);
      } else {
        errorType = 'other';
      }
    }

    return { response, errorType };
  }

  /**
   * Proxy request with dynamic provider selection
   */
  private async proxyRequest(
    reqBody: string,
    reqHeaders: Record<string, string>,
    reqPath: string,
    reqMethod: string
  ): Promise<HttpResponse> {
    const startTime = Date.now();
    const model = this.extractModel(reqBody);
    const requestId = this.generateRequestId();
    const cbEnabled = this.config.circuitBreaker?.enabled !== false;

    // Determine best provider based on model (circuit breaker enabled)
    let selectedProvider = cbEnabled ? this.providerHealth.getBestProviderForModel(model) : 'anthropic';

    // Default to Anthropic if circuit breaker is disabled or no provider selected
    if (!selectedProvider) {
      this.logger.warn(`No healthy provider available for model ${model || 'unknown'}, trying Anthropic as fallback`);
      selectedProvider = 'anthropic';
    }

    const primaryProvider = selectedProvider;
    this.logger.info(`[${requestId}] → ${this.formatRequestLog(primaryProvider, model, false, 'sending')}`);

    try {
      const { response, errorType } = await this.requestProvider(
        primaryProvider,
        reqBody,
        reqHeaders,
        reqPath,
        reqMethod
      );

      const latency = Date.now() - startTime;

      // Record success or failure
      if (response.status < 400) {
        if (cbEnabled) {
          this.providerHealth.recordSuccess(primaryProvider, latency);
          // Record token usage for quota tracking
          const tokenUsage = UsageTracker.extractTokenUsage(response.body.toString());
          if (tokenUsage) {
            this.providerHealth.recordTokenUsage(primaryProvider, tokenUsage.input_tokens, tokenUsage.output_tokens);
          }
        }

        // Format response log with token info if available
        const tokenUsage = UsageTracker.extractTokenUsage(response.body.toString());
        const tokenStr = tokenUsage ?
          `${(tokenUsage.input_tokens / 1000).toFixed(1)}k→${(tokenUsage.output_tokens / 1000).toFixed(1)}k tokens` :
          '';
        const latencyStr = `${(latency / 1000).toFixed(2)}s`;
        const details = [tokenStr, latencyStr].filter(Boolean).join(' | ');

        this.logger.ok(`[${requestId}] ← ✅ ${response.status} ${details ? `| ${details}` : ''}`);
        await this.trackRequestMetrics(reqMethod, reqPath, startTime, response.status, false, primaryProvider, model, false, response.body);
        return response;
      }

      const reason = errorType === 'context_window' ? "context window" :
                     errorType === 'rate_limit' ? "rate limit" :
                     `HTTP ${response.status}`;
      this.logger.warn(`[${requestId}] ← ⚠️  ${primaryProvider.toUpperCase()} ${reason} — trying subscription`);

      // Try Claude subscription before the other API provider
      const subResult = await this.trySubscriptionRequest(reqBody, reqHeaders, reqPath, reqMethod);
      if (subResult) {
        this.logger.ok(`[${requestId}] ✓ SUBSCRIPTION ${subResult.status}`);
        await this.trackRequestMetrics(reqMethod, reqPath, startTime, subResult.status, true, 'anthropic', model, false, subResult.body);
        return subResult;
      }

      const fallbackProviders = this.getFallbackProviders(primaryProvider);
      let lastFallbackResponse: HttpResponse | undefined;

      for (const fallbackProvider of fallbackProviders) {
        this.logger.info(`[${requestId}] → ${this.formatRequestLog(fallbackProvider, model, false, 'retrying')}`);

        const { response: fallbackRes } = await this.requestProvider(
          fallbackProvider,
          reqBody,
          reqHeaders,
          reqPath,
          reqMethod
        );

        const fallbackLatency = Date.now() - startTime;

        if (fallbackRes.status < 400) {
          if (cbEnabled) {
            this.providerHealth.recordSuccess(fallbackProvider, fallbackLatency);
            const tokenUsage = UsageTracker.extractTokenUsage(fallbackRes.body.toString());
            if (tokenUsage) {
              this.providerHealth.recordTokenUsage(
                fallbackProvider,
                tokenUsage.input_tokens,
                tokenUsage.output_tokens
              );
            }
          }
          this.logger.ok(`[${requestId}] ← ✅ ${fallbackProvider.toUpperCase()} ${fallbackRes.status} | recovered`);
          await this.trackRequestMetrics(
            reqMethod,
            reqPath,
            startTime,
            fallbackRes.status,
            true,
            fallbackProvider,
            model,
            false,
            fallbackRes.body
          );
          return fallbackRes;
        }

        lastFallbackResponse = fallbackRes;
        if (cbEnabled) {
          const fbErrorType =
            fallbackRes.status === 429
              ? "rate_limit"
              : this.isContextWindowError(fallbackRes.body)
                ? "context_window"
                : "other";
          this.providerHealth.recordFailure(
            fallbackProvider,
            fbErrorType
          );
        }

        this.logger.error(
          `← ${fallbackProvider.toUpperCase()} ${fallbackRes.status}: ${fallbackRes.body
            .toString()
            .slice(0, 300)}`
        );
        await this.trackRequestMetrics(
          reqMethod,
          reqPath,
          startTime,
          fallbackRes.status,
          true,
          fallbackProvider,
          model,
          false,
          fallbackRes.body
        );
      }

      return lastFallbackResponse || response;

    } catch (err) {
      // Network error - record failure and try fallback
      if (cbEnabled) {
        this.providerHealth.recordFailure(primaryProvider, 'other');
      }

      this.logger.error(`← ❌ ${primaryProvider.toUpperCase()} error: ${err instanceof Error ? err.message : "Unknown"} — trying subscription`);

      const subResult = await this.trySubscriptionRequest(reqBody, reqHeaders, reqPath, reqMethod);
      if (subResult) {
        await this.trackRequestMetrics(reqMethod, reqPath, startTime, subResult.status, true, 'anthropic', model, false, subResult.body);
        return subResult;
      }

      const fallbackProviders = this.getFallbackProviders(primaryProvider);
      let lastFallbackResponse: HttpResponse | undefined;
      let lastFallbackError: unknown;

      for (const fallbackProvider of fallbackProviders) {
        this.logger.info(`[${requestId}] → ${this.formatRequestLog(fallbackProvider, model, false, 'fallback')}`);

        try {
          const { response: fallbackRes } = await this.requestProvider(
            fallbackProvider,
            reqBody,
            reqHeaders,
            reqPath,
            reqMethod
          );

          const fallbackLatency = Date.now() - startTime;

          if (fallbackRes.status < 400) {
            if (cbEnabled) {
              this.providerHealth.recordSuccess(fallbackProvider, fallbackLatency);
              const tokenUsage = UsageTracker.extractTokenUsage(
                fallbackRes.body.toString()
              );
              if (tokenUsage) {
                this.providerHealth.recordTokenUsage(
                  fallbackProvider,
                  tokenUsage.input_tokens,
                  tokenUsage.output_tokens
                );
              }
            }
            this.logger.ok(`[${requestId}] ← ✅ ${fallbackProvider.toUpperCase()} ${fallbackRes.status} | recovered`);
            await this.trackRequestMetrics(
              reqMethod,
              reqPath,
              startTime,
              fallbackRes.status,
              true,
              fallbackProvider,
              model,
              false,
              fallbackRes.body
            );
            return fallbackRes;
          }

          lastFallbackResponse = fallbackRes;
          if (cbEnabled) {
            const fbErrorType =
              fallbackRes.status === 429
                ? "rate_limit"
                : this.isContextWindowError(fallbackRes.body)
                  ? "context_window"
                  : "other";
            this.providerHealth.recordFailure(
              fallbackProvider,
              fbErrorType
            );
          }

          this.logger.error(`← ${fallbackProvider.toUpperCase()} ${fallbackRes.status}`);
          await this.trackRequestMetrics(
            reqMethod,
            reqPath,
            startTime,
            fallbackRes.status,
            true,
            fallbackProvider,
            model,
            false,
            fallbackRes.body
          );
        } catch (fallbackErr) {
          lastFallbackError = fallbackErr;
          if (cbEnabled) {
            this.providerHealth.recordFailure(fallbackProvider, 'other');
          }
          this.logger.error(
            `← ${fallbackProvider.toUpperCase()} error: ${
              fallbackErr instanceof Error ? fallbackErr.message : "Unknown"
            }`
          );
        }
      }

      if (lastFallbackResponse) return lastFallbackResponse;
      if (lastFallbackError) throw lastFallbackError;
      throw err;
    }

  }

  /**
   * Handle streaming requests with dynamic provider selection
   */
  private async handleStreamingRequest(
    reqBody: string,
    reqHeaders: Record<string, string>,
    reqPath: string,
    reqMethod: string,
    clientRes: ServerResponse
  ): Promise<void> {
    const startTime = Date.now();
    const model = this.extractModel(reqBody);
    const requestId = this.generateRequestId();
    const cbEnabled = this.config.circuitBreaker?.enabled !== false;

    // Determine best provider based on model
    let selectedProvider = cbEnabled ? this.providerHealth.getBestProviderForModel(model) : 'anthropic';
    if (!selectedProvider) {
      this.logger.warn(`No healthy provider available for model ${model || 'unknown'}, defaulting to Anthropic`);
      selectedProvider = 'anthropic';
    }

    const primaryProvider = selectedProvider;
    const streamingChunks: string[] = [];
    let headersSent = false;

    // Helper to execute streaming request
    const executeStream = async (provider: 'anthropic' | 'zai' | 'openrouter'): Promise<{ success: boolean; statusCode: number; errorType?: string }> => {
      let config;
      if (provider === 'anthropic') {
        config = this.config.anthropic;
      } else if (provider === 'zai') {
        config = this.config.zai;
      } else {
        config = this.config.openrouter;
      }

      const headers = this.buildProviderHeaders(provider, reqHeaders);
      const normalizedPath = this.normalizeProviderPath(provider, reqPath);
      const body = this.cleanBody(reqBody, provider);
      const timeoutMs = this.config.timeout?.streamingMs || 600000; // 10 minutes default for streaming

      headers["content-length"] = Buffer.byteLength(body).toString();

      this.logger.info(`[${requestId}] → ${this.formatRequestLog(provider, model, true, 'streaming')}`);

      try {
        const res = await new Promise<IncomingMessage>((resolve, reject) => {
          const url = new URL(`${config.baseUrl}${normalizedPath}`);
          const mod = url.protocol === "https:" ? https : http;
          const req = mod.request(url, { method: reqMethod, headers }, resolve);

          // Set timeout for streaming request
          const timeout = setTimeout(() => {
            req.destroy();
            reject(new Error(`Streaming request timeout after ${timeoutMs}ms`));
          }, timeoutMs);

          req.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
          });

          req.on('response', () => {
            clearTimeout(timeout); // Clear timeout on successful response
          });

          if (body) req.write(body);
          req.end();
        });

        const statusCode = res.statusCode || 200;

        // Check for errors - for 4xx/5xx, we need to read the response body first
        if (statusCode >= 400) {
          // Collect error response body to determine error type
          const chunks: Buffer[] = [];
          for await (const chunk of res) {
            chunks.push(chunk);
          }
          const errorBody = Buffer.concat(chunks);

          let errorType: "rate_limit" | "context_window" | "other" | undefined;
          if (statusCode === 429) {
            errorType = 'rate_limit';
          } else if (this.isContextWindowError(errorBody)) {
            errorType = 'context_window';
          } else {
            errorType = 'other';
          }

          if (cbEnabled && errorType) {
            this.providerHealth.recordFailure(provider, errorType);
          }

          // Send error response to client
          if (!clientRes.headersSent) {
            clientRes.writeHead(statusCode, { "Content-Type": "application/json" });
            clientRes.end(errorBody);
            headersSent = true;
          }

          return { success: false, statusCode, errorType };
        }

        // Success - pipe response to client
        this.logger.ok(`[${requestId}] ← ✅ ${statusCode} | completed`);
        if (!clientRes.headersSent) {
          clientRes.writeHead(statusCode, res.headers);
          headersSent = true;
        }

        res.on('data', (chunk) => {
          try {
            streamingChunks.push(chunk.toString());
            if (!clientRes.headersSent) {
              headersSent = true;
            }
            clientRes.write(chunk);
          } catch (writeErr) {
            // Can't write to client - connection might be closed
            // Log but don't throw to avoid crashing the stream
            this.logger.debug(`Error writing to client: ${writeErr instanceof Error ? writeErr.message : 'Unknown'}`);
          }
        });

        res.on('end', async () => {
          try {
            if (!clientRes.headersSent) {
              headersSent = true;
            }
            clientRes.end();
            const latency = Date.now() - startTime;
            if (cbEnabled) {
              this.providerHealth.recordSuccess(provider, latency);
              // Record token usage for quota tracking
              const tokenUsage = UsageTracker.extractStreamingTokenUsage(streamingChunks);
              if (tokenUsage) {
                this.providerHealth.recordTokenUsage(provider, tokenUsage.input_tokens, tokenUsage.output_tokens);
              }
            }
            await this.trackStreamingRequestMetrics(reqMethod, reqPath, startTime, statusCode, false, provider, model, streamingChunks);
          } catch (endErr) {
            // Error during end processing - log but don't throw
            this.logger.debug(`Error in stream end handler: ${endErr instanceof Error ? endErr.message : 'Unknown'}`);
          }
        });

        return { success: true, statusCode };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Unknown";
        if (cbEnabled) {
          this.providerHealth.recordFailure(provider, 'other');
        }

        // If headers were already sent, we can't retry - just log and return success to prevent fallback
        if (headersSent) {
          this.logger.error(`← ❌ ${provider.toUpperCase()} stream error after headers sent: ${errorMsg}`);
          return { success: true, statusCode: 200 }; // Return success to prevent fallback retry
        }

        this.logger.error(`← ❌ ${provider.toUpperCase()} stream error: ${errorMsg}`);
        return { success: false, statusCode: 0, errorType: 'network' };
      }
    };

    // Try primary provider
    const primaryResult = await executeStream(primaryProvider);
    if (primaryResult.success) {
      return;
    }

    // If headers were already sent, we can't try fallback providers
    if (headersSent) {
      this.logger.debug("Headers already sent to client, cannot retry with fallback providers");
      return;
    }

    // Primary failed — try Claude subscription (streaming)
    const cleanedPath = this.cleanPath(reqPath);
    const cleanedBody = this.cleanBody(reqBody);

    if (this.config.claudeSubscription.enabled) {
      const oauthToken = await this.readClaudeOAuthToken();
      if (oauthToken) {
        const trySubscriptionStream = (token: string) =>
          new Promise<IncomingMessage>((resolve, reject) => {
            const subHeaders = this.buildSubscriptionHeaders(reqHeaders, token);
            subHeaders["content-length"] = Buffer.byteLength(cleanedBody).toString();
            const url = new URL(`${this.config.claudeSubscription.baseUrl}${cleanedPath}`);
            const mod = url.protocol === "https:" ? https : http;
            const req = mod.request(url, { method: reqMethod, headers: subHeaders }, resolve);
            req.on("error", reject);
            if (cleanedBody) req.write(cleanedBody);
            req.end();
          });

        this.logger.info(`→ Claude subscription (stream) ${reqMethod} ${cleanedPath}`);
        try {
          let subRes = await trySubscriptionStream(oauthToken);

          if (subRes.statusCode === 401) {
            this.logger.warn("← Claude subscription 401 — re-reading credentials and retrying");
            subRes.resume();
            const freshToken = await this.readClaudeOAuthToken();
            if (freshToken && freshToken !== oauthToken) subRes = await trySubscriptionStream(freshToken);
          }

          if (!this.config.fallbackOnCodes.includes(subRes.statusCode!)) {
            this.logger.ok(`← Claude subscription (stream) ${subRes.statusCode}`);
            if (!clientRes.headersSent) {
              clientRes.writeHead(subRes.statusCode!, subRes.headers);
              headersSent = true;
            }
            subRes.on('data', (chunk) => {
              try {
                streamingChunks.push(chunk.toString());
                clientRes.write(chunk);
              } catch (writeErr) {
                this.logger.debug(`Error writing subscription response: ${writeErr instanceof Error ? writeErr.message : 'Unknown'}`);
              }
            });
            subRes.on('end', async () => {
              try {
                clientRes.end();
                await this.trackStreamingRequestMetrics(reqMethod, reqPath, startTime, subRes.statusCode!, true, 'anthropic', model, streamingChunks);
              } catch (endErr) {
                this.logger.debug(`Error in subscription end handler: ${endErr instanceof Error ? endErr.message : 'Unknown'}`);
              }
            });
            return;
          }
          subRes.resume();
          this.logger.warn(`← Claude subscription ⚠️  ${subRes.statusCode} — trying other provider`);
        } catch (err) {
          this.logger.error(`← Claude subscription ❌ stream error: ${err instanceof Error ? err.message : "Unknown"}`);
        }
      } else {
        this.logger.warn("Claude subscription credentials not found or expired — skipping");
      }
    }

    const fallbackProviders = this.getFallbackProviders(primaryProvider);
    for (const fallbackProvider of fallbackProviders) {
      const fallbackResult = await executeStream(fallbackProvider);
      if (fallbackResult.success) return;
      if (headersSent) return;
    }

    // All providers failed
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "Content-Type": "application/json" });
      clientRes.end(JSON.stringify({ error: { message: "All providers failed" } }));
    }
  }

  /**
   * Track request metrics for non-streaming requests
   */
  private async trackRequestMetrics(
    method: string,
    path: string,
    startTime: number,
    statusCode: number,
    fallback: boolean,
    provider: 'anthropic' | 'zai' | 'openrouter',
    model: string | undefined,
    success: boolean,
    responseBody: Buffer
  ): Promise<void> {
    if (!this.usageTracker.isTrackingEnabled()) return;

    const endTime = Date.now();
    const duration = endTime - startTime;
    const errorMessage = success ? undefined : `HTTP ${statusCode}`;

    // Extract token usage from response
    const tokenUsage = UsageTracker.extractTokenUsage(responseBody.toString());

    const metrics: RequestMetrics = {
      startTime,
      endTime,
      duration,
      provider,
      fallback,
      model,
      statusCode,
      streaming: false,
      success: statusCode < 400,
      errorMessage,
      tokenUsage: tokenUsage || undefined,
    };

    await this.usageTracker.trackRequest(method, path, metrics);
  }

  /**
   * Track streaming request metrics
   */
  private async trackStreamingRequestMetrics(
    method: string,
    path: string,
    startTime: number,
    statusCode: number,
    fallback: boolean,
    provider: 'anthropic' | 'zai' | 'openrouter',
    model: string | undefined,
    chunks: string[]
  ): Promise<void> {
    if (!this.usageTracker.isTrackingEnabled()) return;

    const endTime = Date.now();
    const duration = endTime - startTime;
    const errorMessage = statusCode >= 400 ? `HTTP ${statusCode}` : undefined;

    // Extract token usage from streaming response
    const tokenUsage = UsageTracker.extractStreamingTokenUsage(chunks);

    const metrics: RequestMetrics = {
      startTime,
      endTime,
      duration,
      provider,
      fallback,
      model,
      statusCode,
      streaming: true,
      success: statusCode < 400,
      errorMessage,
      tokenUsage: tokenUsage || undefined,
    };

    await this.usageTracker.trackRequest(method, path, metrics);
  }

  /**
   * Handle incoming request
   */
  private async handleRequest(
    reqBody: string,
    reqHeaders: Record<string, string>,
    reqPath: string,
    reqMethod: string,
    clientRes: ServerResponse
  ): Promise<void> {
    // Health check endpoint
    if (reqPath === "/health" && reqMethod === "GET") {
      const cbEnabled = this.config.circuitBreaker?.enabled !== false;
      const providerStatus = cbEnabled ? this.providerHealth.getAllStatus() : [];
      const bestProvider = cbEnabled ? this.providerHealth.getBestProvider() : 'anthropic';

      clientRes.writeHead(200, { "Content-Type": "application/json" });
      clientRes.end(JSON.stringify({
        status: "healthy",
        service: "Claude Code Proxy",
        version: "1.0.0",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        endpoints: {
          health: "/health",
          config: "/config",
          providers: "/providers",
          usage: "/usage",
          proxy: "/v1/messages"
        },
        config: {
          primary: "Anthropic API",
          fallback1: this.config.claudeSubscription.enabled ? "Claude subscription" : "disabled",
          fallback2: this.config.zai.apiKey ? "Z.AI" : "disabled",
          fallback3: this.config.openrouter.apiKey ? "OpenRouter" : "disabled",
          port: this.config.port,
          models: Object.keys(this.config.modelFallbackMap).length,
          tracking: this.usageTracker.isTrackingEnabled()
        },
        providers: cbEnabled ? {
          best: bestProvider,
          zai: {
            state: providerStatus.find(p => p.provider === 'zai')?.state || 'unknown',
            available: providerStatus.find(p => p.provider === 'zai')?.available || false
          },
          anthropic: {
            state: providerStatus.find(p => p.provider === 'anthropic')?.state || 'unknown',
            available: providerStatus.find(p => p.provider === 'anthropic')?.available || false
          },
          openrouter: {
            state: providerStatus.find(p => p.provider === 'openrouter')?.state || 'unknown',
            available: providerStatus.find(p => p.provider === 'openrouter')?.available || false
          }
        } : undefined
      }));
      return;
    }

    // Provider health status endpoint
    if (reqPath === "/providers" && reqMethod === "GET") {
      const cbEnabled = this.config.circuitBreaker?.enabled !== false;
      if (!cbEnabled) {
        clientRes.writeHead(200, { "Content-Type": "application/json" });
        clientRes.end(JSON.stringify({
          enabled: false,
          message: "Circuit breaker is disabled"
        }));
        return;
      }

      const status = this.providerHealth.getAllStatus();
      clientRes.writeHead(200, { "Content-Type": "application/json" });
      clientRes.end(JSON.stringify({
        enabled: true,
        bestProvider: this.providerHealth.getBestProvider(),
        providers: status.map(s => ({
          provider: s.provider,
          state: s.state,
          available: s.available,
          priority: this.providerHealth.getProviderConfig(s.provider).priority,
          metrics: {
            totalRequests: s.metrics.totalRequests,
            successfulRequests: s.metrics.successfulRequests,
            failedRequests: s.metrics.failedRequests,
            rateLimitHits: s.metrics.rateLimitHits,
            contextWindowErrors: s.metrics.contextWindowErrors,
            consecutiveErrors: s.metrics.consecutiveErrors,
            averageLatency: s.metrics.averageLatency
          },
          quota: s.quota,
          readyAt: s.readyAt ? new Date(s.readyAt).toISOString() : undefined
        }))
      }));
      return;
    }

    // Reset providers endpoint
    if (reqPath === "/providers/reset" && reqMethod === "POST") {
      this.providerHealth.resetAll();
      this.logger.ok("Provider health has been reset - all providers are now available");
      clientRes.writeHead(200, { "Content-Type": "application/json" });
      clientRes.end(JSON.stringify({
        status: "ok",
        message: "All providers have been reset to healthy state",
        providers: ["anthropic", "zai", "openrouter"]
      }));
      return;
    }

    // Provider configuration endpoint
    if (reqPath === "/config" && reqMethod === "GET") {
      const hasAnthropicKey = !!this.config.anthropic.apiKey;
      const hasZaiKey = !!this.config.zai.apiKey;
      const hasOpenRouterKey = !!this.config.openrouter.apiKey;
      const subEnabled = this.config.claudeSubscription.enabled;

      // Mask API keys for security
      const maskKey = (key: string) => key ? `${key.slice(0, 8)}...${key.slice(-4)}` : '';

      clientRes.writeHead(200, { "Content-Type": "application/json" });
      clientRes.end(JSON.stringify({
        providers: {
          anthropic: {
            enabled: hasAnthropicKey,
            apiKey: hasAnthropicKey ? maskKey(this.config.anthropic.apiKey) : undefined,
            baseUrl: this.config.anthropic.baseUrl,
            priority: 1
          },
          claudeSubscription: {
            enabled: subEnabled,
            baseUrl: this.config.claudeSubscription.baseUrl,
            credentialsPath: this.config.claudeSubscription.credentialsPath,
            priority: 2
          },
          zai: {
            enabled: hasZaiKey,
            apiKey: hasZaiKey ? maskKey(this.config.zai.apiKey) : undefined,
            baseUrl: this.config.zai.baseUrl,
            priority: 3
          },
          openrouter: {
            enabled: hasOpenRouterKey,
            apiKey: hasOpenRouterKey ? maskKey(this.config.openrouter.apiKey) : undefined,
            baseUrl: this.config.openrouter.baseUrl,
            priority: 4
          }
        },
        circuitBreaker: {
          enabled: this.config.circuitBreaker?.enabled !== false,
          cooldownMs: this.config.circuitBreaker?.cooldownMs,
          degradedThreshold: this.config.circuitBreaker?.degradedThreshold,
          unavailableThreshold: this.config.circuitBreaker?.unavailableThreshold,
          healthCheckInterval: this.config.circuitBreaker?.healthCheckInterval,
          anthropicWeeklyLimit: this.config.circuitBreaker?.anthropicWeeklyLimit,
          quotaWarningThreshold: this.config.circuitBreaker?.quotaWarningThreshold
        },
        timeout: {
          requestMs: this.config.timeout?.requestMs,
          streamingMs: this.config.timeout?.streamingMs,
          maxRetries: this.config.timeout?.maxRetries,
          retryDelayMs: this.config.timeout?.retryDelayMs
        },
        modelFallbackMap: this.config.modelFallbackMap,
        fallbackOnCodes: this.config.fallbackOnCodes,
        logLevel: this.config.logLevel
      }));
      return;
    }

    // Usage statistics endpoint
    if (reqPath === "/usage" && reqMethod === "GET") {
      await this.handleUsageRequest(clientRes);
      return;
    }

    let isStreaming = false;
    try {
      isStreaming = JSON.parse(reqBody).stream === true;
    } catch {
      // Invalid JSON, assume non-streaming
    }

    if (!isStreaming) {
      const res = await this.proxyRequest(reqBody, reqHeaders, reqPath, reqMethod);
      clientRes.writeHead(res.status, res.headers);
      clientRes.end(res.body);
      return;
    }

    await this.handleStreamingRequest(reqBody, reqHeaders, reqPath, reqMethod, clientRes);
  }

  /**
   * Handle usage statistics request
   */
  private async handleUsageRequest(clientRes: ServerResponse): Promise<void> {
    try {
      const url = new URL(clientRes.req?.url || '', `http://127.0.0.1:${this.config.port}`);
      const days = parseInt(url.searchParams.get('days') || '7', 10);
      const limit = parseInt(url.searchParams.get('limit') || '100', 10);
      
      const [dailyUsage, recentRequests] = await Promise.all([
        this.usageTracker.getDailyUsage(days),
        this.usageTracker.getRecentRequests(limit, 0)
      ]);

      clientRes.writeHead(200, { "Content-Type": "application/json" });
      clientRes.end(JSON.stringify({
        daily_usage: dailyUsage,
        recent_requests: recentRequests,
        tracking_enabled: this.usageTracker.isTrackingEnabled(),
        generated_at: new Date().toISOString()
      }));
    } catch (error) {
      clientRes.writeHead(500, { "Content-Type": "application/json" });
      clientRes.end(JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error"
      }));
    }
  }

  /**
   * Print startup banner with enhanced visibility
   */
  private printStartupBanner(port: number): void {
    console.log('');
    console.log('\x1b[1m\x1b[36m' + '═'.repeat(60) + '\x1b[0m');
    console.log('\x1b[1m\x1b[35m' + ' ▄█████ ▄█████   █████▄ █████▄  ▄████▄ ██  ██ ██  ██ ' + '\x1b[0m');
    console.log('\x1b[1m\x1b[35m' + ' ██     ██       ██▄▄█▀ ██▄▄██▄ ██  ██  ████   ▀██▀  ' + '\x1b[0m');
    console.log('\x1b[1m\x1b[35m' + ' ▀█████ ▀█████   ██     ██   ██ ▀████▀ ██  ██   ██   ' + '\x1b[0m');
    console.log('\x1b[1m\x1b[36m' + '═'.repeat(60) + '\x1b[0m');
    console.log('');

    // Server Info
    console.log('\x1b[1m\x1b[32m' + '● Server Information' + '\x1b[0m');
    console.log(`  ├─ Status: \x1b[32m● Running\x1b[0m`);
    console.log(`  ├─ Port: ${port}`);
    console.log(`  ├─ URL: \x1b[36mhttp://127.0.0.1:${port}\x1b[0m`);
    console.log(`  ├─ Version: 1.0.0`);
    console.log(`  └─ Node.js: ${process.version}`);
    console.log('');

    // Provider Configuration
    console.log('\x1b[1m\x1b[33m' + '● Provider Configuration' + '\x1b[0m');

    const cbEnabled = this.config.circuitBreaker?.enabled !== false;
    const bestProvider = cbEnabled ? this.providerHealth.getBestProvider() : 'anthropic';

    console.log(`  ├─ Circuit Breaker: ${cbEnabled ? '\x1b[32mEnabled\x1b[0m' : '\x1b[31mDisabled\x1b[0m'}`);
    const providerLabel =
      bestProvider === "anthropic"
        ? "Anthropic API"
        : bestProvider === "zai"
          ? "Z.AI"
          : bestProvider === "openrouter"
            ? "OpenRouter"
            : "none";
    console.log(`  ├─ Active Provider: \x1b[36m${providerLabel}\x1b[0m`);
    console.log(`  ├─ Provider Priority:`);

    const subEnabled = this.config.claudeSubscription.enabled;
    const hasAnthropicKey = !!this.config.anthropic.apiKey;
    const hasZaiKey = !!this.config.zai.apiKey;
    const hasOpenRouterKey = !!this.config.openrouter.apiKey;

    // Get provider states if circuit breaker is enabled
    let anthropicState = '';
    let zaiState = '';
    let openRouterState = '';
    if (cbEnabled) {
      const anthropicStatus = this.providerHealth.getAllStatus().find(s => s.provider === 'anthropic');
      const zaiStatus = this.providerHealth.getAllStatus().find(s => s.provider === 'zai');
      const openRouterStatus = this.providerHealth.getAllStatus().find(s => s.provider === 'openrouter');

      if (anthropicStatus) {
        const stateColor = anthropicStatus.state === 'healthy' ? '\x1b[32m' :
                          anthropicStatus.state === 'degraded' ? '\x1b[33m' : '\x1b[31m';
        anthropicState = `(${stateColor}${anthropicStatus.state}\x1b[0m)`;
      }
      if (zaiStatus) {
        const stateColor = zaiStatus.state === 'healthy' ? '\x1b[32m' :
                          zaiStatus.state === 'degraded' ? '\x1b[33m' : '\x1b[31m';
        zaiState = `(${stateColor}${zaiStatus.state}\x1b[0m)`;
      }
      if (openRouterStatus) {
        const stateColor = openRouterStatus.state === 'healthy' ? '\x1b[32m' :
                          openRouterStatus.state === 'degraded' ? '\x1b[33m' : '\x1b[31m';
        openRouterState = `(${stateColor}${openRouterStatus.state}\x1b[0m)`;
      }
    }

    console.log(`  │   ├─ 1. ${hasAnthropicKey ? `\x1b[32m✓\x1b[0m Anthropic API ${anthropicState}` : '\x1b[90m✗ Anthropic API (no key)\x1b[0m'}`);
    console.log(`  │   ├─ 2. ${subEnabled ? '\x1b[32m✓\x1b[0m Claude Subscription' : '\x1b[90m✗ Claude Subscription (disabled)\x1b[0m'}`);
    console.log(`  │   ├─ 3. ${hasZaiKey ? `\x1b[32m✓\x1b[0m Z.AI ${zaiState}` : '\x1b[90m✗ Z.AI (no key)\x1b[0m'}`);
    console.log(`  │   └─ 4. ${hasOpenRouterKey ? `\x1b[32m✓\x1b[0m OpenRouter ${openRouterState}` : '\x1b[90m✗ OpenRouter (no key)\x1b[0m'}`);

    if (cbEnabled) {
      const quotaLimit = this.config.circuitBreaker?.anthropicWeeklyLimit || 0;
      const quotaThreshold = this.config.circuitBreaker?.quotaWarningThreshold || 80;

      if (quotaLimit > 0) {
        // Get current quota usage
        const anthropicQuota = this.providerHealth.getQuotaInfo('anthropic');
        if (anthropicQuota) {
          const usedPercent = anthropicQuota.percentageUsed;
          const remaining = anthropicQuota.remaining;
          const statusColor = usedPercent >= quotaThreshold ? '\x1b[31m' : usedPercent >= quotaThreshold * 0.8 ? '\x1b[33m' : '\x1b[32m';

          console.log(`  ├─ Anthropic Quota:`);
          console.log(`  │   ├─ Limit: ${quotaLimit.toLocaleString()} tokens/week`);
          console.log(`  │   ├─ Used: ${anthropicQuota.used.toLocaleString()} tokens (${statusColor}${usedPercent.toFixed(1)}%\x1b[0m)`);
          console.log(`  │   ├─ Remaining: ${remaining.toLocaleString()} tokens`);
          console.log(`  │   ├─ Swap Threshold: ${quotaThreshold}%`);
          console.log(`  │   └─ Week Reset: Monday 00:00:00 UTC`);
        } else {
          console.log(`  ├─ Anthropic Quota: ${quotaLimit.toLocaleString()} tokens/week (swap at ${quotaThreshold}%)`);
        }
      } else {
        console.log(`  ├─ Anthropic Quota: \x1b[90mNo limit set\x1b[0m (set ANTHROPIC_WEEKLY_LIMIT to enable)`);
      }

      const cooldown = this.config.circuitBreaker?.cooldownMs || 0;
      const degraded = this.config.circuitBreaker?.degradedThreshold || 0;
      const unavailable = this.config.circuitBreaker?.unavailableThreshold || 0;

      console.log(`  └─ Circuit Breaker:`);
      console.log(`      ├─ Cooldown: ${cooldown}ms`);
      console.log(`      ├─ Degraded after: ${degraded} errors`);
      console.log(`      └─ Unavailable after: ${unavailable} errors`);
    }
    console.log('');

    // Model Configuration
    const modelCount = Object.keys(this.config.modelFallbackMap).length;
    console.log('\x1b[1m\x1b[34m' + `● Model Configuration (${modelCount} mappings)` + '\x1b[0m');

    const notableModels = [
      'claude-sonnet-4-6',
      'claude-opus-4-6',
      'claude-haiku-4-5-20251001',
      'glm-5',
      'glm-4.7'
    ];

    console.log(`  └─ Key mappings:`);
    for (const model of notableModels) {
      if (this.config.modelFallbackMap[model]) {
        console.log(`      ${model} → \x1b[36m${this.config.modelFallbackMap[model]}\x1b[0m`);
      }
    }
    console.log('');

    // Timeout Configuration
    console.log('\x1b[1m\x1b[35m' + '● Timeout Configuration' + '\x1b[0m');
    const reqTimeout = this.config.timeout?.requestMs || 300000;
    const streamTimeout = this.config.timeout?.streamingMs || 600000;
    const maxRetries = this.config.timeout?.maxRetries || 3;
    const retryDelay = this.config.timeout?.retryDelayMs || 1000;

    console.log(`  ├─ Regular Requests: ${reqTimeout}ms (${(reqTimeout / 1000).toFixed(1)}s)`);
    console.log(`  ├─ Streaming Requests: ${streamTimeout}ms (${(streamTimeout / 1000).toFixed(1)}s)`);
    console.log(`  ├─ Max Retries: ${maxRetries}`);
    console.log(`  └─ Retry Delay: ${retryDelay}ms (exponential backoff)`);
    console.log('');

    // Database Configuration
    const dbEnabled = this.usageTracker.isTrackingEnabled();
    console.log('\x1b[1m\x1b[36m' + '● Database & Tracking' + '\x1b[0m');
    console.log(`  └─ Usage Tracking: ${dbEnabled ? '\x1b[32m● Enabled (PostgreSQL)\x1b[0m' : '\x1b[90m○ Disabled\x1b[0m'}`);
    console.log('');

    // API Endpoints
    console.log('\x1b[1m\x1b[32m' + '● API Endpoints' + '\x1b[0m');
    console.log(`  ├─ Health:     \x1b[36mGET  http://127.0.0.1:${port}/health\x1b[0m`);
    console.log(`  ├─ Config:     \x1b[36mGET  http://127.0.0.1:${port}/config\x1b[0m`);
    console.log(`  ├─ Providers:  \x1b[36mGET  http://127.0.0.1:${port}/providers\x1b[0m`);
    console.log(`  ├─ Reset:      \x1b[36mPOST http://127.0.0.1:${port}/providers/reset\x1b[0m`);
    console.log(`  ├─ Usage:      \x1b[36mGET  http://127.0.0.1:${port}/usage\x1b[0m`);
    console.log(`  └─ Proxy:      \x1b[36mPOST http://127.0.0.1:${port}/v1/messages\x1b[0m`);
    console.log('');

    console.log('\x1b[1m\x1b[32m' + '✓ Claude Code Proxy is ready!' + '\x1b[0m');
    console.log('\x1b[1m\x1b[36m' + '═'.repeat(60) + '\x1b[0m');
    console.log('');
  }

  /**
   * Start the proxy server
   */
  public async start(): Promise<void> {
    const port = this.config.port;

    // Initialize database if tracking is enabled
    if (this.usageTracker.isTrackingEnabled()) {
      try {
        await this.usageTracker.initialize();
        this.logger.ok("Database tracking initialized");
      } catch {
        this.logger.error("Failed to initialize database tracking");
        this.logger.error("Continuing without database tracking...");
      }
    }

    this.server.listen(port, "0.0.0.0", () => {
      this.printStartupBanner(port);
    });
  }

  /**
   * Stop the proxy server
   */
  public async stop(): Promise<void> {
    this.providerHealth.destroy();
    await this.usageTracker.close();
    this.server.close(() => {
      this.logger.info("Server stopped");
    });
  }
}

// Start server if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const proxy = new ClaudeCodeProxy();
  proxy.start().catch(error => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
}
