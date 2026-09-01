-- The app authenticates with HTTP Basic against a fixed set of accounts, so
-- the session-based auth tables have no reader. Identity now lives in the
-- BASIC_AUTH_ACCOUNTS secret; `tracked_app.user_id` remains the durable link
-- between a person and their data and is untouched by this migration.
DROP TABLE IF EXISTS "session";
DROP TABLE IF EXISTS "account";
DROP TABLE IF EXISTS "verification";
DROP TABLE IF EXISTS "rateLimit";
DROP TABLE IF EXISTS "user";
