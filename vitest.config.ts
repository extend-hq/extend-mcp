import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 120_000, // 2 min per test (API calls can be slow)
    hookTimeout: 60_000,
  },
});
