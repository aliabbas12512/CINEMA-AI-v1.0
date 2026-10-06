// Test environment: real Postgres + Redis + FFmpeg, mocked external AI providers.
(process.env as Record<string, string>).NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://studio:studio@127.0.0.1:5432/studio_test";
process.env.REDIS_URL ??= "redis://127.0.0.1:6379/15";
process.env.SESSION_SECRET ??= "test-session-secret-0123456789abcdef0123456789";
process.env.STORAGE_DRIVER = "local";
process.env.STORAGE_LOCAL_DIR ??= "./tmp/test-storage";
process.env.WORK_DIR ??= "./tmp/test-work";
process.env.LOG_LEVEL ??= "warn";
process.env.RETRY_BASE_DELAY_MS ??= "10";
process.env.PROVIDER_POLL_INTERVAL_MS ??= "50";
