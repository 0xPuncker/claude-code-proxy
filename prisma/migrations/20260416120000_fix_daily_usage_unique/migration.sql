-- Migration: 20260416120000_fix_daily_usage_unique
-- Description: Fix unique constraint on daily_usage table for ON CONFLICT operations

-- Drop the existing daily_usage table if it exists (to avoid conflicts)
DROP TABLE IF EXISTS "daily_usage" CASCADE;

-- Recreate daily_usage table with properly named unique constraint
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
    CONSTRAINT "daily_usage_date_model_provider_key" UNIQUE("date", "model", "provider")
);

-- Recreate indexes
CREATE INDEX "idx_daily_usage_date" ON "daily_usage"("date" DESC);
CREATE INDEX "idx_daily_usage_model" ON "daily_usage"("model", "provider");

-- Recreate usage_summary view
DROP VIEW IF EXISTS "usage_summary";

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
