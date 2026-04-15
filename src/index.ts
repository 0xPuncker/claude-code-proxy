#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ProxyConfig, RequestOptions, HttpResponse, LogLevel } from "./types.js";

/**
 * Default configuration for the proxy server
 */
const DEFAULT_CONFIG: ProxyConfig = {
  port: parseInt(process.env.PROXY_PORT || "4181", 10),
  zai: {
    baseUrl: "https://api.z.ai/api/anthropic",
    apiKey: process.env.ZAI_API_KEY || "",
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    apiKey: process.env.ANTHROPIC_API_KEY || "",
  },
  modelFallbackMap: {
    "glm-5": "claude-sonnet-4-20250514",
    "glm-4.7": "claude-sonnet-4-20250514",
    "glm-4.6": "claude-sonnet-4-20250514",
    "glm-4.5": "claude-sonnet-4-20250514",
    "glm-4.5-air": "claude-haiku-4-5-20251001",
    "claude-sonnet-4-6": "claude-sonnet-4-20250514",
    "claude-opus-4-6": "claude-sonnet-4-20250514",
    "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  },
  fallbackOnCodes: [429, 503, 502],
  logLevel: "info",
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

  constructor(config: Partial<ProxyConfig> = {}) {
    this.config = this.mergeConfig(config);
    this.logger = new Logger(this.config.logLevel);
    this.server = this.createServer();
  }

  private mergeConfig(config: Partial<ProxyConfig>): ProxyConfig {
    return {
      ...DEFAULT_CONFIG,
      ...config,
      zai: { ...DEFAULT_CONFIG.zai, ...config.zai },
      anthropic: { ...DEFAULT_CONFIG.anthropic, ...config.anthropic },
      modelFallbackMap: { ...DEFAULT_CONFIG.modelFallbackMap, ...config.modelFallbackMap },
    };
  }

  private createServer(): http.Server {
    return http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", async () => {
        try {
          await this.handleRequest(Buffer.concat(chunks).toString(), { ...req.headers }, req.url || "", req.method || "GET", res);
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
   * Proxy request to Z.AI with fallback to Anthropic
   */
  private async proxyRequest(
    reqBody: string,
    reqHeaders: Record<string, string>,
    reqPath: string,
    reqMethod: string
  ): Promise<HttpResponse> {
    // Try Z.AI first
    const zaiUrl = `${this.config.zai.baseUrl}${reqPath}`;
    const zaiHeaders = {
      ...reqHeaders,
      host: new URL(this.config.zai.baseUrl).host,
      authorization: `Bearer ${this.config.zai.apiKey}`,
    };
    delete zaiHeaders["transfer-encoding"];
    delete zaiHeaders["connection"];

    this.logger.info(`→ Z.AI ${reqMethod} ${reqPath}`);

    try {
      const zaiRes = await this.httpRequest(zaiUrl, {
        method: reqMethod,
        headers: zaiHeaders,
        body: reqBody,
      });

      if (!this.config.fallbackOnCodes.includes(zaiRes.status)) {
        this.logger.ok(`← Z.AI ${zaiRes.status}`);
        return zaiRes;
      }

      this.logger.warn(`← Z.AI ${zaiRes.status} — fallback to Anthropic`);
      try {
        this.logger.debug(`  ${zaiRes.body.toString().slice(0, 200)}`);
      } catch {
        // Ignore debug logging errors
      }
    } catch (err) {
      this.logger.error(`← Z.AI error: ${err instanceof Error ? err.message : "Unknown"} — fallback`);
    }

    // Fallback to Anthropic
    const cleanedPath = this.cleanPath(reqPath);
    const cleanedBody = this.cleanBody(reqBody);
    const cleanedHeaders = this.cleanHeaders(reqHeaders);
    cleanedHeaders["content-length"] = Buffer.byteLength(cleanedBody).toString();

    this.logger.info(`→ Anthropic ${reqMethod} ${cleanedPath}`);

    const res = await this.httpRequest(
      `${this.config.anthropic.baseUrl}${cleanedPath}`,
      { method: reqMethod, headers: cleanedHeaders, body: cleanedBody }
    );

    if (res.status >= 400) {
      this.logger.error(`← Anthropic ${res.status}: ${res.body.toString().slice(0, 300)}`);
    } else {
      this.logger.ok(`← Anthropic ${res.status}`);
    }

    return res;
  }

  /**
   * Handle streaming requests
   */
  private async handleStreamingRequest(
    reqBody: string,
    reqHeaders: Record<string, string>,
    reqPath: string,
    reqMethod: string,
    clientRes: ServerResponse
  ): Promise<void> {
    // Try Z.AI first
    const zaiUrl = `${this.config.zai.baseUrl}${reqPath}`;
    const zaiHeaders = {
      ...reqHeaders,
      host: new URL(this.config.zai.baseUrl).host,
      authorization: `Bearer ${this.config.zai.apiKey}`,
    };
    delete zaiHeaders["transfer-encoding"];
    delete zaiHeaders["connection"];

    this.logger.info(`→ Z.AI (stream) ${reqMethod} ${reqPath}`);

    try {
      const zaiRes = await new Promise<IncomingMessage>((resolve, reject) => {
        const url = new URL(zaiUrl);
        const mod = url.protocol === "https:" ? https : http;
        const req = mod.request(url, { method: reqMethod, headers: zaiHeaders }, resolve);
        req.on("error", reject);
        if (reqBody) req.write(reqBody);
        req.end();
      });

      if (!this.config.fallbackOnCodes.includes(zaiRes.statusCode!)) {
        this.logger.ok(`← Z.AI (stream) ${zaiRes.statusCode}`);
        clientRes.writeHead(zaiRes.statusCode!, zaiRes.headers);
        zaiRes.pipe(clientRes);
        return;
      }

      zaiRes.resume();
      this.logger.warn(`← Z.AI ${zaiRes.statusCode} — stream fallback to Anthropic`);
    } catch (err) {
      this.logger.error(`← Z.AI stream error: ${err instanceof Error ? err.message : "Unknown"}`);
    }

    // Fallback to Anthropic
    const cleanedPath = this.cleanPath(reqPath);
    const cleanedBody = this.cleanBody(reqBody);
    const cleanedHeaders = this.cleanHeaders(reqHeaders);
    cleanedHeaders["content-length"] = Buffer.byteLength(cleanedBody).toString();

    this.logger.info(`→ Anthropic (stream) ${reqMethod} ${cleanedPath}`);

    const aRes = await new Promise<IncomingMessage>((resolve, reject) => {
      const url = new URL(`${this.config.anthropic.baseUrl}${cleanedPath}`);
      const mod = url.protocol === "https:" ? https : http;
      const req = mod.request(url, { method: reqMethod, headers: cleanedHeaders }, resolve);
      req.on("error", reject);
      if (cleanedBody) req.write(cleanedBody);
      req.end();
    });

    if (aRes.statusCode! >= 400) {
      const chunks: Buffer[] = [];
      aRes.on("data", (c: Buffer) => chunks.push(c));
      aRes.on("end", () => {
        this.logger.error(`← Anthropic (stream) ${aRes.statusCode}: ${Buffer.concat(chunks).toString().slice(0, 300)}`);
        clientRes.writeHead(aRes.statusCode!, aRes.headers);
        clientRes.end(Buffer.concat(chunks));
      });
    } else {
      this.logger.ok(`← Anthropic (stream) ${aRes.statusCode}`);
      clientRes.writeHead(aRes.statusCode!, aRes.headers);
      aRes.pipe(clientRes);
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
   * Start the proxy server
   */
  public start(): void {
    const port = this.config.port;
    this.server.listen(port, () => {
      this.logger.ok(`Claude Code Proxy listening on http://localhost:${port}`);
      this.logger.info(`Primary: Z.AI | Fallback: Anthropic`);
      this.logger.info(`Model mappings: ${Object.keys(this.config.modelFallbackMap).length} models configured`);
    });
  }

  /**
   * Stop the proxy server
   */
  public stop(): void {
    this.server.close(() => {
      this.logger.info("Server stopped");
    });
  }
}

// Start server if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const proxy = new ClaudeCodeProxy();
  proxy.start();
}
