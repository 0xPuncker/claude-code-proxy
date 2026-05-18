#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ProxyConfig, RequestOptions, HttpResponse, LogLevel, RequestMetrics } from "./types.js";
import { UsageTracker } from "./database/tracker.js";
import { ProviderHealth } from "./provider-health.js";

const _pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../package.json");
const PROXY_VERSION: string = JSON.parse(fs.readFileSync(_pkgPath, "utf-8")).version ?? "0.0.0";

function loadEnvFile(filePath = path.join(process.cwd(), ".env")): void {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function resolveHomePath(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

loadEnvFile();

/**
 * Default configuration for the proxy server
 */
const DEFAULT_CONFIG: ProxyConfig = {
  port: parseInt(process.env.PROXY_PORT || "4181", 10),
  // Primary: Anthropic API (Claude models)
  anthropic: {
    baseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
    apiKey: process.env.ANTHROPIC_API_KEY || "",
  },
  // Secondary: Z.AI API (GLM models)
  zai: {
    baseUrl: process.env.ZAI_BASE_URL || "https://api.z.ai/api/anthropic",
    apiKey: process.env.ZAI_API_KEY || "",
  },
  // Fallback: OpenRouter (free models)
  openrouter: {
    baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY || "",
  },
  claudeSubscription: {
    baseUrl: process.env.CLAUDE_SUBSCRIPTION_BASE_URL || "https://api.anthropic.com",
    credentialsPath: resolveHomePath(
      process.env.CLAUDE_CREDENTIALS_PATH ||
      path.join(os.homedir(), ".claude", ".credentials.json")
    ),
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
  fallbackOnCodes: [429, 503, 502, 530],
  logLevel: (process.env.LOG_LEVEL || "info") as ProxyConfig['logLevel'],
  timeout: {
    requestMs: parseInt(process.env.API_TIMEOUT_MS || "300000", 10),      // 5 minutes default
    streamingMs: parseInt(process.env.API_STREAMING_TIMEOUT_MS || "600000", 10), // 10 minutes default
    idleMs: parseInt(process.env.API_STREAM_IDLE_TIMEOUT_MS || "30000", 10),     // 30s per-chunk idle default
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
  private buffer: Array<{ timestamp: string; level: string; message: string }> = [];
  private readonly bufferSize = 500;
  private subscribers: Set<ServerResponse> = new Set();

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

    const entry = { timestamp: new Date().toISOString(), level: levelStr, message: msg };
    this.buffer.push(entry);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();

    const line = `data: ${JSON.stringify(entry)}\n\n`;
    for (const res of this.subscribers) {
      try { res.write(line); } catch { this.subscribers.delete(res); }
    }
  }

  getRecentLogs(limit = 200): Array<{ timestamp: string; level: string; message: string }> {
    return this.buffer.slice(-limit);
  }

  subscribe(res: ServerResponse): () => void {
    this.subscribers.add(res);
    return () => this.subscribers.delete(res);
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
      const entry = { timestamp: new Date().toISOString(), level: "ok", message: msg };
      this.buffer.push(entry);
      if (this.buffer.length > this.bufferSize) this.buffer.shift();
      const line = `data: ${JSON.stringify(entry)}\n\n`;
      for (const res of this.subscribers) {
        try { res.write(line); } catch { this.subscribers.delete(res); }
      }
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
  private debugRequestDetails(reqBody: string): string {
    try {
      const b = JSON.parse(reqBody);
      const parts: string[] = [];
      if (b.model) parts.push(`model=${b.model}`);
      if (b.max_tokens) parts.push(`max_tokens=${b.max_tokens}`);
      const msgCount = Array.isArray(b.messages) ? b.messages.length : 0;
      parts.push(`messages=${msgCount}`);
      if (b.system) parts.push('system=yes');
      if (b.stream) parts.push('stream=true');
      if (b.thinking?.type === 'enabled') parts.push(`thinking=${b.thinking.budget_tokens}`);
      return parts.join(' | ');
    } catch {
      return '(unparseable body)';
    }
  }

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

      if (subRes.status < 400) {
        this.logger.ok(`← Claude subscription ${subRes.status}`);
        return subRes;
      }

      const details = subRes.body.toString().slice(0, 300);
      const message = `← Claude subscription ❌ ${subRes.status}: ${details} — trying next provider`;
      if (this.config.fallbackOnCodes.includes(subRes.status)) {
        this.logger.warn(message);
      } else {
        this.logger.error(message);
      }
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
  private async httpRequest(
    url: string,
    options: RequestOptions,
    timeoutMs?: number,
    maxRetriesOverride?: number
  ): Promise<HttpResponse> {
    const timeout = timeoutMs || this.config.timeout?.requestMs || 300000; // 5 minutes default
    const maxRetries = maxRetriesOverride ?? this.config.timeout?.maxRetries ?? 3;
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
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            clearTimeout(timeout);
            resolve({
              status: res.statusCode || 200,
              headers: res.headers as Record<string, string>,
              body: Buffer.concat(chunks),
            });
          });
          res.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
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
      "claude-sonnet-4-6": "~anthropic/claude-sonnet-latest",
      "claude-opus-4-6": "~anthropic/claude-sonnet-latest",
      "claude-haiku-4-5-20251001": "~anthropic/claude-haiku-latest",
      "claude-sonnet-4-5": "~anthropic/claude-sonnet-latest",
      "claude-opus": "~anthropic/claude-sonnet-latest",
      "claude-sonnet": "~anthropic/claude-sonnet-latest",
      "claude-haiku": "~anthropic/claude-haiku-latest",
      "openrouter-free":
        this.config.modelFallbackMap["openrouter-free"] ||
        "openrouter/auto",
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

  private normalizeOpenRouterResponse(response: HttpResponse): HttpResponse {
    try {
      const raw = JSON.parse(response.body.toString());
      if (raw?.type !== "message" || raw?.role !== "assistant") return response;

      const content = Array.isArray(raw.content)
        ? raw.content
          .map((block: Record<string, unknown>) => {
            if (block?.type === "text") {
              return { type: "text", text: String(block.text || "") };
            }
            if (block?.type === "tool_use") {
              return {
                type: "tool_use",
                id: String(block.id || ""),
                name: String(block.name || ""),
                input: block.input && typeof block.input === "object" ? block.input : {},
              };
            }
            return undefined;
          })
          .filter(Boolean)
        : typeof raw.content === "string"
          ? [{ type: "text", text: raw.content }]
          : [];

      const usage = raw.usage && typeof raw.usage === "object" ? raw.usage : {};
      const normalized = {
        id: String(raw.id || `msg_${Date.now()}`),
        type: "message",
        role: "assistant",
        content,
        model: String(raw.model || "openrouter"),
        stop_reason: typeof raw.stop_reason === "string" ? raw.stop_reason : "end_turn",
        stop_sequence: raw.stop_sequence ?? null,
        usage: {
          input_tokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0,
          output_tokens: Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0,
          cache_creation_input_tokens: Number.isFinite(usage.cache_creation_input_tokens)
            ? usage.cache_creation_input_tokens
            : 0,
          cache_read_input_tokens: Number.isFinite(usage.cache_read_input_tokens)
            ? usage.cache_read_input_tokens
            : 0,
        },
      };

      const body = Buffer.from(JSON.stringify(normalized));
      const headers = { ...response.headers };
      delete headers["transfer-encoding"];
      delete headers["content-encoding"];
      headers["content-type"] = "application/json";
      headers["content-length"] = body.length.toString();

      return { ...response, headers, body };
    } catch {
      return response;
    }
  }

  private async readIncomingBody(res: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of res) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
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
  private cleanMessages(
    messages: unknown,
    provider: "anthropic" | "zai" | "openrouter" | "subscription"
  ): unknown {
    if (!Array.isArray(messages)) return messages;

    let removedThinkingBlocks = 0;
    const shouldStripMessageThinking = provider === "subscription";

    const cleanedMessages = messages
      .map((message) => {
        if (!message || typeof message !== "object" || Array.isArray(message)) return message;

        const cleanedMessage = { ...(message as Record<string, unknown>) };
        const content = cleanedMessage.content;

        if (shouldStripMessageThinking && Array.isArray(content)) {
          const filteredContent = content.filter((block) => {
            if (!block || typeof block !== "object" || Array.isArray(block)) return true;

            const type = (block as Record<string, unknown>).type;
            if (type === "thinking" || type === "redacted_thinking") {
              removedThinkingBlocks++;
              return false;
            }

            return true;
          });

          if (filteredContent.length === 0 && cleanedMessage.role === "assistant") {
            return undefined;
          }

          cleanedMessage.content = filteredContent;
        }

        return cleanedMessage;
      })
      .filter(Boolean);

    if (removedThinkingBlocks > 0) {
      this.logger.debug(`  stripped ${removedThinkingBlocks} historical thinking block(s) for ${provider}`);
    }

    return cleanedMessages;
  }

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

      if (cleaned.messages !== undefined) {
        cleaned.messages = this.cleanMessages(cleaned.messages, provider);
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
    const timeoutMs = provider === "openrouter"
      ? parseInt(process.env.OPENROUTER_TIMEOUT_MS || "60000", 10)
      : undefined;
    const maxRetries = provider === "openrouter"
      ? parseInt(process.env.OPENROUTER_MAX_RETRIES || "0", 10)
      : undefined;
    headers["content-length"] = Buffer.byteLength(body).toString();

    let response = await this.httpRequest(url, {
      method: reqMethod,
      headers,
      body
    }, timeoutMs, maxRetries);

    if (provider === "openrouter" && response.status < 400) {
      response = this.normalizeOpenRouterResponse(response);
    }

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

    // Determine best provider+model (circuit breaker enabled)
    const providerAndModel = cbEnabled ? this.providerHealth.getBestProviderAndModel(model) : null;
    let selectedProvider: 'anthropic' | 'zai' | 'openrouter' | null = providerAndModel?.provider ?? 'anthropic';

    // Default to Anthropic if circuit breaker is disabled or no provider selected
    if (!selectedProvider) {
      this.logger.warn(`No healthy provider available for model ${model || 'unknown'}, trying Anthropic as fallback`);
      selectedProvider = 'anthropic';
    }

    // Check if we should prefer Claude subscription over Z.AI
    // (when Anthropic has no API key but subscription is available)
    if (selectedProvider === 'zai' && this.config.claudeSubscription.enabled) {
      const oauthToken = await this.readClaudeOAuthToken();
      if (oauthToken && !this.config.anthropic.apiKey) {
        this.logger.info(`Claude subscription available - preferring subscription over Z.AI`);
        // Skip provider selection and use subscription directly
        const subResult = await this.trySubscriptionRequest(reqBody, reqHeaders, reqPath, reqMethod);
        if (subResult) {
          this.logger.ok(`[${requestId}] ✓ SUBSCRIPTION ${subResult.status}`);
          await this.trackRequestMetrics(reqMethod, reqPath, startTime, subResult.status, true, 'anthropic', model, false, subResult.body);
          return subResult;
        }
        // If subscription fails, continue with Z.AI as planned
      }
    }

    // Apply model conversion if provider selected a different model
    let effectiveReqBody = reqBody;
    const effectiveModel = providerAndModel?.model ?? model;
    if (providerAndModel?.wasConverted && effectiveModel && effectiveModel !== model) {
      try {
        const parsed = JSON.parse(reqBody);
        parsed.model = effectiveModel;
        effectiveReqBody = JSON.stringify(parsed);
        this.logger.debug(`  model conversion: ${model} → ${effectiveModel} (${selectedProvider})`);
      } catch { /* keep original body */ }
    }

    const primaryProvider = selectedProvider;
    this.logger.info(`[${requestId}] → ${this.formatRequestLog(primaryProvider, effectiveModel ?? model, false, 'sending')}`);
    this.logger.debug(`[${requestId}]   ${this.debugRequestDetails(reqBody)}`);

    try {
      const { response, errorType } = await this.requestProvider(
        primaryProvider,
        effectiveReqBody,
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
    let headersSent = false;

    // Determine best provider based on model
    let selectedProvider = cbEnabled ? this.providerHealth.getBestProviderForModel(model) : 'anthropic';
    if (!selectedProvider) {
      this.logger.warn(`No healthy provider available for model ${model || 'unknown'}, defaulting to Anthropic`);
      selectedProvider = 'anthropic';
    }

    // Check if we should prefer Claude subscription over Z.AI
    // (when Anthropic has no API key but subscription is available)
    if (selectedProvider === 'zai' && this.config.claudeSubscription.enabled) {
      const oauthToken = await this.readClaudeOAuthToken();
      if (oauthToken && !this.config.anthropic.apiKey) {
        this.logger.info(`[${requestId}] → Claude subscription preferred over Z.AI`);
        // Try subscription first
        const cleanedPath = this.cleanPath(reqPath);
        const cleanedBody = this.cleanBody(reqBody, "subscription");

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

        try {
          let subRes = await trySubscriptionStream(oauthToken);

          if (subRes.statusCode === 401) {
            this.logger.warn("← Claude subscription 401 — re-reading credentials and retrying");
            await this.readIncomingBody(subRes);
            const freshToken = await this.readClaudeOAuthToken();
            if (freshToken && freshToken !== oauthToken) {
              subRes = await trySubscriptionStream(freshToken);
            } else {
              this.logger.warn("← Claude subscription 401 — falling back to Z.AI");
              // Continue with Z.AI
            }
          }

          if (subRes.statusCode && subRes.statusCode > 0 && subRes.statusCode < 400) {
            this.logger.ok(`[${requestId}] ← ✅ Claude subscription (stream) ${subRes.statusCode}`);
            if (!clientRes.headersSent) {
              clientRes.writeHead(subRes.statusCode, subRes.headers);
              headersSent = true;
            }

            const streamingChunks: string[] = [];
            const idleTimeoutMs = this.config.timeout?.idleMs || 30000;
            let idleTimer: ReturnType<typeof setTimeout> | null = null;

            const resetIdleTimer = (onIdle: () => void) => {
              if (idleTimer) clearTimeout(idleTimer);
              idleTimer = setTimeout(onIdle, idleTimeoutMs);
            };

            await new Promise<void>((resolveStream, rejectStream) => {
              resetIdleTimer(() => {
                this.logger.warn(`[${requestId}] ← ⏱️  Stream idle for ${idleTimeoutMs}ms — destroying upstream connection`);
                subRes.destroy(new Error(`Stream idle timeout after ${idleTimeoutMs}ms`));
              });

              subRes.on('data', (chunk) => {
                resetIdleTimer(() => {
                  this.logger.warn(`[${requestId}] ← ⏱️  Stream idle for ${idleTimeoutMs}ms — destroying upstream connection`);
                  subRes.destroy(new Error(`Stream idle timeout after ${idleTimeoutMs}ms`));
                });
                try {
                  streamingChunks.push(chunk.toString());
                  clientRes.write(chunk);
                } catch (writeErr) {
                  this.logger.debug(`Error writing to client: ${writeErr instanceof Error ? writeErr.message : 'Unknown'}`);
                }
              });

              subRes.on('end', async () => {
                if (idleTimer) clearTimeout(idleTimer);
                try {
                  clientRes.end();
                  await this.trackStreamingRequestMetrics(reqMethod, reqPath, startTime, subRes.statusCode || 200, true, 'anthropic', model, streamingChunks);
                  resolveStream();
                } catch (endErr) {
                  this.logger.debug(`Error in subscription end handler: ${endErr instanceof Error ? endErr.message : 'Unknown'}`);
                  resolveStream();
                }
              });

              subRes.on('error', (err) => {
                if (idleTimer) clearTimeout(idleTimer);
                rejectStream(err);
              });
            });

            this.logger.ok(`[${requestId}] ← ✅ Stream completed via subscription`);
            return; // Successfully used subscription, exit
          }
        } catch (err) {
          this.logger.warn(`← Claude subscription stream failed: ${err instanceof Error ? err.message : 'Unknown'} — falling back to Z.AI`);
          // Continue with Z.AI
        }
      }
    }

    const primaryProvider = selectedProvider;
    const streamingChunks: string[] = [];

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
      this.logger.debug(`[${requestId}]   ${this.debugRequestDetails(reqBody)}`);

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

          this.logger.warn(
            `[${requestId}] ← ⚠️  ${provider.toUpperCase()} ${statusCode}: ${errorBody
              .toString()
              .slice(0, 300)} — trying fallback`
          );

          return { success: false, statusCode, errorType };
        }

        // Success - pipe response to client
        this.logger.ok(`[${requestId}] ← ✅ ${statusCode} | streaming`);
        if (!clientRes.headersSent) {
          clientRes.writeHead(statusCode, res.headers);
          headersSent = true;
        }

        const idleTimeoutMs = this.config.timeout?.idleMs || 30000; // 30s per-chunk idle default
        let idleTimer: ReturnType<typeof setTimeout> | null = null;

        const resetIdleTimer = (onIdle: () => void) => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(onIdle, idleTimeoutMs);
        };

        await new Promise<void>((resolveStream, rejectStream) => {
          resetIdleTimer(() => {
            this.logger.warn(`[${requestId}] ← ⏱️  Stream idle for ${idleTimeoutMs}ms — destroying upstream connection`);
            res.destroy(new Error(`Stream idle timeout after ${idleTimeoutMs}ms`));
          });

          res.on('data', (chunk) => {
            resetIdleTimer(() => {
              this.logger.warn(`[${requestId}] ← ⏱️  Stream idle for ${idleTimeoutMs}ms — destroying upstream connection`);
              res.destroy(new Error(`Stream idle timeout after ${idleTimeoutMs}ms`));
            });
            try {
              streamingChunks.push(chunk.toString());
              clientRes.write(chunk);
            } catch (writeErr) {
              this.logger.debug(`Error writing to client: ${writeErr instanceof Error ? writeErr.message : 'Unknown'}`);
            }
          });

          res.on('end', async () => {
            if (idleTimer) clearTimeout(idleTimer);
            try {
              clientRes.end();
              const latency = Date.now() - startTime;
              if (cbEnabled) {
                this.providerHealth.recordSuccess(provider, latency);
                const tokenUsage = UsageTracker.extractStreamingTokenUsage(streamingChunks);
                if (tokenUsage) {
                  this.providerHealth.recordTokenUsage(provider, tokenUsage.input_tokens, tokenUsage.output_tokens);
                }
              }
              await this.trackStreamingRequestMetrics(reqMethod, reqPath, startTime, statusCode, false, provider, model, streamingChunks);
              resolveStream();
            } catch (endErr) {
              this.logger.debug(`Error in stream end handler: ${endErr instanceof Error ? endErr.message : 'Unknown'}`);
              resolveStream();
            }
          });

          res.on('error', (err) => {
            if (idleTimer) clearTimeout(idleTimer);
            rejectStream(err);
          });
        });

        this.logger.ok(`[${requestId}] ← ✅ Stream completed`);
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
    const cleanedBody = this.cleanBody(reqBody, "subscription");

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
          let subRes: IncomingMessage | undefined = await trySubscriptionStream(oauthToken);

          if (subRes.statusCode === 401) {
            this.logger.warn("← Claude subscription 401 — re-reading credentials and retrying");
            await this.readIncomingBody(subRes);
            const freshToken = await this.readClaudeOAuthToken();
            if (freshToken && freshToken !== oauthToken) subRes = await trySubscriptionStream(freshToken);
            else {
              this.logger.error("← Claude subscription ❌ 401 — trying other provider");
              subRes = undefined;
            }
          }

          if (subRes) {
            const subStatus = subRes.statusCode || 0;
            if (subStatus > 0 && subStatus < 400) {
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
                  await this.trackStreamingRequestMetrics(reqMethod, reqPath, startTime, subStatus, true, 'anthropic', model, streamingChunks);
                } catch (endErr) {
                  this.logger.debug(`Error in subscription end handler: ${endErr instanceof Error ? endErr.message : 'Unknown'}`);
                }
              });
              return;
            }

            const subErrorBody = await this.readIncomingBody(subRes);
            const subMessage = `← Claude subscription ❌ ${subStatus}: ${subErrorBody
              .toString()
              .slice(0, 300)} — trying other provider`;
            if (this.config.fallbackOnCodes.includes(subStatus)) {
              this.logger.warn(subMessage);
            } else {
              this.logger.error(subMessage);
            }
          }
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

    const trackedId = await this.usageTracker.trackRequest(method, path, metrics);
    if (trackedId !== null) {
      this.logger.debug(`tracked: id=${trackedId} provider=${provider} status=${statusCode} duration=${duration}ms`);
    } else {
      this.logger.warn(`tracking write returned null — DB unreachable or insert failed (provider=${provider} status=${statusCode})`);
    }
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

    const trackedId = await this.usageTracker.trackRequest(method, path, metrics);
    if (trackedId !== null) {
      this.logger.debug(`tracked: id=${trackedId} provider=${provider} status=${statusCode} duration=${duration}ms`);
    } else {
      this.logger.warn(`tracking write returned null — DB unreachable or insert failed (provider=${provider} status=${statusCode})`);
    }
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
        version: PROXY_VERSION,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        endpoints: {
          health: "/health",
          config: "/config",
          providers: "/providers",
          usage: "/usage",
          proxy: "/v1/messages",
          logs: "/logs",
          logsStream: "/logs/stream",
          logsUi: "/logs/ui"
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
          idleMs: this.config.timeout?.idleMs,
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

    // Logs endpoints
    const reqPathname = (() => { try { return new URL(reqPath, "http://localhost").pathname; } catch { return reqPath.split("?")[0]; } })();
    if (reqPathname.startsWith("/logs") && reqMethod === "GET") {
      await this.handleLogsRequest(reqPath, reqPathname, clientRes);
      return;
    }

    // Reject non-API paths (e.g. browser favicon/asset requests) before hitting provider chain
    if (!reqPathname.startsWith("/v1/") && !reqPathname.startsWith("/api/")) {
      clientRes.writeHead(404, { "Content-Type": "application/json" });
      clientRes.end(JSON.stringify({ error: "Not found" }));
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
   * Handle log streaming and history requests
   */
  private async handleLogsRequest(reqPath: string, pathname: string, clientRes: ServerResponse): Promise<void> {
    if (pathname === "/logs/stream") {
      clientRes.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "X-Accel-Buffering": "no",
      });
      // Disable Nagle's algorithm so each SSE event is sent immediately
      clientRes.socket?.setNoDelay(true);
      // Flush response headers to the client right away
      clientRes.flushHeaders();

      // Replay last 100 entries so the client has immediate context
      for (const entry of this.logger.getRecentLogs(100)) {
        clientRes.write(`data: ${JSON.stringify(entry)}\n\n`);
      }

      const ping = setInterval(() => {
        try { clientRes.write(":ping\n\n"); } catch { clearInterval(ping); }
      }, 25000);

      const unsubscribe = this.logger.subscribe(clientRes);
      clientRes.on("close", () => { clearInterval(ping); unsubscribe(); });
      return;
    }

    if (pathname === "/logs/ui") {
      clientRes.writeHead(200, { "Content-Type": "text/html" });
      clientRes.end(this.renderLogsUI());
      return;
    }

    // GET /logs[?limit=N] — JSON snapshot
    const url = new URL(reqPath, `http://localhost`);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10), 500);
    const logs = this.logger.getRecentLogs(limit);
    clientRes.writeHead(200, { "Content-Type": "application/json" });
    clientRes.end(JSON.stringify({ logs, count: logs.length, generated_at: new Date().toISOString() }));
  }

  private renderLogsUI(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Claude Proxy — Logs</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:'Cascadia Code','Fira Mono',monospace;font-size:13px;display:flex;flex-direction:column;height:100vh;overflow:hidden}
header{padding:10px 16px;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:12px;flex-shrink:0}
h1{font-size:14px;color:#58a6ff;font-weight:600}
#status{font-size:11px;padding:2px 8px;border-radius:10px;background:#161b22;border:1px solid #30363d}
#status.live{border-color:#3fb950;color:#3fb950}
#status.err{border-color:#f85149;color:#f85149}
#controls{margin-left:auto;display:flex;gap:8px;align-items:center}
#search{background:#161b22;border:1px solid #30363d;color:#e6edf3;padding:4px 8px;border-radius:4px;font-size:12px;font-family:inherit;width:200px}
#clear-btn{background:transparent;border:1px solid #30363d;color:#8b949e;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:12px}
#clear-btn:hover{border-color:#58a6ff;color:#58a6ff}
#log-wrap{flex:1;overflow-y:auto;padding:8px 0}
.entry{padding:2px 16px;line-height:1.5;white-space:pre-wrap;word-break:break-all;display:flex;gap:10px}
.entry:hover{background:#161b22}
.ts{color:#484f58;flex-shrink:0;user-select:none}
.lvl{flex-shrink:0;width:36px;text-align:right;font-weight:600}
.msg{}
.info .lvl{color:#58a6ff}
.ok   .lvl{color:#3fb950}
.warn .lvl{color:#d29922}
.error .lvl{color:#f85149}
.debug .lvl{color:#484f58}
.hidden{display:none}
</style>
</head>
<body>
<header>
  <h1>Claude Code Proxy — Live Logs</h1>
  <span id="status">Connecting...</span>
  <div id="controls">
    <input id="search" type="text" placeholder="Filter logs..." />
    <button id="clear-btn">Clear</button>
  </div>
</header>
<div id="log-wrap"><div id="log"></div></div>
<script>
const log = document.getElementById('log');
const wrap = document.getElementById('log-wrap');
const statusEl = document.getElementById('status');
const searchEl = document.getElementById('search');
const clearBtn = document.getElementById('clear-btn');
const MAX = 1000;
let filter = '';
let autoScroll = true;

function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

function addEntry(e, prepend=false) {
  const div = document.createElement('div');
  div.className = 'entry ' + e.level;
  div.dataset.msg = e.message.toLowerCase();
  if (filter && !div.dataset.msg.includes(filter)) div.classList.add('hidden');
  div.innerHTML =
    '<span class="ts">' + esc(e.timestamp.slice(11,23)) + '</span>' +
    '<span class="lvl">' + esc(e.level) + '</span>' +
    '<span class="msg">' + esc(e.message) + '</span>';
  if (prepend) {
    log.insertBefore(div, log.firstChild);
  } else {
    log.appendChild(div);
    while (log.children.length > MAX) log.removeChild(log.firstChild);
    if (autoScroll) wrap.scrollTop = wrap.scrollHeight;
  }
}

wrap.addEventListener('scroll', () => {
  autoScroll = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 20;
});

searchEl.addEventListener('input', () => {
  filter = searchEl.value.toLowerCase();
  for (const el of log.children) {
    el.classList.toggle('hidden', filter && !el.dataset.msg.includes(filter));
  }
});

clearBtn.addEventListener('click', () => { log.innerHTML = ''; });

const es = new EventSource('/logs/stream');
es.onopen = () => {
  statusEl.textContent = 'Live';
  statusEl.className = 'live';
};
es.onmessage = e => {
  try { addEntry(JSON.parse(e.data)); } catch {}
};
es.onerror = () => {
  statusEl.textContent = 'Disconnected';
  statusEl.className = 'err';
};
</script>
</body>
</html>`;
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
    console.log(`  ├─ Version: ${PROXY_VERSION}`);
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
    console.log(`  ├─ Logs UI:    \x1b[36mGET  http://127.0.0.1:${port}/logs/ui\x1b[0m`);
    console.log(`  ├─ Logs JSON:  \x1b[36mGET  http://127.0.0.1:${port}/logs\x1b[0m`);
    console.log(`  ├─ Logs SSE:   \x1b[36mGET  http://127.0.0.1:${port}/logs/stream\x1b[0m`);
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

    this.logger.info(`Logger initialized at level=${this.config.logLevel}`);
    this.logger.info(`Usage tracking enabled=${this.usageTracker.isTrackingEnabled()}`);

    // Initialize database if tracking is enabled
    if (this.usageTracker.isTrackingEnabled()) {
      try {
        await this.usageTracker.initialize();
        this.logger.ok("Database tracking initialized");
      } catch {
        this.logger.error("Failed to initialize database tracking");
        this.logger.error("Continuing without database tracking...");
      }
    } else {
      this.logger.warn("Usage tracking disabled — DATABASE_URL not set, /usage will return empty");
    }

    this.server.listen(port, "0.0.0.0", () => {
      this.printStartupBanner(port);
      this.logger.ok(`Server listening on 0.0.0.0:${port} (level=${this.config.logLevel})`);
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
  // Force unbuffered stdout/stderr so Docker log drivers receive output immediately
  (process.stdout as NodeJS.WriteStream & { _handle?: { setBlocking(b: boolean): void } })._handle?.setBlocking(true);
  (process.stderr as NodeJS.WriteStream & { _handle?: { setBlocking(b: boolean): void } })._handle?.setBlocking(true);

  const proxy = new ClaudeCodeProxy();
  proxy.start().catch(error => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
}
