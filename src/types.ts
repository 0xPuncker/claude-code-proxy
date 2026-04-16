/**
 * Configuration interface for the proxy server
 */
export interface ProxyConfig {
  port: number;
  zai: {
    baseUrl: string;
    apiKey: string;
  };
  anthropic: {
    baseUrl: string;
    apiKey: string;
  };
  modelFallbackMap: Record<string, string>;
  fallbackOnCodes: number[];
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  database?: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl: boolean;
    maxConnections: number;
    idleTimeoutMs: number;
    connectionTimeoutMs: number;
  };
}

/**
 * HTTP request options
 */
export interface RequestOptions {
  method?: string;
  headers: Record<string, string>;
  body?: Buffer | string;
}

/**
 * HTTP response interface
 */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * Log levels enum
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4
}

/**
 * Database types for usage tracking
 */
export interface RequestRecord {
  id?: number;
  timestamp: Date;
  method: string;
  path: string;
  model: string | null;
  provider: 'zai' | 'anthropic';
  status_code: number;
  duration_ms: number | null;
  streaming: boolean;
  fallback: boolean;
  error_message: string | null;
  created_at?: Date;
}

export interface TokenUsageRecord {
  id?: number;
  request_id: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  created_at?: Date;
}

export interface DailyUsageRecord {
  id?: number;
  date: Date;
  model: string;
  provider: string;
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_tokens: number;
  total_duration_ms: number;
  updated_at?: Date;
}

export interface UsageSummary {
  date: Date;
  provider: string;
  model: string;
  total_requests: number;
  error_count: number;
  avg_duration_ms: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_tokens: number;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
}

export interface RequestMetrics {
  startTime: number;
  endTime: number;
  duration: number;
  provider: 'zai' | 'anthropic';
  fallback: boolean;
  model?: string;
  statusCode: number;
  streaming: boolean;
  success: boolean;
  errorMessage?: string;
  tokenUsage?: AnthropicUsage;
}
