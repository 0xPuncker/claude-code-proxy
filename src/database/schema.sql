-- Create usage tracking tables
CREATE TABLE IF NOT EXISTS requests (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    method VARCHAR(10) NOT NULL,
    path VARCHAR(255) NOT NULL,
    model VARCHAR(100),
    provider VARCHAR(50) NOT NULL, -- 'zai' or 'anthropic'
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

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp);
CREATE INDEX IF NOT EXISTS idx_requests_provider ON requests(provider);
CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status_code);
CREATE INDEX IF NOT EXISTS idx_token_usage_request_id ON token_usage(request_id);
CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON daily_usage(date);
CREATE INDEX IF NOT EXISTS idx_daily_usage_model ON daily_usage(model, provider);

-- Create view for aggregated usage statistics
CREATE OR REPLACE VIEW usage_summary AS
SELECT 
    DATE(r.timestamp) as date,
    r.provider,
    r.model,
    COUNT(*) as total_requests,
    SUM(CASE WHEN r.status_code >= 400 THEN 1 ELSE 0 END) as error_count,
    AVG(r.duration_ms) as avg_duration_ms,
    SUM(t.input_tokens) as total_input_tokens,
    SUM(t.output_tokens) as total_output_tokens,
    SUM(t.cache_read_tokens) as total_cache_read_tokens,
    SUM(t.cache_creation_tokens) as total_cache_creation_tokens,
    SUM(t.total_tokens) as total_tokens
FROM requests r
LEFT JOIN token_usage t ON r.id = t.request_id
GROUP BY DATE(r.timestamp), r.provider, r.model
ORDER BY date DESC, provider, model;
