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
