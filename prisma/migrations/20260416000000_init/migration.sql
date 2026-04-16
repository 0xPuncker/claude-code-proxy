-- Migration: 20260416000000_init
-- Description: Initial schema for Claude Code Proxy usage tracking

-- Create requests table
CREATE TABLE "requests" (
    "id" SERIAL PRIMARY KEY,
    "timestamp" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "method" VARCHAR(10) NOT NULL,
    "path" VARCHAR(255) NOT NULL,
    "model" VARCHAR(100),
    "provider" VARCHAR(50) NOT NULL,
    "status_code" INTEGER NOT NULL,
    "duration_ms" INTEGER,
    "streaming" BOOLEAN NOT NULL DEFAULT FALSE,
    "fallback" BOOLEAN NOT NULL DEFAULT FALSE,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create token_usage table
CREATE TABLE "token_usage" (
    "id" SERIAL PRIMARY KEY,
    "request_id" INTEGER NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cache_creation_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "token_usage_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "requests"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Create daily_usage table
CREATE TABLE "daily_usage" (
    "id" SERIAL PRIMARY KEY,
    "date" DATE NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "total_requests" INTEGER NOT NULL DEFAULT 0,
    "total_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_output_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_cache_creation_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_duration_ms" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE("date", "model", "provider")
);

-- Create indexes
CREATE INDEX "idx_requests_timestamp" ON "requests"("timestamp" DESC);
CREATE INDEX "idx_requests_provider" ON "requests"("provider");
CREATE INDEX "idx_requests_model" ON "requests"("model");
CREATE INDEX "idx_requests_status" ON "requests"("status_code");
CREATE INDEX "idx_token_usage_request_id" ON "token_usage"("request_id");
CREATE INDEX "idx_daily_usage_date" ON "daily_usage"("date" DESC);
CREATE INDEX "idx_daily_usage_model" ON "daily_usage"("model", "provider");

-- Create usage_summary view
CREATE OR REPLACE VIEW "usage_summary" AS
SELECT 
    DATE(r."timestamp") as "date",
    r."provider",
    r."model",
    COUNT(*) as "total_requests",
    SUM(CASE WHEN r."status_code" >= 400 THEN 1 ELSE 0 END) as "error_count",
    AVG(r."duration_ms")::FLOAT as "avg_duration_ms",
    COALESCE(SUM(t."input_tokens"), 0) as "total_input_tokens",
    COALESCE(SUM(t."output_tokens"), 0) as "total_output_tokens",
    COALESCE(SUM(t."cache_read_tokens"), 0) as "total_cache_read_tokens",
    COALESCE(SUM(t."cache_creation_tokens"), 0) as "total_cache_creation_tokens",
    COALESCE(SUM(t."total_tokens"), 0) as "total_tokens"
FROM "requests" r
LEFT JOIN "token_usage" t ON r."id" = t."request_id"
GROUP BY DATE(r."timestamp"), r."provider", r."model"
ORDER BY "date" DESC, r."provider", r."model";
