#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ProxyConfig, RequestOptions, HttpResponse, LogLevel, RequestMetrics } from "./types.js";
import { UsageTracker } from "./database/tracker.js";
import { ProviderHealth, ProviderState } from "./provider-health.js";

/**
 * Default configuration for the proxy server
 */
const DEFAULT_CONFIG: ProxyConfig = {
  port: parseInt(process.env.PROXY_PORT || "4181", 10),
  zai: {
    baseUrl: "https://api.z.ai/api/anthropic",
    apiKey: process.env.ZAI_API_KEY || "",
  },
  claudeSubscription: {
    baseUrl: "https://api.claude.ai/api",
    credentialsPath: process.env.CLAUDE_CREDENTIALS_PATH ||
      path.join(os.homedir(), ".claude", ".credentials.json"),
    enabled: process.env.CLAUDE_SUBSCRIPTION_ENABLED !== "false",
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    apiKey: process.env.ANTHROPIC_API_KEY || "",
  },
  modelFallbackMap: {
    // GLM models -> Sonnet (latest)
    "glm-5": "claude-sonnet-4-6",
    "glm-4.7": "claude-sonnet-4-6",
    "glm-4.6": "claude-sonnet-4-6",
    "glm-4.5": "claude-sonnet-4-6",
    "glm-4.5-air": "claude-haiku-4-5-20251001",
    // Latest Claude models -> use directly
    "claude-sonnet-4-6": "claude-sonnet-4-6",
    "claude-opus-4-6": "claude-sonnet-4-6",
    "claude-haiku-4-5": "claude-haiku-4-5-20251001",
    // Legacy/unmapped models -> Sonnet (latest)
    "claude-opus": "claude-sonnet-4-6",
    "claude-sonnet": "claude-sonnet-4-6",
    "claude-haiku": "claude-haiku-4-5-20251001",
  },
  fallbackOnCodes: [429, 503, 502],
  logLevel: "info",
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

  constructor(config: Partial<ProxyConfig> = {}) {
    this.config = this.mergeConfig(config);
    this.logger = new Logger(this.config.logLevel);
    this.usageTracker = new UsageTracker(this.config.database);

    // Initialize provider health tracker
    const cb = this.config.circuitBreaker || DEFAULT_CONFIG.circuitBreaker!;
    this.providerHealth = new ProviderHealth(
      { baseUrl: this.config.zai.baseUrl, apiKey: this.config.zai.apiKey },
      { baseUrl: this.config.anthropic.baseUrl, apiKey: this.config.anthropic.apiKey },
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
      zai: { ...DEFAULT_CONFIG.zai, ...config.zai },
      claudeSubscription: { ...DEFAULT_CONFIG.claudeSubscription, ...config.claudeSubscription },
      anthropic: { ...DEFAULT_CONFIG.anthropic, ...config.anthropic },
      modelFallbackMap: { ...DEFAULT_CONFIG.modelFallbackMap, ...config.modelFallbackMap },
      circuitBreaker: { ...DEFAULT_CONFIG.circuitBreaker, ...config.circuitBreaker },
      database: config.database || DEFAULT_CONFIG.database,
    };
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
    const cleanedBody = this.cleanBody(reqBody);

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
          this.logger.error(`← Claude subscription ${subRes.status}: ${subRes.body.toString().slice(0, 300)}`);
        } else {
          this.logger.ok(`← Claude subscription ${subRes.status}`);
        }
        return subRes;
      }
      this.logger.warn(`← Claude subscription ${subRes.status} — trying next provider`);
      return undefined;
    } catch (err) {
      this.logger.error(`← Claude subscription error: ${err instanceof Error ? err.message : "Unknown"} — fallback`);
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
   * Perform HTTP/HTTPS request
   */
  private async httpRequest(url: string, options: RequestOptions): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const mod = parsedUrl.protocol === "https:" ? https : http;

      const req = mod.request(
        parsedUrl,
        { method: options.method || "GET", headers: options.headers || {} },
        (res) => {
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

      req.on("error", reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  /**
   * Map model name using fallback configuration
   */
  private mapModel(model: string): string {
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
   */
  private isContextWindowError(body: Buffer): boolean {
    try {
      const bodyStr = body.toString();
      const lower = bodyStr.toLowerCase();
      return lower.includes("context") && (
        lower.includes("window") ||
        lower.includes("limit") ||
        lower.includes("exceed")
      );
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
  private cleanBody(bodyStr: string): string {
    try {
      const body = JSON.parse(bodyStr);
      const allowedFields = [
        "model", "messages", "max_tokens", "stop_sequences", "stream",
        "system", "temperature", "top_p", "top_k", "metadata", "tools", "tool_choice"
      ];

      const cleaned: Record<string, unknown> = {};
      for (const field of allowedFields) {
        if (body[field] !== undefined) cleaned[field] = body[field];
      }

      // Remap model if present
      if (cleaned.model && typeof cleaned.model === "string") {
        const original = cleaned.model;
        cleaned.model = this.mapModel(cleaned.model);
        this.logger.info(`  model remap: ${original} → ${cleaned.model}`);
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
  private async performProviderHealthCheck(provider: 'zai' | 'anthropic'): Promise<boolean> {
    try {
      const config = provider === 'zai' ? this.config.zai : this.config.anthropic;
      const url = `${config.baseUrl}/v1/messages`;

      const headers: Record<string, string> = provider === 'zai' ? {
        host: new URL(config.baseUrl).host,
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      } : {
        host: new URL(config.baseUrl).host,
        "x-api-key": config.apiKey,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      };

      // Minimal test request
      const testBody = JSON.stringify({
        model: "claude-haiku-4-5-20251001",
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
  private buildProviderHeaders(provider: 'zai' | 'anthropic', reqHeaders: Record<string, string>): Record<string, string> {
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
    } else {
      // Anthropic headers
      return this.cleanHeaders(reqHeaders);
    }
  }

  /**
   * Make a request to a specific provider
   */
  private async requestProvider(
    provider: 'zai' | 'anthropic',
    reqBody: string,
    reqHeaders: Record<string, string>,
    reqPath: string,
    reqMethod: string
  ): Promise<{ response: HttpResponse; errorType?: 'rate_limit' | 'context_window' | 'other' }> {
    const config = provider === 'zai' ? this.config.zai : this.config.anthropic;
    const url = `${config.baseUrl}${reqPath}`;
    const headers = this.buildProviderHeaders(provider, reqHeaders);

    // For Anthropic, clean the body
    const body = provider === 'anthropic' ? this.cleanBody(reqBody) : reqBody;
    if (provider === 'anthropic') {
      headers["content-length"] = Buffer.byteLength(body).toString();
    }

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
    const cbEnabled = this.config.circuitBreaker?.enabled !== false;

    // Determine best provider (circuit breaker enabled)
    let selectedProvider = cbEnabled ? this.providerHealth.getBestProvider() : 'zai';

    // Default to Z.AI if circuit breaker is disabled or no provider selected
    if (!selectedProvider) {
      this.logger.warn(`No healthy provider available, trying Z.AI as fallback`);
      selectedProvider = 'zai';
    }

    const primaryProvider = selectedProvider;
    this.logger.info(`→ ${primaryProvider.toUpperCase()} ${reqMethod} ${reqPath}`);

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
        this.logger.ok(`← ${primaryProvider.toUpperCase()} ${response.status}`);
        await this.trackRequestMetrics(reqMethod, reqPath, startTime, response.status, false, primaryProvider, model, false, response.body);
        return response;
      }

      const reason = errorType === 'context_window' ? "context window limit" :
                     errorType === 'rate_limit' ? "rate limit" :
                     `HTTP ${response.status}`;
      this.logger.warn(`← ${primaryProvider.toUpperCase()} ${reason} — trying subscription`);

      // Try Claude subscription before the other API provider
      const subResult = await this.trySubscriptionRequest(reqBody, reqHeaders, reqPath, reqMethod);
      if (subResult) {
        await this.trackRequestMetrics(reqMethod, reqPath, startTime, subResult.status, true, 'anthropic', model, false, subResult.body);
        return subResult;
      }

      // Try the other provider (zai ↔ anthropic)
      const fallbackProvider = primaryProvider === 'zai' ? 'anthropic' : 'zai';
      this.logger.info(`→ ${fallbackProvider.toUpperCase()} ${reqMethod} ${reqPath}`);

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
          // Record token usage for quota tracking
          const tokenUsage = UsageTracker.extractTokenUsage(fallbackRes.body.toString());
          if (tokenUsage) {
            this.providerHealth.recordTokenUsage(fallbackProvider, tokenUsage.input_tokens, tokenUsage.output_tokens);
          }
        }
        this.logger.ok(`← ${fallbackProvider.toUpperCase()} ${fallbackRes.status}`);
        await this.trackRequestMetrics(reqMethod, reqPath, startTime, fallbackRes.status, true, fallbackProvider, model, false, fallbackRes.body);
        return fallbackRes;
      }

      // Both providers failed
      if (cbEnabled) {
        const fbErrorType = fallbackRes.status === 429 ? 'rate_limit' :
                           this.isContextWindowError(fallbackRes.body) ? 'context_window' : 'other';
        this.providerHealth.recordFailure(fallbackProvider, fbErrorType, fallbackRes.status);
      }

      this.logger.error(`← ${fallbackProvider.toUpperCase()} ${fallbackRes.status}: ${fallbackRes.body.toString().slice(0, 300)}`);
      await this.trackRequestMetrics(reqMethod, reqPath, startTime, fallbackRes.status, true, fallbackProvider, model, false, fallbackRes.body);
      return fallbackRes;

    } catch (err) {
      // Network error - record failure and try fallback
      if (cbEnabled) {
        this.providerHealth.recordFailure(primaryProvider, 'other');
      }

      this.logger.error(`← ${primaryProvider.toUpperCase()} error: ${err instanceof Error ? err.message : "Unknown"} — trying subscription`);

      const subResult = await this.trySubscriptionRequest(reqBody, reqHeaders, reqPath, reqMethod);
      if (subResult) {
        await this.trackRequestMetrics(reqMethod, reqPath, startTime, subResult.status, true, 'anthropic', model, false, subResult.body);
        return subResult;
      }

      const fallbackProvider = primaryProvider === 'zai' ? 'anthropic' : 'zai';
      this.logger.info(`→ ${fallbackProvider.toUpperCase()} ${reqMethod} ${reqPath}`);

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
            // Record token usage for quota tracking
            const tokenUsage = UsageTracker.extractTokenUsage(fallbackRes.body.toString());
            if (tokenUsage) {
              this.providerHealth.recordTokenUsage(fallbackProvider, tokenUsage.input_tokens, tokenUsage.output_tokens);
            }
          }
          this.logger.ok(`← ${fallbackProvider.toUpperCase()} ${fallbackRes.status}`);
          await this.trackRequestMetrics(reqMethod, reqPath, startTime, fallbackRes.status, true, fallbackProvider, model, false, fallbackRes.body);
          return fallbackRes;
        }

        if (cbEnabled) {
          const fbErrorType = fallbackRes.status === 429 ? 'rate_limit' :
                             this.isContextWindowError(fallbackRes.body) ? 'context_window' : 'other';
          this.providerHealth.recordFailure(fallbackProvider, fbErrorType, fallbackRes.status);
        }

        this.logger.error(`← ${fallbackProvider.toUpperCase()} ${fallbackRes.status}`);
        await this.trackRequestMetrics(reqMethod, reqPath, startTime, fallbackRes.status, true, fallbackProvider, model, false, fallbackRes.body);
        return fallbackRes;

      } catch (fallbackErr) {
        if (cbEnabled) {
          this.providerHealth.recordFailure(fallbackProvider, 'other');
        }
        this.logger.error(`← ${fallbackProvider.toUpperCase()} error: ${fallbackErr instanceof Error ? fallbackErr.message : "Unknown"}`);
        throw fallbackErr;
      }
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
    const cbEnabled = this.config.circuitBreaker?.enabled !== false;

    // Determine best provider
    let selectedProvider = cbEnabled ? this.providerHealth.getBestProvider() : 'zai';
    if (!selectedProvider) {
      selectedProvider = 'zai';
    }

    const primaryProvider = selectedProvider;
    const streamingChunks: string[] = [];

    // Helper to execute streaming request
    const executeStream = async (provider: 'zai' | 'anthropic'): Promise<{ success: boolean; statusCode: number; errorType?: string }> => {
      const config = provider === 'zai' ? this.config.zai : this.config.anthropic;
      const headers = this.buildProviderHeaders(provider, reqHeaders);
      const body = provider === 'anthropic' ? this.cleanBody(reqBody) : reqBody;

      if (provider === 'anthropic') {
        headers["content-length"] = Buffer.byteLength(body).toString();
      }

      this.logger.info(`→ ${provider.toUpperCase()} (stream) ${reqMethod} ${reqPath}`);

      try {
        const res = await new Promise<IncomingMessage>((resolve, reject) => {
          const url = new URL(`${config.baseUrl}${reqPath}`);
          const mod = url.protocol === "https:" ? https : http;
          const req = mod.request(url, { method: reqMethod, headers }, resolve);
          req.on("error", reject);
          if (body) req.write(body);
          req.end();
        });

        const statusCode = res.statusCode || 200;

        // Check for errors
        let errorType: string | undefined;
        if (statusCode >= 400) {
          if (statusCode === 429) {
            errorType = 'rate_limit';
          } else if (this.isContextWindowError(Buffer.from(''))) {
            errorType = 'context_window';
          } else {
            errorType = 'other';
          }

          if (cbEnabled && errorType) {
            this.providerHealth.recordFailure(provider, errorType as any, statusCode);
          }

          return { success: false, statusCode, errorType };
        }

        // Success - pipe response to client
        this.logger.ok(`← ${provider.toUpperCase()} (stream) ${statusCode}`);
        clientRes.writeHead(statusCode, res.headers);

        res.on('data', (chunk) => {
          streamingChunks.push(chunk.toString());
          clientRes.write(chunk);
        });

        res.on('end', async () => {
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
        });

        return { success: true, statusCode };
      } catch (err) {
        if (cbEnabled) {
          this.providerHealth.recordFailure(provider, 'other');
        }
        this.logger.error(`← ${provider.toUpperCase()} stream error: ${err instanceof Error ? err.message : "Unknown"}`);
        return { success: false, statusCode: 0, errorType: 'network' };
      }
    };

    // Try primary provider
    const primaryResult = await executeStream(primaryProvider);
    if (primaryResult.success) {
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
            clientRes.writeHead(subRes.statusCode!, subRes.headers);
            subRes.on('data', (chunk) => { streamingChunks.push(chunk.toString()); clientRes.write(chunk); });
            subRes.on('end', async () => {
              clientRes.end();
              await this.trackStreamingRequestMetrics(reqMethod, reqPath, startTime, subRes.statusCode!, true, 'anthropic', model, streamingChunks);
            });
            return;
          }
          subRes.resume();
          this.logger.warn(`← Claude subscription ${subRes.statusCode} — trying other provider`);
        } catch (err) {
          this.logger.error(`← Claude subscription stream error: ${err instanceof Error ? err.message : "Unknown"}`);
        }
      } else {
        this.logger.warn("Claude subscription credentials not found or expired — skipping");
      }
    }

    // Try the other provider (zai ↔ anthropic)
    const fallbackProvider = primaryProvider === 'zai' ? 'anthropic' : 'zai';
    const fallbackResult = await executeStream(fallbackProvider);
    if (fallbackResult.success) return;

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
    provider: 'zai' | 'anthropic',
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
    provider: 'zai' | 'anthropic',
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
      const bestProvider = cbEnabled ? this.providerHealth.getBestProvider() : 'zai';

      clientRes.writeHead(200, { "Content-Type": "application/json" });
      clientRes.end(JSON.stringify({
        status: "healthy",
        service: "Claude Code Proxy",
        version: "1.0.0",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        endpoints: {
          health: "/health",
          proxy: "/v1/messages",
          usage: "/usage",
          providers: "/providers"
        },
        config: {
          primary: "Z.AI",
          fallback1: this.config.claudeSubscription.enabled ? "Claude subscription" : "disabled",
          fallback2: this.config.anthropic.apiKey ? "Anthropic API" : "disabled",
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
      const url = new URL(clientRes.req?.url || '', `http://localhost:${this.config.port}`);
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
   * Start the proxy server
   */
  public async start(): Promise<void> {
    const port = this.config.port;
    
    // Initialize database if tracking is enabled
    if (this.usageTracker.isTrackingEnabled()) {
      try {
        await this.usageTracker.initialize();
        this.logger.ok("Database tracking initialized");
      } catch (error) {
        this.logger.error("Failed to initialize database tracking");
        this.logger.error("Continuing without database tracking...");
      }
    }

    const subToken = this.config.claudeSubscription.enabled
      ? await this.readClaudeOAuthToken()
      : undefined;
    const subStatus = !this.config.claudeSubscription.enabled
      ? "Claude subscription (disabled)"
      : subToken ? "Claude subscription ✓" : "Claude subscription (no credentials)";
    const apiStatus = this.config.anthropic.apiKey ? "Anthropic API ✓" : "Anthropic API (no key)";

    this.server.listen(port, () => {
      this.logger.ok(`Claude Code Proxy listening on http://localhost:${port}`);
      const cbEnabled = this.config.circuitBreaker?.enabled !== false;
      const quotaLimit = this.config.circuitBreaker?.anthropicWeeklyLimit || 0;
      const quotaThreshold = this.config.circuitBreaker?.quotaWarningThreshold || 80;

      if (cbEnabled) {
        this.logger.info(`Circuit breaker enabled - Anthropic (primary) | Z.AI (fallback)`);
        if (quotaLimit > 0) {
          this.logger.info(`Anthropic weekly quota: ${quotaLimit} tokens (fallback at ${quotaThreshold}%)`);
        }
        this.logger.info(`Provider health available at http://localhost:${port}/providers`);
      }
      this.logger.info(`Subscription fallback: ${subStatus} | Direct API: ${apiStatus}`);
      this.logger.info(`Model mappings: ${Object.keys(this.config.modelFallbackMap).length} models configured`);
      this.logger.info(`Health check available at http://localhost:${port}/health`);
      this.logger.info(`Usage stats available at http://localhost:${port}/usage`);
      if (this.usageTracker.isTrackingEnabled()) {
        this.logger.ok(`Request tracking enabled with PostgreSQL`);
      }
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
