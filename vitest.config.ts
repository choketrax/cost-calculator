import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * Vitest configuration for Cloudflare Workers tests.
 *
 * Runs tests inside the actual Cloudflare Workers runtime via Miniflare,
 * so Durable Objects, SQLite storage, crypto.subtle, and alarms all work natively.
 * The 100-concurrent BudgetDO test proves strong consistency in the real runtime.
 */
export default defineWorkersConfig({
  test: {
    include: ["worker/src/__tests__/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30000,
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml", environment: "test" },
        miniflare: {
          bindings: {
            AI_GATEWAY_ID: "agent-gateway",
          },
        },
      },
    },
  },
});
