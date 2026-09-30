// Must be the first import in main.ts so env is loaded before any module reads it.
try {
  process.loadEnvFile(".env.local");
} catch {
  // no .env.local — rely on the real environment
}
