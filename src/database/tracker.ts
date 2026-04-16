import pg from 'pg';
import type { 
  RequestRecord, 
  TokenUsageRecord, 
  DailyUsageRecord, 
  UsageSummary,
  RequestMetrics,
  AnthropicUsage 
} from '../types.js';

const { Pool } = pg;

export class UsageTracker {
  private pool: pg.Pool;
  private isEnabled: boolean;

  constructor(databaseConfig?: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl: boolean;
    maxConnections: number;
    idleTimeoutMs: number;
    connectionTimeoutMs: number;
  }) {
    if (!databaseConfig) {
      this.isEnabled = false;
      this.pool = new Pool(); // Dummy pool
      return;
    }

    this.isEnabled = true;
    this.pool = new Pool({
      host: databaseConfig.host,
      port: databaseConfig.port,
      database: databaseConfig.database,
      user: databaseConfig.user,
      password: databaseConfig.password,
      ssl: databaseConfig.ssl ? { rejectUnauthorized: false } : undefined,
      max: databaseConfig.maxConnections,
      idleTimeoutMillis: databaseConfig.idleTimeoutMs,
      connectionTimeoutMillis: databaseConfig.connectionTimeoutMs,
    });

    // Handle pool errors
    this.pool.on('error', (err) => {
      console.error('Unexpected database pool error:', err);
    });
  }

  /**
   * Check if tracking is enabled
   */
  isTrackingEnabled(): boolean {
    return this.isEnabled;
  }

  /**
   * Initialize database tables
   */
  async initialize(): Promise<void> {
    if (!this.isEnabled) return;

    try {
      const schema = `
        CREATE TABLE IF NOT EXISTS requests (
          id SERIAL PRIMARY KEY,
          timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          method VARCHAR(10) NOT NULL,
          path VARCHAR(255) NOT NULL,
          model VARCHAR(100),
          provider VARCHAR(50) NOT NULL,
          status_code INTEGER NOT NULL,
          duration_ms INTEGER,
          streaming BOOLEAN DEFAULT FALSE,
          fallback BOOLEAN DEFAULT FALSE,
          error_message TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS token_usage (
          id SERIAL PRIMARY KEY,
          request_id INTEGER REFERENCES requests(id) ON DELETE CASCADE,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          cache_creation_tokens INTEGER DEFAULT 0,
          cache_read_tokens INTEGER DEFAULT 0,
          total_tokens INTEGER NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS daily_usage (
          id SERIAL PRIMARY KEY,
          date DATE NOT NULL UNIQUE,
          model VARCHAR(100) NOT NULL,
          provider VARCHAR(50) NOT NULL,
          total_requests INTEGER DEFAULT 0,
          total_input_tokens INTEGER DEFAULT 0,
          total_output_tokens INTEGER DEFAULT 0,
          total_cache_read_tokens INTEGER DEFAULT 0,
          total_cache_creation_tokens INTEGER DEFAULT 0,
          total_tokens INTEGER DEFAULT 0,
          total_duration_ms BIGINT DEFAULT 0,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp);
        CREATE INDEX IF NOT EXISTS idx_requests_provider ON requests(provider);
        CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model);
        CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status_code);
        CREATE INDEX IF NOT EXISTS idx_token_usage_request_id ON token_usage(request_id);
        CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON daily_usage(date);
        CREATE INDEX IF NOT EXISTS idx_daily_usage_model ON daily_usage(model, provider);
      `;

      await this.pool.query(schema);
      console.log('✅ Database tables initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize database tables:', error);
      throw error;
    }
  }

  /**
   * Track a request with its metrics
   */
  async trackRequest(
    method: string,
    path: string,
    metrics: RequestMetrics
  ): Promise<number | null> {
    if (!this.isEnabled) return null;

    try {
      const requestRecord: RequestRecord = {
        timestamp: new Date(metrics.startTime),
        method,
        path,
        model: metrics.model || null,
        provider: metrics.provider,
        status_code: metrics.statusCode,
        duration_ms: metrics.duration,
        streaming: metrics.streaming,
        fallback: metrics.fallback,
        error_message: metrics.errorMessage || null,
      };

      const result = await this.pool.query(
        `INSERT INTO requests (timestamp, method, path, model, provider, status_code, duration_ms, streaming, fallback, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          requestRecord.timestamp,
          requestRecord.method,
          requestRecord.path,
          requestRecord.model,
          requestRecord.provider,
          requestRecord.status_code,
          requestRecord.duration_ms,
          requestRecord.streaming,
          requestRecord.fallback,
          requestRecord.error_message,
        ]
      );

      const requestId = result.rows[0].id;

      // Track token usage if available
      if (metrics.tokenUsage) {
        await this.trackTokenUsage(requestId, metrics.tokenUsage);
      }

      // Update daily usage asynchronously
      this.updateDailyUsage(requestRecord, metrics.tokenUsage).catch(err => {
        console.error('Failed to update daily usage:', err);
      });

      return requestId;
    } catch (error) {
      console.error('Failed to track request:', error);
      return null;
    }
  }

  /**
   * Track token usage for a request
   */
  async trackTokenUsage(requestId: number, usage: AnthropicUsage): Promise<void> {
    if (!this.isEnabled) return;

    try {
      const cacheCreationTokens = usage.cache_creation_tokens || 0;
      const cacheReadTokens = usage.cache_read_tokens || 0;
      const totalTokens = usage.input_tokens + usage.output_tokens + cacheCreationTokens + cacheReadTokens;

      const tokenRecord: TokenUsageRecord = {
        request_id: requestId,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_tokens: cacheCreationTokens,
        cache_read_tokens: cacheReadTokens,
        total_tokens: totalTokens,
      };

      await this.pool.query(
        `INSERT INTO token_usage (request_id, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          tokenRecord.request_id,
          tokenRecord.input_tokens,
          tokenRecord.output_tokens,
          tokenRecord.cache_creation_tokens,
          tokenRecord.cache_read_tokens,
          tokenRecord.total_tokens,
        ]
      );
    } catch (error) {
      console.error('Failed to track token usage:', error);
    }
  }

  /**
   * Update daily usage aggregation
   */
  private async updateDailyUsage(
    request: RequestRecord,
    tokenUsage?: AnthropicUsage
  ): Promise<void> {
    if (!this.isEnabled) return;

    try {
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
      const model = request.model || 'unknown';
      const inputTokens = tokenUsage?.input_tokens || 0;
      const outputTokens = tokenUsage?.output_tokens || 0;
      const cacheReadTokens = tokenUsage?.cache_read_tokens || 0;
      const cacheCreationTokens = tokenUsage?.cache_creation_tokens || 0;
      const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

      await this.pool.query(
        `INSERT INTO daily_usage (date, model, provider, total_requests, total_input_tokens, total_output_tokens, 
                                  total_cache_read_tokens, total_cache_creation_tokens, total_tokens, total_duration_ms)
         VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (date, model, provider) 
         DO UPDATE SET 
           total_requests = daily_usage.total_requests + 1,
           total_input_tokens = daily_usage.total_input_tokens + $4,
           total_output_tokens = daily_usage.total_output_tokens + $5,
           total_cache_read_tokens = daily_usage.total_cache_read_tokens + $6,
           total_cache_creation_tokens = daily_usage.total_cache_creation_tokens + $7,
           total_tokens = daily_usage.total_tokens + $8,
           total_duration_ms = daily_usage.total_duration_ms + $9,
           updated_at = NOW()`,
        [
          today,
          model,
          request.provider,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          totalTokens,
          request.duration_ms || 0,
        ]
      );
    } catch (error) {
      console.error('Failed to update daily usage:', error);
    }
  }

  /**
   * Get usage summary for a date range
   */
  async getUsageSummary(startDate: Date, endDate: Date): Promise<UsageSummary[]> {
    if (!this.isEnabled) return [];

    try {
      const result = await this.pool.query(
        `SELECT 
          DATE(r.timestamp) as date,
          r.provider,
          r.model,
          COUNT(*) as total_requests,
          SUM(CASE WHEN r.status_code >= 400 THEN 1 ELSE 0 END) as error_count,
          AVG(r.duration_ms) as avg_duration_ms,
          COALESCE(SUM(t.input_tokens), 0) as total_input_tokens,
          COALESCE(SUM(t.output_tokens), 0) as total_output_tokens,
          COALESCE(SUM(t.cache_read_tokens), 0) as total_cache_read_tokens,
          COALESCE(SUM(t.cache_creation_tokens), 0) as total_cache_creation_tokens,
          COALESCE(SUM(t.total_tokens), 0) as total_tokens
        FROM requests r
        LEFT JOIN token_usage t ON r.id = t.request_id
        WHERE DATE(r.timestamp) BETWEEN $1 AND $2
        GROUP BY DATE(r.timestamp), r.provider, r.model
        ORDER BY date DESC, provider, model`,
        [startDate.toISOString().split('T')[0], endDate.toISOString().split('T')[0]]
      );

      return result.rows;
    } catch (error) {
      console.error('Failed to get usage summary:', error);
      return [];
    }
  }

  /**
   * Get recent requests with pagination
   */
  async getRecentRequests(limit: number = 100, offset: number = 0): Promise<RequestRecord[]> {
    if (!this.isEnabled) return [];

    try {
      const result = await this.pool.query(
        `SELECT * FROM requests 
         ORDER BY timestamp DESC 
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      return result.rows;
    } catch (error) {
      console.error('Failed to get recent requests:', error);
      return [];
    }
  }

  /**
   * Get daily usage statistics
   */
  async getDailyUsage(days: number = 30): Promise<DailyUsageRecord[]> {
    if (!this.isEnabled) return [];

    try {
      const result = await this.pool.query(
        `SELECT * FROM daily_usage 
         WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $1
         ORDER BY date DESC, model, provider`,
        [days]
      );

      return result.rows;
    } catch (error) {
      console.error('Failed to get daily usage:', error);
      return [];
    }
  }

  /**
   * Close database connection pool
   */
  async close(): Promise<void> {
    if (!this.isEnabled) return;

    try {
      await this.pool.end();
      console.log('Database connection pool closed');
    } catch (error) {
      console.error('Error closing database pool:', error);
    }
  }

  /**
   * Extract token usage from Anthropic API response
   */
  static extractTokenUsage(responseBody: string): AnthropicUsage | null {
    try {
      const response = JSON.parse(responseBody);
      
      if (response.usage) {
        return {
          input_tokens: response.usage.input_tokens || 0,
          output_tokens: response.usage.output_tokens || 0,
          cache_creation_tokens: response.usage.cache_creation_tokens,
          cache_read_tokens: response.usage.cache_read_tokens,
        };
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Extract token usage from streaming response
   */
  static extractStreamingTokenUsage(chunks: string[]): AnthropicUsage | null {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;

    for (const chunk of chunks) {
      try {
        // Parse SSE data lines
        const lines = chunk.split('\n').filter(line => line.startsWith('data: '));
        
        for (const line of lines) {
          const data = line.slice(6); // Remove 'data: ' prefix
          if (data === '[DONE]') continue;

          const parsed = JSON.parse(data);
          
          if (parsed.message?.usage) {
            inputTokens = parsed.message.usage.input_tokens || inputTokens;
            outputTokens = parsed.message.usage.output_tokens || outputTokens;
            cacheCreationTokens = parsed.message.usage.cache_creation_tokens || cacheCreationTokens;
            cacheReadTokens = parsed.message.usage.cache_read_tokens || cacheReadTokens;
          }
        }
      } catch (error) {
        // Skip invalid chunks
        continue;
      }
    }

    if (inputTokens > 0 || outputTokens > 0) {
      return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_tokens: cacheCreationTokens || undefined,
        cache_read_tokens: cacheReadTokens || undefined,
      };
    }

    return null;
  }
}
